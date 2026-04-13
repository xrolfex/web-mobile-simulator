import { randomUUID } from 'node:crypto';
import type {
  Session,
  SessionStatus,
  CreateSessionRequest,
  SimulatorDevice,
  DeviceType,
  Runtime,
  Platform,
} from '@web-mobile-simulator/shared';
import {
  SESSION_TIMEOUT_MS,
  WMS_IOS_DEVICE_NAME_PREFIX,
  WMS_ANDROID_AVD_NAME_PREFIX,
} from '@web-mobile-simulator/shared';
import { config } from '../config.js';
import { iosSimulatorService } from './ios-simulator.js';
import { androidEmulatorService } from './android-emulator.js';
import { screenCaptureService } from './screen-capture.js';
import { eventBusService } from './event-bus.js';
import { initializeDatabase } from '../db/migrate.js';
import { sessionRepository } from '../db/session-repository.js';
import { execJSON } from '../utils/exec.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[SessionManagerService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

/** Return an ISO-8601 timestamp for the current moment. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Extract the first 8 characters of a UUID for use as a short human-readable
 * suffix in device names.
 *
 * @param uuid - Full UUID string.
 * @returns The 8-character prefix before the first hyphen.
 */
function shortId(uuid: string): string {
  return uuid.split('-')[0] ?? uuid.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/**
 * Payload emitted on the `session_status_changed` event bus topic whenever a
 * session transitions between lifecycle states.
 */
export interface SessionStatusChangedPayload {
  /** The session that changed state. */
  sessionId: string;
  /** The new status the session has just entered. */
  status: SessionStatus;
  /** The status the session held immediately before this transition. */
  previousStatus: SessionStatus;
  /** Basic device info, present once the device has been provisioned. */
  device?: {
    platform: Platform;
    deviceType: string;
  };
}

// ---------------------------------------------------------------------------
// Internal tracking type
// ---------------------------------------------------------------------------

/**
 * Extended internal session record that tracks platform-specific identifiers
 * needed for cleanup (UDID for iOS, AVD name for Android).  This augments the
 * public `Session` type without leaking internal details through the API.
 */
interface InternalSession extends Session {
  /** iOS Simulator UDID — present only for `platform === 'ios'` sessions. */
  _iosUdid?: string;
  /** Original WMS device name for the iOS Simulator — used by the warm pool. */
  _iosDeviceName?: string;
  /** Android AVD name — present only for `platform === 'android'` sessions. */
  _androidAvdName?: string;
}

/**
 * An entry in the iOS warm device pool.  The device is booted and
 * Simulator.app is running; it is waiting to be claimed by the next
 * matching `createSession` call.
 */
interface IOSPoolEntry {
  /** UDID of the booted Simulator. */
  udid: string;
  /**
   * The WMS device name (e.g. "wms-session-abcd1234") used when the device
   * was originally created.  Passed to `startCapture` so the Swift capture
   * binary can match the correct Simulator.app window.
   */
  deviceName: string;
  /** Device-type identifier used as the pool key. */
  deviceTypeId: string;
  /** Runtime identifier used as the pool key. */
  runtimeId: string;
}

// ---------------------------------------------------------------------------
// Capacity error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a session creation request is rejected because the server
 * has reached its configured capacity limit.
 */
export class SessionCapacityError extends Error {
  /** Machine-readable error code: 'CAPACITY_GLOBAL' | 'CAPACITY_PLATFORM'. */
  readonly code: string;
  /** Current number of active sessions at the time of rejection. */
  readonly currentCount: number;
  /** The configured maximum that was exceeded. */
  readonly maxCount: number;

  constructor(message: string, code: string, currentCount: number, maxCount: number) {
    super(message);
    this.name = 'SessionCapacityError';
    this.code = code;
    this.currentCount = currentCount;
    this.maxCount = maxCount;
  }
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full lifecycle of a simulator session:
 *   create device → boot → start screen capture → serve stream → shutdown → cleanup.
 *
 * Sessions are stored in an in-memory `Map`.  A periodic timer terminates
 * sessions that exceed `SESSION_TIMEOUT_MS` (30 minutes).
 *
 * Export the singleton `sessionManagerService` rather than constructing
 * instances directly.
 */
export class SessionManagerService {
  /** In-memory session store keyed by session ID. */
  private readonly sessions = new Map<string, InternalSession>();

  /**
   * In-memory warm pool for idle (booted) iOS Simulators, keyed by
   * `"${deviceTypeId}:${runtimeId}"`.  Each value is an ordered list of
   * available pool entries (FIFO claim order).
   */
  private readonly iosPool = new Map<string, IOSPoolEntry[]>();

  /** Handle for the periodic timeout-checker interval. */
  private timeoutCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Handle for the periodic memory-eviction interval. */
  private evictionCheckInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Mutex promise used to serialise concurrent `createSession()` calls so that
   * capacity checks are race-free.  Each new call chains onto the previous one.
   */
  private _creationLock: Promise<void> = Promise.resolve();

  constructor() {
    // Only connect to the database when running in production/development.
    // In test environments the DB is not needed — all tests mock the services
    // or use fresh in-memory instances directly.
    if (process.env['NODE_ENV'] !== 'test') {
      this.initDb();
    }

    // Check for timed-out sessions once per minute.
    this.timeoutCheckInterval = setInterval(
      () => void this.checkTimeouts(),
      60_000,
    );

    // Evict stale sessions from memory every 5 minutes.
    this.evictionCheckInterval = setInterval(
      () => void this.evictStaleMemorySessions(),
      5 * 60_000,
    );
  }

  // -------------------------------------------------------------------------
  // Private — database initialisation
  // -------------------------------------------------------------------------

  /**
   * Initialise the SQLite database and rehydrate any non-terminated sessions
   * into the in-memory map so that crash recovery works across restarts.
   *
   * Sessions that were `'creating'` or `'active'` before the restart have lost
   * their VNC proxies and device state — these are immediately marked as
   * `'error'` and persisted so that clients receive accurate status.
   *
   * Errors are logged but never thrown — a DB failure must not prevent the
   * server from starting.
   */
  private initDb(): void {
    try {
      initializeDatabase();

      // Rehydrate sessions that were not terminated before the last shutdown.
      const survivingSessions = sessionRepository.findAll();
      const rehydrationNow = now();

      for (const stored of survivingSessions) {
        if (stored.status !== 'terminated') {
          const internal = stored as InternalSession;

          // Sessions that were 'creating', 'active', or 'terminating' before
          // the crash have lost their screen capture and device state — mark
          // them as 'error'.
          if (
            internal.status === 'creating' ||
            internal.status === 'active' ||
            internal.status === 'terminating'
          ) {
            const previousStatus = internal.status;
            internal.status = 'error';
            internal.updatedAt = rehydrationNow;
            this.persistSession(internal, 'update');
            log(
              `Rehydrated session ${internal.id} (was ${previousStatus}) — marked as error ` +
              `(screen capture and device state lost after restart)`,
            );
          } else {
            log(`Rehydrated session ${internal.id} (status=${internal.status}) from database`);
          }

          this.sessions.set(internal.id, internal);
        }
      }
    } catch (err: unknown) {
      warn(`Database initialization failed — continuing without persistence: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new simulator session for the requested platform.
   *
   * Concurrent calls are serialised through a promise-based mutex so that
   * capacity checks are race-free.  Each call waits for the previous creation
   * attempt to complete before proceeding.
   *
   * @param request - Platform, runtime, and device-type selection.
   * @returns The fully initialised `Session` record.
   * @throws {SessionCapacityError} If the global or per-platform cap is exceeded.
   * @throws If device creation, boot, or proxy startup fails.
   */
  async createSession(request: CreateSessionRequest): Promise<Session> {
    // Acquire the lock — wait for any in-flight creation to complete.
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this._creationLock;
    this._creationLock = lockPromise;

    await previousLock; // Wait for prior creation to finish.

    try {
      return await this._createSessionImpl(request);
    } finally {
      releaseLock();
    }
  }

  /**
   * Retrieve a session by ID.
   *
   * The in-memory map is checked first (it holds all live/active sessions with
   * their current proxy state).  If not found there, the database is queried
   * so that historical (terminated/error) sessions can still be fetched.
   *
   * @param id - Session identifier.
   * @returns The `Session` record, or `null` if not found.
   */
  getSession(id: string): Session | null {
    const inMemory = this.sessions.get(id);
    if (inMemory !== undefined) return inMemory;

    // Fall back to DB for historical sessions (e.g. terminated).
    try {
      return sessionRepository.findById(id);
    } catch {
      return null;
    }
  }

  /**
   * List all sessions, optionally filtered to a specific status.
   *
   * Results are read from the database so that terminated and historical
   * sessions are included.  For active sessions the in-memory record is
   * preferred because it carries live proxy state not yet flushed to the DB.
   *
   * Falls back to the in-memory map if the database is unavailable.
   *
   * @param status - If provided, only sessions with this status are returned.
   * @returns Array of matching `Session` records (snapshot, not live references).
   */
  listSessions(status?: SessionStatus): Session[] {
    try {
      const dbRows = sessionRepository.findAll(status);

      // Merge with in-memory map: prefer in-memory record for any session that
      // is currently live (it may have fresher proxy/status data).
      return dbRows.map((row) => {
        const live = this.sessions.get(row.id);
        return live !== undefined ? live : row;
      });
    } catch {
      // DB unavailable — fall back to in-memory map only.
      const all = [...this.sessions.values()];
      if (status !== undefined) {
        return all.filter((s) => s.status === status);
      }
      return all;
    }
  }

  /**
   * Terminate an active session and clean up all associated resources.
   *
   * Steps:
   *   1. Mark the session as 'terminating'.
   *   2. Stop the VNC proxy.
   *   3. Shut down and delete the platform device.
   *   4. Mark the session as 'terminated'.
   *
   * @param id - ID of the session to terminate.
   * @throws If the session does not exist.
   */
  async terminateSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    log(`Terminating session ${id}`);

    const previousStatus = session.status;
    session.status = 'terminating';
    session.updatedAt = now();
    this.persistSession(session, 'update');
    this.emitStatusChange(session, previousStatus);

    // Stop screen capture first — safe to call even if no capture was started.
    screenCaptureService.stopCapture(id);

    // For iOS: try to return the device to the warm pool instead of shutting it
    // down.  If the pool is full, disabled, or the session is not iOS, fall back
    // to the normal shutdown+delete path.
    const returnedToPool = this.tryReturnToPool(session);
    if (!returnedToPool) {
      // Shut down and delete the platform device.
      await this.teardownDevice(session).catch((err: unknown) => {
        warn(`Device teardown failed for session ${id}: ${String(err)}`);
      });
    }

    session.status = 'terminated';
    session.updatedAt = now();
    this.persistSession(session, 'update');
    this.emitStatusChange(session, 'terminating');

    log(`Session ${id} terminated.`);
  }

  /**
   * Terminate all active (non-terminated, non-error) sessions.
   * Called during graceful server shutdown (SIGTERM / SIGINT).
   *
   * Uses `Promise.allSettled` so a single failing termination does not prevent
   * others from completing.
   */
  async cleanup(): Promise<void> {
    log('Cleaning up all active sessions…');

    if (this.timeoutCheckInterval !== null) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = null;
    }

    if (this.evictionCheckInterval !== null) {
      clearInterval(this.evictionCheckInterval);
      this.evictionCheckInterval = null;
    }

    const activeIds = [...this.sessions.values()]
      .filter((s) => s.status !== 'terminated' && s.status !== 'error')
      .map((s) => s.id);

    await Promise.allSettled(
      activeIds.map((id) =>
        this.terminateSession(id).catch((err: unknown) => {
          warn(`cleanup: failed to terminate session ${id}: ${String(err)}`);
        }),
      ),
    );

    // Drain the iOS warm pool — sessions terminated above may have been returned
    // to the pool; drain it to ensure nothing is left booted after shutdown.
    await this.drainPool();

    // Stop any remaining screen captures (e.g. captures whose session was
    // not in the active list due to a state mismatch).
    screenCaptureService.cleanup();

    log(`Cleanup complete. Terminated ${activeIds.length} session(s).`);
  }

  /**
   * Return current session capacity information for monitoring and API responses.
   *
   * @returns Snapshot of active session counts vs. configured maximums.
   */
  getCapacityInfo(): {
    activeSessions: number;
    maxConcurrentSessions: number;
    perPlatform: Record<string, { active: number; max: number }>;
  } {
    const active = [...this.sessions.values()].filter(
      (s) => s.status === 'creating' || s.status === 'active',
    );

    const iosActive = active.filter((s) => s.device.platform === 'ios').length;
    const androidActive = active.filter((s) => s.device.platform === 'android').length;

    return {
      activeSessions: active.length,
      maxConcurrentSessions: config.maxConcurrentSessions,
      perPlatform: {
        ios: { active: iosActive, max: config.maxSessionsPerPlatform },
        android: { active: androidActive, max: config.maxSessionsPerPlatform },
      },
    };
  }

  /**
   * Scan the host for iOS Simulators and Android AVDs that match the WMS naming
   * convention but are NOT tracked by any current in-memory session.  These are
   * orphans left behind by a prior crash.
   *
   * This method is safe to call at startup — errors on individual devices are
   * logged but never thrown.
   */
  async cleanupOrphanDevices(): Promise<void> {
    log('Scanning for orphan devices…');
    await Promise.allSettled([
      this.cleanupOrphanIOSDevices(),
      this.cleanupOrphanAndroidAVDs(),
    ]);
    log('Orphan device scan complete.');
  }

  // -------------------------------------------------------------------------
  // Private — session creation implementation
  // -------------------------------------------------------------------------

  /**
   * Internal implementation of session creation — called by the public
   * `createSession()` wrapper which serialises concurrent calls via a mutex.
   *
   * Checks global and per-platform capacity limits before proceeding.  Throws
   * {@link SessionCapacityError} if a limit is exceeded.
   *
   * @param request - Platform, runtime, and device-type selection.
   * @returns The fully initialised `Session` record.
   */
  private async _createSessionImpl(request: CreateSessionRequest): Promise<Session> {
    // --- Capacity checks (race-free because we hold the creation mutex) ---

    const activeSessions = [...this.sessions.values()].filter(
      (s) => s.status === 'creating' || s.status === 'active',
    );

    // Global cap check.
    if (
      config.maxConcurrentSessions > 0 &&
      activeSessions.length >= config.maxConcurrentSessions
    ) {
      throw new SessionCapacityError(
        `Maximum concurrent sessions reached (${config.maxConcurrentSessions}). ` +
          `Terminate an existing session before creating a new one.`,
        'CAPACITY_GLOBAL',
        activeSessions.length,
        config.maxConcurrentSessions,
      );
    }

    // Per-platform cap check.
    if (config.maxSessionsPerPlatform > 0) {
      const platformCount = activeSessions.filter(
        (s) => s.device.platform === request.platform,
      ).length;
      if (platformCount >= config.maxSessionsPerPlatform) {
        throw new SessionCapacityError(
          `Maximum ${request.platform} sessions reached (${config.maxSessionsPerPlatform}). ` +
            `Terminate an existing ${request.platform} session before creating a new one.`,
          'CAPACITY_PLATFORM',
          platformCount,
          config.maxSessionsPerPlatform,
        );
      }
    }

    // --- Session creation ---

    const sessionId = randomUUID();
    const sessionNow = now();

    // Build a minimal placeholder device so the Session shape is always valid.
    // Both platform branches overwrite this immediately.
    const placeholderDevice: SimulatorDevice = {
      id: '',
      platformDeviceId: '',
      platform: request.platform,
      deviceType: {
        id: request.deviceTypeId,
        name: request.deviceTypeId,
        platform: request.platform,
        modelName: request.deviceTypeId,
        modelIdentifier: request.deviceTypeId,
      },
      runtime: {
        id: request.runtimeId,
        platform: request.platform,
        version: request.runtimeId,
        identifier: request.runtimeId,
        status: 'installed',
      },
      state: 'shutdown',
    };

    const session: InternalSession = {
      id: sessionId,
      device: placeholderDevice,
      status: 'creating',
      createdAt: sessionNow,
      updatedAt: sessionNow,
    };

    this.sessions.set(sessionId, session);
    this.persistSession(session, 'create');
    log(`Creating session ${sessionId} (platform=${request.platform})`);
    this.emitStatusChange(session, 'creating');

    try {
      if (request.platform === 'ios') {
        return await this.createIOSSession(session, request);
      } else if (request.platform === 'android') {
        return await this.createAndroidSession(session, request);
      } else {
        // TypeScript narrows Platform to 'ios' | 'android', but guard anyway.
        throw new Error(
          `Unsupported platform: ${String((request as CreateSessionRequest).platform)}`,
        );
      }
    } catch (error: unknown) {
      const previousStatus = session.status;
      session.status = 'error';
      session.updatedAt = now();
      this.sessions.set(sessionId, session);
      this.persistSession(session, 'update');
      this.emitStatusChange(session, previousStatus);

      // Best-effort cleanup — swallow errors so the original error propagates.
      await this.cleanupFailedSession(session).catch((cleanupErr: unknown) => {
        warn(
          `Cleanup after failed session ${sessionId} encountered an error: ` +
            String(cleanupErr),
        );
      });

      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Private — platform-specific session creation
  // -------------------------------------------------------------------------

  /**
   * Execute the iOS-specific session creation sequence.
   *
   * @param session - Mutable in-memory session record to populate.
   * @param request - Original creation request.
   * @returns The fully populated `Session` once the device is active.
   */
  private async createIOSSession(
    session: InternalSession,
    request: CreateSessionRequest,
  ): Promise<Session> {
    const { id: sessionId } = session;

    // --- Attempt to claim a warm device from the pool ---
    const poolEntry = this.tryClaimFromPool(request.deviceTypeId, request.runtimeId);

    if (poolEntry) {
      log(
        `[${sessionId}] Reusing warm pool device ${poolEntry.udid} ` +
        `(${poolEntry.deviceName}) — skipping create/boot/open.`,
      );

      const { udid, deviceName } = poolEntry;
      session._iosUdid = udid;
      session._iosDeviceName = deviceName;

      const deviceType: DeviceType = {
        id: request.deviceTypeId,
        name: request.deviceTypeId,
        platform: 'ios',
        modelName: request.deviceTypeId,
        modelIdentifier: request.deviceTypeId,
      };
      const runtime: Runtime = {
        id: request.runtimeId,
        platform: 'ios',
        version: request.runtimeId,
        identifier: request.runtimeId,
        status: 'installed',
      };
      const device: SimulatorDevice = {
        id: udid,
        platformDeviceId: udid,
        platform: 'ios',
        deviceType,
        runtime,
        state: 'booted',
      };
      session.device = device;

      // Start screen capture (Simulator.app is already running for this device).
      log(`[${sessionId}] Starting screen capture for warm device ${udid}…`);
      screenCaptureService.startCapture(sessionId, 'ios', udid, undefined, deviceName);
      const wsUrl = `/ws/stream/${sessionId}`;

      session.status = 'active';
      session.streamUrl = wsUrl;
      session.updatedAt = now();
      this.persistSession(session, 'update');

      log(`[${sessionId}] iOS session active (warm) — stream: ${wsUrl}`);
      this.emitStatusChange(session, 'creating');
      return session;
    }

    // --- Normal (cold) creation path ---
    const deviceName = `${WMS_IOS_DEVICE_NAME_PREFIX}${shortId(sessionId)}`;
    session._iosDeviceName = deviceName;

    // Step 1 — Create the Simulator device.
    log(`[${sessionId}] Creating iOS Simulator "${deviceName}"…`);
    const udid = await iosSimulatorService.createDevice(
      deviceName,
      request.deviceTypeId,
      request.runtimeId,
    );
    session._iosUdid = udid;

    // Build the device reference from the request identifiers.
    const deviceType: DeviceType = {
      id: request.deviceTypeId,
      name: request.deviceTypeId,
      platform: 'ios',
      modelName: request.deviceTypeId,
      modelIdentifier: request.deviceTypeId,
    };
    const runtime: Runtime = {
      id: request.runtimeId,
      platform: 'ios',
      version: request.runtimeId,
      identifier: request.runtimeId,
      status: 'installed',
    };
    const device: SimulatorDevice = {
      id: udid,
      platformDeviceId: udid,
      platform: 'ios',
      deviceType,
      runtime,
      state: 'shutdown',
    };
    session.device = device;

    // Step 2 — Boot the device.
    log(`[${sessionId}] Booting iOS Simulator ${udid}…`);
    await iosSimulatorService.bootDevice(udid);
    session.device = { ...session.device, state: 'booted' };

    // Step 2b — Launch Simulator.app so input injection (tap, swipe, keyboard)
    // works.  Simulator.app bridges macOS mouse/keyboard events into iOS
    // touch/keyboard events via its internal IndigoHID bridge.
    log(`[${sessionId}] Launching Simulator.app for device ${udid}…`);
    await iosSimulatorService.openSimulatorApp(udid);

    // Step 3 — Start screen capture.
    log(`[${sessionId}] Starting screen capture for iOS Simulator ${udid}…`);
    screenCaptureService.startCapture(sessionId, 'ios', udid, undefined, deviceName);
    const wsUrl = `/ws/stream/${sessionId}`;

    // Step 4 — Finalise and activate the session.
    session.status = 'active';
    session.streamUrl = wsUrl;
    session.updatedAt = now();
    this.persistSession(session, 'update');

    log(`[${sessionId}] iOS session active — stream: ${wsUrl}`);
    this.emitStatusChange(session, 'creating');
    return session;
  }

  /**
   * Execute the Android-specific session creation sequence.
   *
   * @param session - Mutable in-memory session record to populate.
   * @param request - Original creation request.
   * @returns The fully populated `Session` once the device is active.
   */
  private async createAndroidSession(
    session: InternalSession,
    request: CreateSessionRequest,
  ): Promise<Session> {
    const { id: sessionId } = session;
    // AVD names must not contain spaces; use a short safe identifier.
    const avdName = `${WMS_ANDROID_AVD_NAME_PREFIX}${shortId(sessionId)}`;

    // The runtimeId for Android is the system image package path, e.g.:
    //   system-images;android-34;google_apis;arm64-v8a
    // The deviceTypeId is the avdmanager hardware profile identifier, e.g.:
    //   pixel_8  (the `modelIdentifier` field on DeviceType)
    const systemImage = request.runtimeId;
    const deviceId = request.deviceTypeId;

    // Step 1 — Create the AVD.
    log(`[${sessionId}] Creating Android AVD "${avdName}"…`);
    await androidEmulatorService.createAVD(avdName, systemImage, deviceId);
    session._androidAvdName = avdName;

    const deviceType: DeviceType = {
      id: `android-device-${deviceId}`,
      name: deviceId,
      platform: 'android',
      modelName: deviceId,
      modelIdentifier: deviceId,
    };
    const runtime: Runtime = {
      id: `android-runtime-${systemImage.replace(/;/g, '-')}`,
      platform: 'android',
      version: systemImage,
      identifier: systemImage,
      status: 'installed',
    };
    const device: SimulatorDevice = {
      id: `android-avd-${avdName}`,
      platformDeviceId: avdName,
      platform: 'android',
      deviceType,
      runtime,
      state: 'shutdown',
    };
    session.device = device;

    // Step 2 — Boot the emulator.
    log(`[${sessionId}] Booting Android emulator "${avdName}"…`);
    const { adbPort } = await androidEmulatorService.bootEmulator(avdName);
    session.device = { ...session.device, state: 'booted' };
    log(`[${sessionId}] Emulator booted, ADB port: ${adbPort}`);

    // Step 3 — Start screen capture.
    // For Android, the device ID for ADB is the serial like "emulator-5554".
    // The ADB serial is derived from the console port: "emulator-<adbPort>".
    const androidSerial = `emulator-${adbPort}`;
    log(`[${sessionId}] Starting screen capture for Android emulator ${androidSerial}…`);
    screenCaptureService.startCapture(sessionId, 'android', androidSerial);
    const wsUrl = `/ws/stream/${sessionId}`;

    // Step 4 — Finalise and activate the session.
    session.status = 'active';
    session.streamUrl = wsUrl;
    session.updatedAt = now();
    this.persistSession(session, 'update');

    log(`[${sessionId}] Android session active — stream: ${wsUrl}`);
    this.emitStatusChange(session, 'creating');
    return session;
  }

  // -------------------------------------------------------------------------
  // Private — database persistence
  // -------------------------------------------------------------------------

  /**
   * Persist a session to the database using either `create` or `update`.
   *
   * Errors are caught and logged so that a DB failure never interrupts the
   * in-memory session lifecycle.
   *
   * @param session - The session to persist.
   * @param operation - `'create'` for the first insert, `'update'` for subsequent writes.
   */
  private persistSession(
    session: InternalSession,
    operation: 'create' | 'update',
  ): void {
    if (process.env['NODE_ENV'] === 'test') return;

    try {
      if (operation === 'create') {
        sessionRepository.create(session);
      } else {
        sessionRepository.update(session);
      }
    } catch (err: unknown) {
      warn(`Failed to ${operation} session ${session.id} in database: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private — event emission
  // -------------------------------------------------------------------------

  /**
   * Emit a `session_status_changed` event on the shared event bus.
   *
   * Should be called **after** the session's `status` field has been mutated
   * so that `session.status` reflects the new state.
   *
   * @param session        - The session record after its status was updated.
   * @param previousStatus - The status the session held before the transition.
   */
  private emitStatusChange(
    session: InternalSession,
    previousStatus: SessionStatus,
  ): void {
    const payload: SessionStatusChangedPayload = {
      sessionId: session.id,
      status: session.status,
      previousStatus,
      device:
        session.device.id !== ''
          ? {
              platform: session.device.platform,
              deviceType: session.device.deviceType.name,
            }
          : undefined,
    };

    eventBusService.emit('session_status_changed', payload);
  }

  // -------------------------------------------------------------------------
  // Private — iOS warm pool
  // -------------------------------------------------------------------------

  /**
   * Attempt to claim an idle device from the warm pool for the given
   * device-type / runtime combination.  Returns and removes the first
   * available entry (FIFO), or `undefined` if the pool has no match.
   *
   * @param deviceTypeId - Device-type identifier.
   * @param runtimeId    - Runtime identifier.
   */
  private tryClaimFromPool(deviceTypeId: string, runtimeId: string): IOSPoolEntry | undefined {
    const key = `${deviceTypeId}:${runtimeId}`;
    const entries = this.iosPool.get(key);
    if (!entries || entries.length === 0) return undefined;

    const entry = entries.shift()!;
    if (entries.length === 0) {
      this.iosPool.delete(key);
    }
    return entry;
  }

  /**
   * Attempt to return an iOS session's device to the warm pool instead of
   * shutting it down.  Returns `true` if the device was successfully added to
   * the pool, `false` if the pool is full, disabled, or the session is not iOS.
   *
   * The device stays booted; only the screen capture has been stopped before
   * this is called.
   *
   * @param session - The session whose device should be returned to the pool.
   */
  private tryReturnToPool(session: InternalSession): boolean {
    if (
      session.device.platform !== 'ios' ||
      !session._iosUdid ||
      !session._iosDeviceName ||
      config.iosWarmPoolSize <= 0
    ) {
      return false;
    }

    const deviceTypeId = session.device.deviceType.id;
    const runtimeId = session.device.runtime.id;
    const key = `${deviceTypeId}:${runtimeId}`;

    const entries = this.iosPool.get(key) ?? [];
    if (entries.length >= config.iosWarmPoolSize) {
      // Pool is full for this device type — caller must tear down normally.
      return false;
    }

    entries.push({
      udid: session._iosUdid,
      deviceName: session._iosDeviceName,
      deviceTypeId,
      runtimeId,
    });
    this.iosPool.set(key, entries);

    log(
      `[${session.id}] Returned device ${session._iosUdid} (${session._iosDeviceName}) ` +
      `to warm pool — key="${key}", pool size now ${entries.length}.`,
    );
    return true;
  }

  /**
   * Shut down and delete all devices currently held in the warm pool.
   * Called during server shutdown (`cleanup`) to ensure no orphans are left.
   */
  private async drainPool(): Promise<void> {
    let total = 0;
    for (const entries of this.iosPool.values()) {
      total += entries.length;
    }

    if (total === 0) return;

    log(`Draining iOS warm pool (${total} device(s))…`);

    const drainPromises: Promise<void>[] = [];

    for (const entries of this.iosPool.values()) {
      for (const entry of entries) {
        drainPromises.push(
          iosSimulatorService
            .shutdownDevice(entry.udid)
            .then(() => iosSimulatorService.deleteDevice(entry.udid))
            .catch((err: unknown) => {
              warn(`drainPool: failed to clean up ${entry.udid}: ${String(err)}`);
            }),
        );
      }
    }

    await Promise.allSettled(drainPromises);
    this.iosPool.clear();
    log('iOS warm pool drained.');
  }

  // -------------------------------------------------------------------------
  // Private — cleanup helpers
  // -------------------------------------------------------------------------

  /**
   * Tear down the platform device associated with a session.
   * Handles both iOS (shutdown + delete) and Android (shutdown + delete AVD).
   * All errors are propagated to the caller.
   *
   * @param session - The session whose device should be torn down.
   */
  private async teardownDevice(session: InternalSession): Promise<void> {
    if (session.device.platform === 'ios' && session._iosUdid) {
      const udid = session._iosUdid;
      log(`[${session.id}] Shutting down iOS Simulator ${udid}…`);
      await iosSimulatorService.shutdownDevice(udid);
      log(`[${session.id}] Deleting iOS Simulator ${udid}…`);
      await iosSimulatorService.deleteDevice(udid);
    } else if (session.device.platform === 'android' && session._androidAvdName) {
      const avdName = session._androidAvdName;
      log(`[${session.id}] Shutting down Android emulator "${avdName}"…`);
      await androidEmulatorService.shutdownEmulator(avdName);
      log(`[${session.id}] Deleting Android AVD "${avdName}"…`);
      await androidEmulatorService.deleteAVD(avdName);
    }
    // If neither platform ID is set, the device was never created — nothing to do.
  }

  /**
   * Best-effort cleanup of resources created during a failed `createSession`
   * call.  Stops screen capture and tears down any partially created device.
   * All errors are swallowed so the original creation error can propagate.
   *
   * @param session - The failed session to clean up.
   */
  private async cleanupFailedSession(session: InternalSession): Promise<void> {
    log(`[${session.id}] Cleaning up resources from failed session creation…`);

    // Stop screen capture if it was started before the failure.
    screenCaptureService.stopCapture(session.id);

    // Tear down any partially created device.
    await this.teardownDevice(session).catch((err: unknown) => {
      warn(
        `[${session.id}] Could not tear down device during failed-session cleanup: ` +
          String(err),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Private — orphan device cleanup
  // -------------------------------------------------------------------------

  /**
   * Scan for and clean up orphan iOS Simulators that match our naming prefix
   * but are not tracked by any current in-memory session.
   *
   * Uses a direct `xcrun simctl list devices -j` call to access device names,
   * since the high-level `listDevices()` return type does not expose the name.
   */
  private async cleanupOrphanIOSDevices(): Promise<void> {
    try {
      // Raw simctl JSON gives us device name + UDID + state per device.
      const output = await execJSON<{
        devices: Record<
          string,
          Array<{ udid: string; name: string; state: string; isAvailable: boolean }>
        >;
      }>('xcrun', ['simctl', 'list', 'devices', '-j'], {
        env: {
          ...process.env,
          DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
        },
      });

      const trackedUdids = new Set(
        [...this.sessions.values()]
          .filter((s) => s._iosUdid)
          .map((s) => s._iosUdid!),
      );

      // Also skip devices currently held in the warm pool — they are managed
      // deliberately and must not be treated as orphans.
      const pooledUdids = new Set(
        [...this.iosPool.values()].flatMap((entries) => entries.map((e) => e.udid)),
      );

      for (const runtimeDevices of Object.values(output.devices)) {
        for (const device of runtimeDevices) {
          if (!device.name.startsWith(WMS_IOS_DEVICE_NAME_PREFIX)) continue;
          if (trackedUdids.has(device.udid)) continue;
          if (pooledUdids.has(device.udid)) continue;

          // Matches our naming convention but is not tracked — it's an orphan.
          log(
            `Found orphan iOS Simulator: "${device.name}" (${device.udid}) — cleaning up…`,
          );

          try {
            if (device.state.toLowerCase() !== 'shutdown') {
              await iosSimulatorService.shutdownDevice(device.udid);
            }
            await iosSimulatorService.deleteDevice(device.udid);
            log(`Orphan iOS Simulator ${device.udid} cleaned up successfully.`);
          } catch (err: unknown) {
            warn(
              `Failed to clean up orphan iOS Simulator ${device.udid}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err: unknown) {
      warn(`Orphan iOS device scan failed: ${String(err)}`);
    }
  }

  /**
   * Scan for and clean up orphan Android AVDs that match our naming prefix
   * but are not tracked by any current in-memory session.
   */
  private async cleanupOrphanAndroidAVDs(): Promise<void> {
    try {
      const allAVDs = await androidEmulatorService.listAVDs();
      const trackedAvdNames = new Set(
        [...this.sessions.values()]
          .filter((s) => s._androidAvdName)
          .map((s) => s._androidAvdName!),
      );

      for (const avd of allAVDs) {
        const avdName = avd.platformDeviceId; // This IS the AVD name.
        if (!avdName.startsWith(WMS_ANDROID_AVD_NAME_PREFIX)) continue;
        if (trackedAvdNames.has(avdName)) continue;

        // Matches our naming convention but is not tracked — it's an orphan.
        log(`Found orphan Android AVD: "${avdName}" — cleaning up…`);

        try {
          if (avd.state === 'booted') {
            await androidEmulatorService.shutdownEmulator(avdName);
          }
          await androidEmulatorService.deleteAVD(avdName);
          log(`Orphan Android AVD "${avdName}" cleaned up successfully.`);
        } catch (err: unknown) {
          warn(`Failed to clean up orphan Android AVD "${avdName}": ${String(err)}`);
        }
      }
    } catch (err: unknown) {
      warn(`Orphan Android AVD scan failed: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private — session timeout
  // -------------------------------------------------------------------------

  /**
   * Periodic callback (every 60 s) that terminates sessions whose age exceeds
   * `SESSION_TIMEOUT_MS` (30 minutes).  Runs in fire-and-forget style; errors
   * from individual terminations are logged but do not crash the interval.
   */
  private async checkTimeouts(): Promise<void> {
    const cutoff = Date.now() - SESSION_TIMEOUT_MS;

    // Snapshot the IDs to terminate before the loop, since terminateSession()
    // mutates the sessions Map.
    const timedOutIds = [...this.sessions.values()]
      .filter(
        (s) =>
          (s.status === 'active' || s.status === 'creating') &&
          new Date(s.createdAt).getTime() < cutoff,
      )
      .map((s) => s.id);

    for (const id of timedOutIds) {
      warn(
        `Session ${id} has exceeded the ${SESSION_TIMEOUT_MS / 60_000} min ` +
          `timeout — terminating automatically.`,
      );
      await this.terminateSession(id).catch((err: unknown) => {
        warn(
          `Auto-termination of timed-out session ${id} failed: ` +
            String(err),
        );
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private — memory eviction
  // -------------------------------------------------------------------------

  /**
   * Remove terminated/error sessions from the in-memory Map once they are
   * older than `config.sessionMemoryEvictionMs`.  The database retains them
   * permanently for historical queries.
   *
   * Runs every 5 minutes via the eviction interval started in the constructor.
   */
  private evictStaleMemorySessions(): void {
    const cutoff = Date.now() - config.sessionMemoryEvictionMs;
    let evicted = 0;

    for (const [id, session] of this.sessions) {
      if (session.status !== 'terminated' && session.status !== 'error') continue;

      const updatedMs = new Date(session.updatedAt).getTime();
      if (updatedMs < cutoff) {
        this.sessions.delete(id);
        evicted++;
      }
    }

    if (evicted > 0) {
      log(`Evicted ${evicted} stale session(s) from memory.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const sessionManagerService = new SessionManagerService();
