import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the service.
//
// The service calls `promisify(execFile)`, which wraps the callback-style
// execFile.  We expose the mock as a callback-style function so that
// promisify works correctly: the last argument promisify injects is the
// Node-style (err, result) callback.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises before importing the service.
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock the config module before importing the service.
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  config: {
    xcodePath: '/Applications/Xcode.app',
    androidSdkRoot: '/mock/android/sdk',
  },
}));

import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { ScreenCaptureService } from './screen-capture.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const mockUnlink = unlink as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Utility — wait for an event on an EventEmitter with a safety timeout.
// ---------------------------------------------------------------------------

function waitForEvent(emitter: EventEmitter, event: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}' event after ${timeoutMs}ms`)),
      timeoutMs,
    );
    emitter.once(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Configure `execFile` to behave as a successful no-op for the duration of
 * one or more frames.  `promisify` wraps the last argument as the callback,
 * so we accept any number of positional args and invoke the trailing function
 * as `cb(null, { stdout: Buffer.alloc(0), stderr: '' })`.
 */
function makeExecFileSucceed(): void {
  mockExecFile.mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, result: { stdout: Buffer; stderr: string }) => void;
      cb(null, { stdout: Buffer.alloc(0), stderr: '' });
    },
  );
}

/**
 * Configure `execFile` to always fail with the supplied error message.
 */
