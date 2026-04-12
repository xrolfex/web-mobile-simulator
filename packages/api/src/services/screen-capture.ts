import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Promisified execFile variants
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Public metadata for a single active screen-capture session.
 * Does not include the internal emitter or abort controller.
 */
export interface CaptureSession {
  /** The session ID this capture belongs to. */
  sessionId: string;
  /** Platform being captured. */
  platform: 'ios' | 'android';
  /** iOS UDID or Android serial (e.g. `'emulator-5554'`). */
  deviceId: string;
  /** Target frames-per-second. Actual FPS will be lower due to capture latency. */
  targetFps: number;
  /** Whether the capture loop is actively running. */
  active: boolean;
}

/** Internal record that adds the emitter and abort controller to CaptureSession. */
interface InternalCaptureSession extends CaptureSession {
  emitter: EventEmitter;
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[ScreenCaptureService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default frames-per-second target if none is specified. */
const DEFAULT_TARGET_FPS = 8;

/** Maximum consecutive capture failures before the loop is stopped. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Milliseconds to wait after a capture failure before retrying. */
const FAILURE_RETRY_DELAY_MS = 500;

/**
 * Environment overrides for all `xcrun` calls.
 * Sets `DEVELOPER_DIR` so `xcrun` resolves tools (like `simctl`) from the
 * full Xcode.app bundle, even when `xcode-select -p` points to the
 * standalone Command Line Tools.
 */
const XCRUN_EXEC_OPTIONS: import('node:child_process').ExecFileOptions = {
  env: {
    ...process.env,
    DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
  },
};

/** Fully-qualified path to the `adb` binary derived from config. */
const ADB = `${config.androidSdkRoot}/platform-tools/adb`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the temporary file path used to store iOS screenshot data.
 *
 * @param sessionId - The session ID to embed in the path for uniqueness.
 * @returns An absolute path under `/tmp`.
 */
function iosTempFilePath(sessionId: string): string {
  return `/tmp/wms-capture-${sessionId}.jpg`;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Manages per-session screen capture loops for iOS Simulators and Android
 * emulators.
 *
 * When `startCapture` is called a background loop begins that continuously
 * captures frames from the device and publishes them as `'frame'` events on
 * the returned {@link EventEmitter}.  Consumers subscribe to those events to
 * receive raw image buffers (JPEG for iOS, PNG for Android) and forward them
 * to browser clients via WebSocket.
 *
 * Export the singleton `screenCaptureService` rather than constructing
 * instances directly.
 */
export class ScreenCaptureService {
  /** Active capture sessions keyed by session ID. */
  private readonly captures = new Map<string, InternalCaptureSession>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a screen-capture loop for a session.
   *
   * If a capture is already running for `sessionId` the existing
   * {@link EventEmitter} is returned unchanged.
   *
   * Emits:
   * - `'frame'` — `Buffer` containing JPEG (iOS) or PNG (Android) image data.
   * - `'error'` — `Error` emitted after `MAX_CONSECUTIVE_FAILURES` consecutive
   *   capture failures; the loop is stopped before emission.
   *
   * @param sessionId  - Unique identifier for the session.
   * @param platform   - Target platform: `'ios'` or `'android'`.
   * @param deviceId   - iOS UDID or Android ADB serial (e.g. `'emulator-5554'`).
   * @param targetFps  - Desired capture rate (default {@link DEFAULT_TARGET_FPS}).
   * @returns An `EventEmitter` that emits `'frame'` and `'error'` events.
   */
  startCapture(
    sessionId: string,
    platform: 'ios' | 'android',
    deviceId: string,
    targetFps: number = DEFAULT_TARGET_FPS,
  ): EventEmitter {
    const existing = this.captures.get(sessionId);
    if (existing) {
      log(`Capture already running for session ${sessionId} — returning existing emitter`);
      return existing.emitter;
    }

    const emitter = new EventEmitter();
    const abortController = new AbortController();

    const session: InternalCaptureSession = {
      sessionId,
      platform,
      deviceId,
      targetFps,
      active: true,
      emitter,
      abortController,
    };

    this.captures.set(sessionId, session);

    log(`Starting ${platform} capture for session ${sessionId} (device=${deviceId}, fps=${targetFps})`);

    // Launch the capture loop in the background — do not await.
    void this.runCaptureLoop(session);

    return emitter;
  }

  /**
   * Stop the capture loop for a session and clean up any temp files.
   *
   * Safe to call even if no capture is running for `sessionId`.
   *
   * @param sessionId - Session whose capture should be stopped.
   */
  stopCapture(sessionId: string): void {
    const session = this.captures.get(sessionId);
    if (!session) return;

    log(`Stopping capture for session ${sessionId}`);
    session.active = false;
    session.abortController.abort();
    this.captures.delete(sessionId);

    // Best-effort temp file cleanup for iOS sessions.
    if (session.platform === 'ios') {
      const tmpPath = iosTempFilePath(sessionId);
      unlink(tmpPath).catch(() => {
        // File may not exist if a frame was never captured — ignore silently.
      });
    }
  }

  /**
   * Stop all active capture loops.  Intended for graceful server shutdown.
   */
  cleanup(): void {
    log(`Stopping all ${this.captures.size} active capture(s)…`);
    for (const sessionId of this.captures.keys()) {
      this.stopCapture(sessionId);
    }
  }

  /**
   * Return the number of currently active capture loops.
   */
  getActiveCount(): number {
    return this.captures.size;
  }

  /**
   * Return the {@link EventEmitter} for a running capture session, or `null`
   * if no capture is active for `sessionId`.
   *
   * @param sessionId - Session to look up.
   */
  getEmitter(sessionId: string): EventEmitter | null {
    const session = this.captures.get(sessionId);
    return session?.emitter ?? null;
  }

  // -------------------------------------------------------------------------
  // Private — capture loops
  // -------------------------------------------------------------------------

  /**
   * Main capture loop.  Runs until the session's `AbortController` is aborted
   * or `MAX_CONSECUTIVE_FAILURES` consecutive errors occur.
   *
   * @param session - The internal capture session to run the loop for.
   */
  private async runCaptureLoop(session: InternalCaptureSession): Promise<void> {
    const { sessionId, platform, targetFps } = session;
    const frameIntervalMs = Math.round(1000 / targetFps);
    let consecutiveFailures = 0;

    while (session.active && !session.abortController.signal.aborted) {
      const frameStart = Date.now();

      try {
        let frame: Buffer;

        if (platform === 'ios') {
          frame = await this.captureIOSFrame(session);
        } else {
          frame = await this.captureAndroidFrame(session);
        }

        // Reset failure counter on success.
        consecutiveFailures = 0;

        if (session.active && !session.abortController.signal.aborted) {
          session.emitter.emit('frame', frame);
        }
      } catch (error: unknown) {
        consecutiveFailures++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        warn(
          `Capture failure #${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} ` +
          `for session ${sessionId}: ${errorMessage}`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          warn(`Session ${sessionId} exceeded max failures — stopping capture loop`);
          session.active = false;
          this.captures.delete(sessionId);

          const captureError = new Error(
            `Screen capture for session ${sessionId} failed after ` +
            `${MAX_CONSECUTIVE_FAILURES} consecutive errors. ` +
            `Last error: ${errorMessage}`,
          );
          session.emitter.emit('error', captureError);
          return;
        }

        // Retry after a short delay.
        await sleep(FAILURE_RETRY_DELAY_MS);
        continue;
      }

      // Throttle to target FPS: sleep for the remaining frame budget.
      const elapsed = Date.now() - frameStart;
      const remaining = frameIntervalMs - elapsed;
      if (remaining > 0 && session.active && !session.abortController.signal.aborted) {
        await sleep(remaining);
      }
    }

    log(`Capture loop ended for session ${sessionId}`);
  }

  /**
   * Capture a single JPEG frame from an iOS Simulator using `xcrun simctl io`.
   *
   * Writes the screenshot to a per-session temp file then reads it back as a
   * `Buffer`.  Using a file is required because `simctl io screenshot` does
   * not reliably write image data to stdout.
   *
   * @param session - The internal capture session (must have `platform === 'ios'`).
   * @returns A `Buffer` containing JPEG image data.
   */
  private async captureIOSFrame(session: InternalCaptureSession): Promise<Buffer> {
    const { deviceId } = session;
    const tmpPath = iosTempFilePath(session.sessionId);

    await execFileAsync(
      'xcrun',
      ['simctl', 'io', deviceId, 'screenshot', '--type=jpeg', tmpPath],
      {
        maxBuffer: 1024 * 1024,
        ...XCRUN_EXEC_OPTIONS,
      },
    );

    return readFile(tmpPath);
  }

  /**
   * Capture a single PNG frame from an Android emulator using `adb exec-out screencap`.
   *
   * The `adb exec-out screencap -p` command writes raw PNG data directly to
   * stdout, so we capture it as a binary `Buffer`.
   *
   * @param session - The internal capture session (must have `platform === 'android'`).
   * @returns A `Buffer` containing PNG image data.
   */
  private async captureAndroidFrame(session: InternalCaptureSession): Promise<Buffer> {
    const { deviceId } = session;

    const result = await execFileAsync(
      ADB,
      ['-s', deviceId, 'exec-out', 'screencap', '-p'],
      // `encoding: 'buffer'` keeps stdout as a raw Buffer instead of a string.
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
    );

    // When encoding is 'buffer', stdout is typed as Buffer by Node's overloads.
    const stdout = result.stdout as unknown as Buffer;

    if (!stdout || stdout.length === 0) {
      throw new Error(`adb screencap returned empty data for device ${deviceId}`);
    }

    return stdout;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const screenCaptureService = new ScreenCaptureService();
