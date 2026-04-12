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
import { SESSION_TIMEOUT_MS } from '@web-mobile-simulator/shared';
import { iosSimulatorService } from './ios-simulator.js';
import { androidEmulatorService } from './android-emulator.js';
import { vncProxyService } from './vnc-proxy.js';
import { eventBusService } from './event-bus.js';

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
  /** Android AVD name — present only for `platform === 'android'` sessions. */
  _androidAvdName?: string;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full lifecycle of a simulator session:
 *   create device → boot → start VNC proxy → serve stream → shutdown → cleanup.
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

  /** Handle for the periodic timeout-checker interval. */
  private timeoutCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Check for timed-out sessions once per minute.
    this.timeoutCheckInterval = setInterval(
      () => void this.checkTimeouts(),
      60_000,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new simulator session for the requested platform.
   *
   * The full lifecycle is executed synchronously in sequence:
   *   1. Generate a session ID and create an initial 'creating' record.
   *   2. Create the platform device (iOS Simulator / Android AVD).
   *   3. Boot the device and wait until it is ready.
   *   4. Discover the VNC port and start the WebSocket proxy.
   *   5. Update the session to 'active' and return it.
   *
   * If any step fails, partial resources are cleaned up and the session is
   * set to 'error' before re-throwing.
   *
   * @param request - Platform, runtime, and device-type selection.
   * @returns The fully initialised `Session` record.
   * @throws If device creation, boot, or proxy startup fails.
   */
  async createSession(request: CreateSessionRequest): Promise<Session> {
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

  /**
   * Retrieve a session by ID.
   *
   * @param id - Session identifier.
   * @returns The `Session` record, or `null` if not found.
   */
  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * List all sessions, optionally filtered to a specific status.
   *
   * @param status - If provided, only sessions with this status are returned.
   * @returns Array of matching `Session` records (snapshot, not live references).
   */
  listSessions(status?: SessionStatus): Session[] {
    const all = [...this.sessions.values()];
    if (status !== undefined) {
      return all.filter((s) => s.status === status);
    }
    return all;
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
    this.emitStatusChange(session, previousStatus);

    // Stop the VNC proxy first — this is safe to call even if no proxy was
    // started (it silently no-ops).
    await vncProxyService.stopProxy(id).catch((err: unknown) => {
      warn(`Failed to stop VNC proxy for session ${id}: ${String(err)}`);
    });

    // Shut down and delete the platform device.
    await this.teardownDevice(session).catch((err: unknown) => {
      warn(`Device teardown failed for session ${id}: ${String(err)}`);
    });

    session.status = 'terminated';
    session.updatedAt = now();
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

    log(`Cleanup complete. Terminated ${activeIds.length} session(s).`);
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
    const deviceName = `wms-session-${shortId(sessionId)}`;

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

    // Step 3 — Discover the VNC port.
    log(`[${sessionId}] Discovering VNC port for ${udid}…`);
    const vncPort = await iosSimulatorService.getVNCPort(udid);
    if (vncPort === null) {
      throw new Error(
        `Could not discover VNC port for iOS Simulator ${udid}. ` +
          `Ensure the device is booted and the Simulator app is running.`,
      );
    }

    // Step 4 — Start the VNC WebSocket proxy.
    log(`[${sessionId}] Starting VNC proxy on VNC port ${vncPort}…`);
    const { wsPort, wsUrl } = await vncProxyService.startProxy(
      sessionId,
      'localhost',
      vncPort,
    );

    // Step 5 — Finalise and activate the session.
    session.status = 'active';
    session.streamUrl = wsUrl;
    session.proxyPort = wsPort;
    session.updatedAt = now();

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
    const avdName = `wms_session_${shortId(sessionId)}`;

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

    // Step 3 — Start the VNC proxy.
    // Android emulator exposes a VNC server on port 5554+1 = 5555 by
    // convention, but the display-streaming approach mirrors iOS via VNC.
    // The ADB port is the emulator's console port (e.g. 5554); the display
    // stream typically lives at adbPort+1.  Use the discovered adbPort + 1
    // as the VNC target until a dedicated screen-capture pipeline is wired in.
    const androidVncPort = adbPort + 1;
    log(`[${sessionId}] Starting VNC proxy targeting Android display port ${androidVncPort}…`);
    const { wsPort, wsUrl } = await vncProxyService.startProxy(
      sessionId,
      'localhost',
      androidVncPort,
    );

    // Step 4 — Finalise and activate the session.
    session.status = 'active';
    session.streamUrl = wsUrl;
    session.proxyPort = wsPort;
    session.updatedAt = now();

    log(`[${sessionId}] Android session active — stream: ${wsUrl}`);
    this.emitStatusChange(session, 'creating');
    return session;
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
   * call.  Stops the VNC proxy and tears down any partially created device.
   * All errors are swallowed so the original creation error can propagate.
   *
   * @param session - The failed session to clean up.
   */
  private async cleanupFailedSession(session: InternalSession): Promise<void> {
    log(`[${session.id}] Cleaning up resources from failed session creation…`);

    // Stop the VNC proxy if it was started before the failure.
    await vncProxyService.stopProxy(session.id).catch((err: unknown) => {
      warn(
        `[${session.id}] Could not stop VNC proxy during failed-session cleanup: ` +
          String(err),
      );
    });

    // Tear down any partially created device.
    await this.teardownDevice(session).catch((err: unknown) => {
      warn(
        `[${session.id}] Could not tear down device during failed-session cleanup: ` +
          String(err),
      );
    });
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

    for (const session of this.sessions.values()) {
      if (session.status !== 'active' && session.status !== 'creating') continue;

      const createdMs = new Date(session.createdAt).getTime();
      if (createdMs < cutoff) {
        warn(
          `Session ${session.id} has exceeded the ${SESSION_TIMEOUT_MS / 60_000} min ` +
            `timeout — terminating automatically.`,
        );
        await this.terminateSession(session.id).catch((err: unknown) => {
          warn(
            `Auto-termination of timed-out session ${session.id} failed: ` +
              String(err),
          );
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const sessionManagerService = new SessionManagerService();