function makeExecFileFail(message = 'mock execFile error'): void {
  mockExecFile.mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error(message));
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScreenCaptureService', () => {
  let service: ScreenCaptureService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Suppress log noise from the service's internal log/warn helpers.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: execFile succeeds (no-op), unlink succeeds.
    makeExecFileSucceed();
    mockUnlink.mockResolvedValue(undefined);

    service = new ScreenCaptureService();
  });

  afterEach(async () => {
    // Stop all loops started in the test to prevent leaks into subsequent tests.
    service.cleanup();
    // Yield the microtask queue so any pending async loop iterations can drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // startCapture()
  // -------------------------------------------------------------------------

  describe('startCapture()', () => {
    it('returns an EventEmitter', () => {
      // Arrange
      const sessionId = 'session-emitter-check';

      // Act
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-0001');

      // Assert — must have the key EventEmitter surface
      expect(typeof emitter.on).toBe('function');
      expect(typeof emitter.emit).toBe('function');
      expect(emitter).toBeInstanceOf(EventEmitter);
    });

    it('stores the capture so getActiveCount() increments', () => {
      // Arrange / Act
      service.startCapture('session-count-1', 'ios', 'UDID-0001');

      // Assert
      expect(service.getActiveCount()).toBe(1);
    });

    it('is idempotent — calling twice for the same sessionId returns the same emitter', () => {
      // Arrange
      const sessionId = 'session-idempotent';

      // Act
      const first = service.startCapture(sessionId, 'ios', 'UDID-0002');
      const second = service.startCapture(sessionId, 'ios', 'UDID-0002');

      // Assert — same object reference
      expect(second).toBe(first);
    });

    it('counts only one active capture when called twice for the same sessionId', () => {
      // Arrange
      const sessionId = 'session-idempotent-count';

      // Act
      service.startCapture(sessionId, 'ios', 'UDID-0003');
      service.startCapture(sessionId, 'ios', 'UDID-0003');

      // Assert — still only one entry in the map
      expect(service.getActiveCount()).toBe(1);
    });

    it('tracks multiple concurrent captures', () => {
      // Act — start three independent captures
      service.startCapture('session-a', 'ios', 'UDID-A');
      service.startCapture('session-b', 'android', 'emulator-5554');
      service.startCapture('session-c', 'ios', 'UDID-C');

      // Assert
      expect(service.getActiveCount()).toBe(3);
    });

    it('emits frame events for iOS captures', async () => {
      // Arrange — execFile writes to file; readFile returns a fake JPEG buffer.
      makeExecFileSucceed();
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic bytes
      mockReadFile.mockResolvedValue(fakeJpeg);

      const sessionId = 'session-ios-frame';

      // Act
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-IOS-1');
      const frameData = await waitForEvent(emitter, 'frame');

      service.stopCapture(sessionId);

      // Assert — received frame data is the buffer from readFile
      expect(Buffer.isBuffer(frameData)).toBe(true);
      expect((frameData as Buffer).equals(fakeJpeg)).toBe(true);
    });

    it('emits frame events for Android captures', async () => {
      // Arrange — execFile returns a Buffer in stdout (simulating raw PNG data).
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic bytes
      mockExecFile.mockImplementation(
        (...args: unknown[]) => {
          const cb = args[args.length - 1] as (err: null, result: { stdout: Buffer; stderr: string }) => void;
          cb(null, { stdout: fakePng, stderr: '' });
        },
      );

      const sessionId = 'session-android-frame';

      // Act
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');
      const frameData = await waitForEvent(emitter, 'frame');

      service.stopCapture(sessionId);

      // Assert
      expect(Buffer.isBuffer(frameData)).toBe(true);
      expect((frameData as Buffer).equals(fakePng)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // stopCapture()
  // -------------------------------------------------------------------------

  describe('stopCapture()', () => {
    it('decrements getActiveCount() when stopped', () => {
      // Arrange
      const sessionId = 'session-stop-count';
      service.startCapture(sessionId, 'ios', 'UDID-STOP');

      // Act
      service.stopCapture(sessionId);

      // Assert
      expect(service.getActiveCount()).toBe(0);
    });

    it('makes getEmitter() return null after stopping', () => {
      // Arrange
      const sessionId = 'session-stop-emitter';
      service.startCapture(sessionId, 'ios', 'UDID-NULL');

      // Act
      service.stopCapture(sessionId);

      // Assert
      expect(service.getEmitter(sessionId)).toBeNull();
    });

    it('is a no-op for an unknown sessionId', () => {
      // Act & Assert — must not throw
      expect(() => service.stopCapture('nonexistent-session-xyz')).not.toThrow();
    });

    it('does not affect other active captures when one is stopped', () => {
      // Arrange
      service.startCapture('session-keep', 'ios', 'UDID-KEEP');
      service.startCapture('session-stop', 'ios', 'UDID-STOP');

      // Act
      service.stopCapture('session-stop');

      // Assert
      expect(service.getActiveCount()).toBe(1);
      expect(service.getEmitter('session-keep')).not.toBeNull();
    });

    it('attempts to unlink the temp file for iOS captures', async () => {
      // Arrange
      const sessionId = 'session-unlink-ios';
      service.startCapture(sessionId, 'ios', 'UDID-IOS-UNLINK');

      // Act
      service.stopCapture(sessionId);

      // Yield so the fire-and-forget unlink() promise has a chance to execute.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert
      expect(mockUnlink).toHaveBeenCalledWith(`/tmp/wms-capture-${sessionId}.jpg`);
    });

    it('does NOT attempt to unlink a temp file for Android captures', async () => {
      // Arrange
      const sessionId = 'session-no-unlink-android';
      service.startCapture(sessionId, 'android', 'emulator-5554');

      // Act
      service.stopCapture(sessionId);

      // Yield to let any async side-effects flush.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert — unlink must never be called for Android sessions
      expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getEmitter()
  // -------------------------------------------------------------------------

  describe('getEmitter()', () => {
    it('returns the EventEmitter for an active capture', () => {
      // Arrange
      const sessionId = 'session-get-emitter';
      const startedEmitter = service.startCapture(sessionId, 'ios', 'UDID-GET');

      // Act
      const retrieved = service.getEmitter(sessionId);

      // Assert
      expect(retrieved).not.toBeNull();
      expect(retrieved).toBe(startedEmitter);
    });

    it('returns null for an unknown sessionId', () => {
      // Act
      const result = service.getEmitter('completely-unknown-session');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null after the session has been stopped', () => {
      // Arrange
      const sessionId = 'session-emitter-after-stop';
      service.startCapture(sessionId, 'android', 'emulator-9999');
      service.stopCapture(sessionId);

      // Act
      const result = service.getEmitter(sessionId);

      // Assert
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // cleanup()
  // -------------------------------------------------------------------------

  describe('cleanup()', () => {
    it('stops all active captures', () => {
      // Arrange — start 3 captures across platforms
      service.startCapture('cleanup-ios-1', 'ios', 'UDID-C1');
      service.startCapture('cleanup-ios-2', 'ios', 'UDID-C2');
      service.startCapture('cleanup-android-1', 'android', 'emulator-5554');

      // Act
      service.cleanup();

      // Assert
      expect(service.getActiveCount()).toBe(0);
    });

    it('makes every stopped session return null from getEmitter()', () => {
      // Arrange
      const ids = ['cleanup-e1', 'cleanup-e2', 'cleanup-e3'];
      for (const id of ids) {
        service.startCapture(id, 'ios', `UDID-${id}`);
      }

      // Act
      service.cleanup();

      // Assert
      for (const id of ids) {
        expect(service.getEmitter(id)).toBeNull();
      }
    });

    it('is safe to call when no captures are active', () => {
      // Act & Assert — must not throw
      expect(() => service.cleanup()).not.toThrow();
    });

    it('is safe to call multiple times consecutively', () => {
      // Arrange
      service.startCapture('cleanup-multi', 'android', 'emulator-5554');

      // Act & Assert
      expect(() => {
        service.cleanup();
        service.cleanup();
        service.cleanup();
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling — consecutive failures & automatic loop termination
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('emits error after MAX_CONSECUTIVE_FAILURES (5) failures', async () => {
      // Arrange — make every execFile call fail immediately.
      makeExecFileFail('simulated capture failure');

      const sessionId = 'session-error-emit';
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');

      // Act — wait for the 'error' event.
      // IMPORTANT: register an error listener BEFORE waiting so Node does not
      // throw on an unhandled 'error' emission.
      const errorData = await waitForEvent(emitter, 'error', 10_000);

      // Assert — the emitted value is an Error with the expected message.
      expect(errorData).toBeInstanceOf(Error);
      expect((errorData as Error).message).toMatch(/failed after 5 consecutive errors/i);
    });

    it('stops the capture after max consecutive failures', async () => {
      // Arrange
      makeExecFileFail('fail-for-stop-check');

      const sessionId = 'session-auto-stop';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-FAIL');

      // Also mock readFile to reject so the iOS path fails too.
      mockReadFile.mockRejectedValue(new Error('readFile failure'));

      // Act — wait for the error event that fires after 5 failures.
      await waitForEvent(emitter, 'error', 10_000);

      // Assert — the session should have been removed from the active map.
      expect(service.getActiveCount()).toBe(0);
      expect(service.getEmitter(sessionId)).toBeNull();
    });

    it('resets the consecutive failure counter after a successful frame', async () => {
      // Arrange — first few calls fail, then one succeeds.
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff]);
      let callCount = 0;

      mockExecFile.mockImplementation(
        (...args: unknown[]) => {
          callCount++;
          const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: Buffer; stderr: string }) => void;
          if (callCount <= 3) {
            cb(new Error('transient failure'));
          } else {
            cb(null, { stdout: Buffer.alloc(0), stderr: '' });
          }
        },
      );
      mockReadFile.mockResolvedValue(fakeJpeg);

      const sessionId = 'session-reset-failures';

      // Act — wait for a successful frame (which means the counter reset).
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-RESET');
      const frame = await waitForEvent(emitter, 'frame', 10_000);

      service.stopCapture(sessionId);

      // Assert — we received a valid frame, proving the loop recovered.
      expect(Buffer.isBuffer(frame)).toBe(true);
    });

    it('does not emit error for fewer than 5 consecutive failures when a frame succeeds first', async () => {
      // Arrange — fail 4 times, then succeed.
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff]);
      let callCount = 0;

      mockExecFile.mockImplementation(
        (...args: unknown[]) => {
          callCount++;
          const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: Buffer; stderr: string }) => void;
          if (callCount <= 4) {
            cb(new Error('transient sub-threshold failure'));
          } else {
            cb(null, { stdout: Buffer.alloc(0), stderr: '' });
          }
        },
      );
      mockReadFile.mockResolvedValue(fakeJpeg);

      const sessionId = 'session-below-threshold';
      let errorFired = false;
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-THRESHOLD');
      emitter.on('error', () => { errorFired = true; });

      // Wait for the first successful frame.
      await waitForEvent(emitter, 'frame', 10_000);

      service.stopCapture(sessionId);

      // Assert — error was never fired; the loop recovered successfully.
      expect(errorFired).toBe(false);
    });

    it('emits error with a message that includes the last error details', async () => {
      // Arrange
      const lastErrorMsg = 'device disconnected or offline';
      makeExecFileFail(lastErrorMsg);

      const sessionId = 'session-error-details';
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');

      // Act
      const error = (await waitForEvent(emitter, 'error', 10_000)) as Error;

      // Assert — the last error message should appear in the emitted error.
      expect(error.message).toContain(lastErrorMsg);
    });
  });
});
