import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the service.
//
// The service calls `promisify(execFile)`, which wraps the callback-style
// execFile.  We expose the mock as a callback-style function so that
// promisify works correctly: the last argument promisify injects is the
// Node-style (err, result) callback.
// We also mock `spawn` for the new persistent iOS capture process path.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises before importing the service.
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined), // pretend binary already compiled by default
  // The service imports `constants as fsConstants` from 'node:fs/promises'.
  // Without this, fsConstants is undefined and access(path, fsConstants.X_OK) throws
  // a TypeError that gets swallowed by the try/catch, triggering unwanted compilation.
  constants: { X_OK: 1 },
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

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink, writeFile, access } from 'node:fs/promises';
import { ScreenCaptureService } from './screen-capture.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const mockUnlink = unlink as unknown as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>;
const mockAccess = access as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock child process helpers
// ---------------------------------------------------------------------------

interface MockChildProcess {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
  _processEmitter: EventEmitter;
}

/**
 * Build a mock ChildProcess with real Readable streams for stdout/stderr.
 * Process-level events (exit, error) are routed through a dedicated EventEmitter
 * so that the `on` mock can be wired up correctly.
 */
function makeMockChildProcess(): MockChildProcess {
  const processEmitter = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  return {
    stdout,
    stderr,
    stdin: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      processEmitter.on(event, handler);
    }),
    emit: (event: string, ...args: unknown[]) => processEmitter.emit(event, ...args),
    _processEmitter: processEmitter,
  };
}

/**
 * Build a Buffer containing a single 4-byte big-endian length-prefixed frame.
 * This is the wire format the Swift capture binary writes to stdout.
 */
function buildFramePacket(jpegData: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(jpegData.length, 0);
  return Buffer.concat([header, jpegData]);
}

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
 * Configure `execFile` to behave as a successful no-op.
 * `promisify` wraps the last argument as the callback, so we accept any number
 * of positional args and invoke the trailing function as
 * `cb(null, { stdout: Buffer.alloc(0), stderr: '' })`.
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

    // Default: binary already compiled (access resolves) — skips compilation.
    mockAccess.mockResolvedValue(undefined);
    // Default: version sidecar file returns the current version — skips recompilation.
    mockReadFile.mockResolvedValue('11');
    mockWriteFile.mockResolvedValue(undefined);

    // Default: spawn returns a fresh mock child process.
    const defaultMockProcess = makeMockChildProcess();
    mockSpawn.mockReturnValue(defaultMockProcess);

    // Default: execFile succeeds (covers Android path + any xcrun fallbacks).
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

    it('emits frame events for iOS captures via persistent capture process', async () => {
      // Arrange — mock spawn returns a process that emits one length-prefixed JPEG frame.
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic bytes
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-ios-frame';

      // Act
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-IOS-1');

      // Wait for the binary compilation check (access mock already resolves) so
      // startIOSCaptureProcess() is called and stdout listener is wired up.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Register the 'frame' listener BEFORE pushing to stdout, because the event
      // is emitted synchronously during the Readable 'data' handler.
      const framePromise = waitForEvent(emitter, 'frame');

      // Simulate the capture process emitting a length-prefixed JPEG frame on stdout.
      mockProcess.stdout.push(buildFramePacket(fakeJpeg));

      const frameData = await framePromise;
      service.stopCapture(sessionId);

      // Assert — the frame event payload is the raw JPEG bytes (without the 4-byte header).
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

    it('spawns the capture binary with --device-name and --fps args for iOS', async () => {
      // Arrange
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act
      service.startCapture('session-spawn-args', 'ios', 'UDID-ARGS', 20, 'wms-session-test');

      // Yield so the promise chain (ensureCaptureBinaryCompiled → startIOSCaptureProcess) resolves.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — spawn called with the correct binary path and arguments.
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream'),
        ['--device-name', 'wms-session-test', '--fps', '20'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('uses deviceId as device name when no deviceName param is supplied', async () => {
      // Arrange
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act — no 5th param, so deviceId should be used as the device name.
      service.startCapture('session-no-device-name', 'ios', 'MY-UDID-1234', 15);

      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — spawn receives deviceId as --device-name.
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream'),
        ['--device-name', 'MY-UDID-1234', '--fps', '15'],
        expect.anything(),
      );
    });

    it('correctly parses a frame split across multiple stdout chunks', async () => {
      // Arrange
      const fakeJpeg = Buffer.alloc(100, 0xff); // 100-byte fake JPEG payload
      const fullPacket = buildFramePacket(fakeJpeg);
      const chunk1 = fullPacket.subarray(0, 10);  // partial header + partial body
      const chunk2 = fullPacket.subarray(10);      // rest of body

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act
      const emitter = service.startCapture('session-split-frame', 'ios', 'UDID-SPLIT');
      await new Promise(resolve => setTimeout(resolve, 0));

      // Register listener BEFORE pushing chunks — frame fires synchronously on the second push.
      const framePromise = waitForEvent(emitter, 'frame');

      // Push the two chunks separately — the service must buffer and reassemble.
      mockProcess.stdout.push(chunk1);
      mockProcess.stdout.push(chunk2);

      const frameData = await framePromise;
      service.stopCapture('session-split-frame');

      // Assert — the reconstructed frame equals the original JPEG payload.
      expect((frameData as Buffer).equals(fakeJpeg)).toBe(true);
    });

    it('parses multiple complete frames from a single large stdout chunk', async () => {
      // Arrange
      const fakeJpeg1 = Buffer.from([0xff, 0xd8, 0x01]);
      const fakeJpeg2 = Buffer.from([0xff, 0xd8, 0x02]);
      const combinedPacket = Buffer.concat([buildFramePacket(fakeJpeg1), buildFramePacket(fakeJpeg2)]);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const receivedFrames: Buffer[] = [];
      const emitter = service.startCapture('session-multi-frame', 'ios', 'UDID-MULTI');
      await new Promise(resolve => setTimeout(resolve, 0));

      emitter.on('frame', (f: unknown) => receivedFrames.push(f as Buffer));

      // Act — push both frames in a single chunk.
      mockProcess.stdout.push(combinedPacket);

      // Give the event loop a tick to flush all synchronous event handlers.
      await new Promise(resolve => setTimeout(resolve, 10));
      service.stopCapture('session-multi-frame');

      // Assert — both frames were parsed and emitted.
      expect(receivedFrames.length).toBe(2);
      expect(receivedFrames[0]!.equals(fakeJpeg1)).toBe(true);
      expect(receivedFrames[1]!.equals(fakeJpeg2)).toBe(true);
    });

    it('falls back to xcrun polling loop when Swift binary compilation fails', async () => {
      // Arrange: access rejects (no cached binary), then swiftc compilation fails.
      mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff]);

      // First execFile call is swiftc — fail it.
      // Subsequent calls are xcrun — succeed so readFile can provide the frame.
      let swiftcCallDone = false;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: Buffer; stderr: string }) => void;
        if (!swiftcCallDone) {
          swiftcCallDone = true;
          cb(new Error('swiftc: command not found'));
        } else {
          cb(null, { stdout: Buffer.alloc(0), stderr: '' });
        }
      });
      mockReadFile.mockResolvedValue(fakeJpeg);

      // Act
      const emitter = service.startCapture('session-fallback', 'ios', 'UDID-FALLBACK');

      // Wait long enough for: access rejection → compilation attempt → swiftc failure
      // → catch handler → runCaptureLoop → first xcrun call → readFile → frame event.
      const frameData = await waitForEvent(emitter, 'frame', 10_000);
      service.stopCapture('session-fallback');

      // Assert — received a valid frame via the xcrun fallback path.
      expect(Buffer.isBuffer(frameData)).toBe(true);
      expect((frameData as Buffer).equals(fakeJpeg)).toBe(true);
    });

    it('skips compilation when the cached binary already exists (access resolves)', async () => {
      // Arrange — access resolves (default), so writeFile and swiftc must NOT be called.
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act
      service.startCapture('session-skip-compile', 'ios', 'UDID-SKIP');
      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — no compilation was attempted.
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      // And spawn WAS called (persistent process path taken).
      expect(mockSpawn).toHaveBeenCalled();
      // readFile was called to check the version sidecar (but no recompile occurred).
      expect(mockReadFile).toHaveBeenCalled();
    });

    it('recompiles when the version sidecar file is missing (readFile rejects)', async () => {
      // Arrange — binary exists, but version file is missing.
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Make execFile succeed (swiftc compilation).
      makeExecFileSucceed();

      // Act
      service.startCapture('session-recompile-no-ver', 'ios', 'UDID-NOVER');
      await new Promise(resolve => setTimeout(resolve, 50));

      // Assert — Swift source written and swiftc invoked.
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream.swift'),
        expect.any(String),
        'utf8',
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'swiftc',
        expect.arrayContaining([expect.stringContaining('wms-ios-capture-stream.swift')]),
        expect.anything(),
        expect.any(Function),
      );
      // Version file written after successful compilation.
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream.ver'),
        '11',
        'utf8',
      );
    });

    it('recompiles when the cached binary has a stale version', async () => {
      // Arrange — binary exists, but version sidecar returns an old version.
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('1'); // old version

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      makeExecFileSucceed();

      // Act
      service.startCapture('session-recompile-stale', 'ios', 'UDID-STALE');
      await new Promise(resolve => setTimeout(resolve, 50));

      // Assert — recompilation was triggered.
      expect(mockExecFile).toHaveBeenCalledWith(
        'swiftc',
        expect.any(Array),
        expect.anything(),
        expect.any(Function),
      );
      // Old binary was deleted before recompile.
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream'),
      );
      // Version file written with new version.
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream.ver'),
        '11',
        'utf8',
      );
    });

    it('writes the version sidecar file after fresh compilation', async () => {
      // Arrange — binary does not exist.
      mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      makeExecFileSucceed();

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act
      service.startCapture('session-ver-write', 'ios', 'UDID-VERWRITE');
      await new Promise(resolve => setTimeout(resolve, 50));

      // Assert — version sidecar written after compilation.
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream.ver'),
        '11',
        'utf8',
      );
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

    it('sends SIGTERM to the capture process when stopped', async () => {
      // Arrange — spawn returns a controllable mock process.
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-sigterm';
      service.startCapture(sessionId, 'ios', 'UDID-SIGTERM');

      // Wait for ensureCaptureBinaryCompiled → startIOSCaptureProcess to run.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Act
      service.stopCapture(sessionId);

      // Assert — kill was called with SIGTERM.
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does NOT unlink a temp file for iOS captures using the persistent process', async () => {
      // Arrange — access resolves (default) → persistent process path is taken.
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-no-unlink-ios-persistent';
      service.startCapture(sessionId, 'ios', 'UDID-IOS-UNLINK');

      // Wait for the process to be spawned so captureProcess is set on the session.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Act
      service.stopCapture(sessionId);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Assert — unlink must NOT be called because hadCaptureProcess is true.
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('does NOT attempt to unlink a temp file for Android captures', async () => {
      // Arrange
      const sessionId = 'session-no-unlink-android';
      service.startCapture(sessionId, 'android', 'emulator-5554');

      // Act
      service.stopCapture(sessionId);

      // Yield to let any async side-effects flush.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert — unlink must never be called for Android sessions.
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('does not emit an error event after stopCapture is called before process exits', async () => {
      // Arrange
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-no-error-on-stop';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-CLEAN-STOP');
      await new Promise(resolve => setTimeout(resolve, 0));

      let errorFired = false;
      emitter.on('error', () => { errorFired = true; });

      // Act — stop cleanly, then simulate the process exiting (code 0).
      service.stopCapture(sessionId);
      // After stopCapture, session.active is false — exit should be silently ignored.
      mockProcess.emit('exit', 0, null);

      await new Promise(resolve => setTimeout(resolve, 10));

      // Assert — no error was emitted because session.active was already false.
      expect(errorFired).toBe(false);
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

    it('sends SIGTERM to all active iOS capture processes on cleanup', async () => {
      // Arrange — two separate iOS sessions each with their own mock process.
      const mockProcess1 = makeMockChildProcess();
      const mockProcess2 = makeMockChildProcess();
      mockSpawn
        .mockReturnValueOnce(mockProcess1)
        .mockReturnValueOnce(mockProcess2);

      service.startCapture('cleanup-kill-1', 'ios', 'UDID-K1');
      service.startCapture('cleanup-kill-2', 'ios', 'UDID-K2');

      // Wait for both spawns to complete.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Act
      service.cleanup();

      // Assert — both processes were killed.
      expect(mockProcess1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess2.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling — consecutive failures & automatic loop termination
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('emits error after MAX_CONSECUTIVE_FAILURES (5) failures for Android', async () => {
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

    it('stops the capture after max consecutive failures for Android', async () => {
      // Arrange
      makeExecFileFail('fail-for-stop-check');

      const sessionId = 'session-auto-stop';
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');

      // Act — wait for the error event that fires after 5 failures.
      await waitForEvent(emitter, 'error', 10_000);

      // Assert — the session should have been removed from the active map.
      expect(service.getActiveCount()).toBe(0);
      expect(service.getEmitter(sessionId)).toBeNull();
    });

    it('resets the consecutive failure counter after a successful frame (Android)', async () => {
      // Arrange — first few calls fail, then succeed forever after.
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      let callCount = 0;

      mockExecFile.mockImplementation(
        (...args: unknown[]) => {
          callCount++;
          const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: Buffer; stderr: string }) => void;
          if (callCount <= 3) {
            cb(new Error('transient failure'));
          } else {
            cb(null, { stdout: fakePng, stderr: '' });
          }
        },
      );

      const sessionId = 'session-reset-failures';

      // Act — wait for a successful frame (which means the counter reset).
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');
      const frame = await waitForEvent(emitter, 'frame', 10_000);

      service.stopCapture(sessionId);

      // Assert — we received a valid frame, proving the loop recovered.
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect((frame as Buffer).equals(fakePng)).toBe(true);
    });

    it('does not emit error for fewer than 5 consecutive failures when a frame succeeds first (Android)', async () => {
      // Arrange — fail 4 times, then succeed.
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      let callCount = 0;

      mockExecFile.mockImplementation(
        (...args: unknown[]) => {
          callCount++;
          const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: Buffer; stderr: string }) => void;
          if (callCount <= 4) {
            cb(new Error('transient sub-threshold failure'));
          } else {
            cb(null, { stdout: fakePng, stderr: '' });
          }
        },
      );

      const sessionId = 'session-below-threshold';
      let errorFired = false;
      const emitter = service.startCapture(sessionId, 'android', 'emulator-5554');
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

    it('emits error when the iOS capture process exits unexpectedly with non-zero code', async () => {
      // Arrange — create MAX_IOS_CAPTURE_RESTARTS + 1 mock processes so each
      // restart attempt gets a fresh process to emit 'exit' on.
      // The service restarts up to MAX_IOS_CAPTURE_RESTARTS (5) times before
      // giving up and emitting an 'error' on the session emitter.
      const MAX_RESTARTS = 5;
      const mockProcesses = Array.from({ length: MAX_RESTARTS + 1 }, makeMockChildProcess);
      let spawnCallIndex = 0;
      mockSpawn.mockImplementation(() => mockProcesses[spawnCallIndex++]);

      vi.useFakeTimers();
      try {
        const sessionId = 'session-ios-crash';
        const emitter = service.startCapture(sessionId, 'ios', 'UDID-CRASH');

        // Flush the promise chain (access → then → startIOSCaptureProcess) so
        // the 'exit' listener is registered on the first mock process.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const errorPromise = waitForEvent(emitter, 'error', 15_000);

        // Act — exhaust all restart attempts by firing 'exit' on each spawned process.
        // Between each exit and the next spawn there is a 1000ms setTimeout.
        for (let i = 0; i <= MAX_RESTARTS; i++) {
          mockProcesses[i]!.emit('exit', 1, null);
          // Advance fake timers so the 1000ms restart delay fires and the next
          // startIOSCaptureProcess() call runs (which calls spawn again).
          await vi.advanceTimersByTimeAsync(1100);
        }

        // Assert — after exhausting all restarts, an error is emitted.
        const error = await errorPromise;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('exhausted all 5 restart attempts');
      } finally {
        vi.useRealTimers();
      }
    });

    it('cleans up the session map when iOS capture process exits unexpectedly', async () => {
      // Arrange — same restart-exhaustion setup as the error-emission test above.
      const MAX_RESTARTS = 5;
      const mockProcesses = Array.from({ length: MAX_RESTARTS + 1 }, makeMockChildProcess);
      let spawnCallIndex = 0;
      mockSpawn.mockImplementation(() => mockProcesses[spawnCallIndex++]);

      vi.useFakeTimers();
      try {
        const sessionId = 'session-ios-crash-cleanup';
        const emitter = service.startCapture(sessionId, 'ios', 'UDID-CRASH-CLEANUP');

        // Flush promise chain so the first process is spawned.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const errorPromise = waitForEvent(emitter, 'error', 15_000);

        // Exhaust all restart attempts.
        for (let i = 0; i <= MAX_RESTARTS; i++) {
          mockProcesses[i]!.emit('exit', 1, null);
          await vi.advanceTimersByTimeAsync(1100);
        }

        await errorPromise;
      } finally {
        vi.useRealTimers();
      }

      // Assert — session is removed from the active map after all restarts fail.
      expect(service.getActiveCount()).toBe(0);
      expect(service.getEmitter('session-ios-crash-cleanup')).toBeNull();
    });

    it('emits error when the iOS capture process emits an error event', async () => {
      // Arrange — exhaust all restart attempts via the 'error' event path.
      const MAX_RESTARTS = 5;
      const mockProcesses = Array.from({ length: MAX_RESTARTS + 1 }, makeMockChildProcess);
      let spawnCallIndex = 0;
      mockSpawn.mockImplementation(() => mockProcesses[spawnCallIndex++]);

      vi.useFakeTimers();
      try {
        const sessionId = 'session-ios-spawn-error';
        const emitter = service.startCapture(sessionId, 'ios', 'UDID-SPAWN-ERR');

        // Flush promise chain so the first process is spawned.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const errorPromise = waitForEvent(emitter, 'error', 15_000);

        // Act — fire 'error' on each spawned process, advancing fake timers between
        // each attempt so the 1000ms restart delay fires.
        const spawnError = new Error('ENOENT: spawn failed');
        mockProcesses[0]!.emit('error', spawnError);
        for (let i = 1; i <= MAX_RESTARTS; i++) {
          await vi.advanceTimersByTimeAsync(1100);
          mockProcesses[i]!.emit('error', spawnError);
        }
        await vi.advanceTimersByTimeAsync(1100);

        const error = await errorPromise;

        // Assert — once all restarts are exhausted the original error is re-emitted.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('ENOENT: spawn failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not emit a double error when iOS process emits error then exit', async () => {
      // Arrange — with restart logic, emitting both 'error' and 'exit' on the same
      // process schedules two restart setTimeout calls.  We exhaust both chains and
      // verify that the session emitter fires at most 1 'error' event total.
      // Each chain needs MAX_RESTARTS + 1 = 6 processes; provision generously.
      const MAX_RESTARTS = 5;
      const mockProcesses = Array.from({ length: (MAX_RESTARTS + 1) * 2 }, makeMockChildProcess);
      let spawnCallIndex = 0;
      mockSpawn.mockImplementation(() => mockProcesses[spawnCallIndex++] ?? makeMockChildProcess());

      vi.useFakeTimers();
      try {
        const sessionId = 'session-double-error';
        const emitter = service.startCapture(sessionId, 'ios', 'UDID-DOUBLE');

        // Flush promise chain so the first process is spawned.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const errors: unknown[] = [];
        emitter.on('error', (e: unknown) => errors.push(e));

        // Act — emit both 'error' and then 'exit' on the initial process.
        // Both handlers schedule a restart since restartCount = 0 < 5.
        const spawnError = new Error('spawn ENOENT');
        mockProcesses[0]!.emit('error', spawnError);
        mockProcesses[0]!.emit('exit', null, 'SIGKILL');

        // Advance timers far enough for all chained restarts in both paths to run
        // and exhaust.  2 chains × 5 restarts × 1100ms per step = 11000ms.
        for (let tick = 0; tick < (MAX_RESTARTS + 1) * 2 + 2; tick++) {
          await vi.advanceTimersByTimeAsync(1100);
          // Trigger exit/error on any newly spawned processes so their chains
          // also exhaust without hanging.
          for (let p = 1; p < spawnCallIndex; p++) {
            const proc = mockProcesses[p];
            if (proc) {
              proc.emit('exit', 1, null);
            }
          }
        }

        // Assert — at most 1 error emitted; the second exhaustion finds
        // session.active = false and returns without emitting again.
        expect(errors.length).toBeLessThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }

      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  // -------------------------------------------------------------------------
  // getActiveCount()
  // -------------------------------------------------------------------------

  describe('getActiveCount()', () => {
    it('returns 0 when no captures are active', () => {
      expect(service.getActiveCount()).toBe(0);
    });

    it('returns the correct count as captures are started and stopped', () => {
      service.startCapture('count-a', 'ios', 'UDID-CA');
      expect(service.getActiveCount()).toBe(1);

      service.startCapture('count-b', 'android', 'emulator-5554');
      expect(service.getActiveCount()).toBe(2);

      service.stopCapture('count-a');
      expect(service.getActiveCount()).toBe(1);

      service.stopCapture('count-b');
      expect(service.getActiveCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // H.264 capture pipeline — parseH264Buffer
  // -------------------------------------------------------------------------

  /**
   * Build a Buffer containing a single H.264 frame packet in the binary protocol format.
   *
   * Protocol: [4B BE uint32 payload-length][1B flags][8B BE uint64 timestamp_us][NALU bytes]
   *
   * The payload-length covers flags (1) + timestamp (8) + NALU data — NOT the 4-byte
   * length-prefix itself.
   */
  function buildH264FramePacket(naluData: Buffer, isKeyframe: boolean, timestampUs: bigint): Buffer {
    const payloadLength = 1 + 8 + naluData.length; // flags + timestamp + nalu data
    const header = Buffer.alloc(4 + 1 + 8);         // length prefix + flags + timestamp
    header.writeUInt32BE(payloadLength, 0);
    header[4] = isKeyframe ? 0x01 : 0x00;
    header.writeBigUInt64BE(timestampUs, 5);
    return Buffer.concat([header, naluData]);
  }

  describe('H.264 capture pipeline', () => {
    it('emits nalu events for H.264 captures via persistent capture process', async () => {
      // Arrange — SPS NAL unit in Annex B format (nal_unit_type=0x67)
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
      const timestampUs = 5000000n; // 5 seconds in µs
      const packet = buildH264FramePacket(naluData, true, timestampUs);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-nalu';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-H264', 30, 'iPhone 15', 'h264');

      // Wait for ensureCaptureBinaryCompiled → startIOSCaptureProcess to run.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Register the 'nalu' listener BEFORE pushing to stdout (event fires synchronously)
      const naluPromise = waitForEvent(emitter, 'nalu');

      // Simulate the capture process emitting an H.264 frame on stdout.
      mockProcess.stdout.push(packet);

      const frame = await naluPromise;
      service.stopCapture(sessionId);

      // Assert — the nalu event payload contains the correct NaluFrame fields
      expect(frame).toBeDefined();
      const naluFrame = frame as { naluData: Buffer; isKeyframe: boolean; timestampUs: bigint };
      expect(Buffer.isBuffer(naluFrame.naluData)).toBe(true);
      expect(naluFrame.naluData.equals(naluData)).toBe(true);
      expect(naluFrame.isKeyframe).toBe(true);
      expect(naluFrame.timestampUs).toBe(timestampUs);
    });

    it('does NOT emit frame events for H.264 captures — only nalu events', async () => {
      // Arrange — H.264 mode must use 'nalu' not 'frame'
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]); // IDR slice
      const packet = buildH264FramePacket(naluData, true, 1000000n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-no-frame';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-H264-NF', 30, 'iPhone 15', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      let frameFired = false;
      emitter.on('frame', () => { frameFired = true; });

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);
      await naluPromise;

      service.stopCapture(sessionId);

      // Assert — no 'frame' event was emitted
      expect(frameFired).toBe(false);
    });

    it('correctly parses keyframe flag — true when bit 0 of flags byte is set', async () => {
      // Arrange — flags byte = 0x01
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]); // IDR NAL type
      const packet = buildH264FramePacket(naluData, true, 1000n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-keyframe-true';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-KF-TRUE', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);
      const frame = (await naluPromise) as { isKeyframe: boolean };
      service.stopCapture(sessionId);

      // Assert
      expect(frame.isKeyframe).toBe(true);
    });

    it('correctly parses keyframe flag — false when bit 0 of flags byte is clear', async () => {
      // Arrange — flags byte = 0x00 (non-keyframe P-frame)
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]); // non-IDR NAL type
      const packet = buildH264FramePacket(naluData, false, 2000n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-keyframe-false';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-KF-FALSE', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);
      const frame = (await naluPromise) as { isKeyframe: boolean };
      service.stopCapture(sessionId);

      // Assert
      expect(frame.isKeyframe).toBe(false);
    });

    it('correctly parses 64-bit timestamps beyond 32-bit range', async () => {
      // Arrange — 123456789012345 µs exceeds 32-bit max (~4.29 billion)
      const timestampUs = 123456789012345n;
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]);
      const packet = buildH264FramePacket(naluData, false, timestampUs);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-timestamp';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-TS', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);
      const frame = (await naluPromise) as { timestampUs: bigint };
      service.stopCapture(sessionId);

      // Assert — the full 64-bit bigint is correctly reconstructed from two 32-bit reads
      expect(frame.timestampUs).toBe(timestampUs);
    });

    it('correctly parses a timestamp of zero', async () => {
      // Arrange — edge case: timestamp = 0n
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]);
      const packet = buildH264FramePacket(naluData, true, 0n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-ts-zero';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-TS-0', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);
      const frame = (await naluPromise) as { timestampUs: bigint };
      service.stopCapture(sessionId);

      // Assert
      expect(frame.timestampUs).toBe(0n);
    });

    it('handles split H.264 packet across multiple stdout chunks', async () => {
      // Arrange — build a full packet and split it at a mid-packet boundary
      const innerNaluBytes = Buffer.alloc(50, 0xab);
      const naluData = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), innerNaluBytes]);
      const fullPacket = buildH264FramePacket(naluData, false, 99999n);

      // Split at byte 7: inside the 13-byte header (4 length + 1 flags + 8 timestamp)
      const chunk1 = fullPacket.subarray(0, 7);
      const chunk2 = fullPacket.subarray(7);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-split';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-SPLIT-H264', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');

      // Push two chunks separately — service must buffer and reassemble
      mockProcess.stdout.push(chunk1);
      mockProcess.stdout.push(chunk2);

      const frame = await naluPromise;
      service.stopCapture(sessionId);

      // Assert — exactly one complete nalu event with the correct reassembled data
      const naluFrame = frame as { naluData: Buffer; isKeyframe: boolean; timestampUs: bigint };
      expect(naluFrame.naluData.equals(naluData)).toBe(true);
      expect(naluFrame.isKeyframe).toBe(false);
      expect(naluFrame.timestampUs).toBe(99999n);
    });

    it('handles H.264 packet split within the 4-byte length prefix', async () => {
      // Arrange — split right after the first 2 bytes (inside the length field)
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
      const fullPacket = buildH264FramePacket(naluData, true, 1234n);

      const chunk1 = fullPacket.subarray(0, 2);  // 2 bytes of the 4-byte length
      const chunk2 = fullPacket.subarray(2);     // rest: remaining length + flags + ts + nalu

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-split-header';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-SPLIT-HDR', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(chunk1);
      mockProcess.stdout.push(chunk2);

      const frame = await naluPromise;
      service.stopCapture(sessionId);

      // Assert
      const naluFrame = frame as { naluData: Buffer; timestampUs: bigint };
      expect(naluFrame.naluData.equals(naluData)).toBe(true);
      expect(naluFrame.timestampUs).toBe(1234n);
    });

    it('parses multiple H.264 frames from a single stdout chunk', async () => {
      // Arrange — build 3 separate H.264 packets and concatenate them into one chunk
      const nalu1 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]); // SPS
      const nalu2 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80]); // PPS
      const nalu3 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]); // IDR

      const combined = Buffer.concat([
        buildH264FramePacket(nalu1, true, 1000n),
        buildH264FramePacket(nalu2, false, 2000n),
        buildH264FramePacket(nalu3, false, 3000n),
      ]);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-multi';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-MULTI-H264', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const receivedFrames: Array<{ naluData: Buffer; isKeyframe: boolean; timestampUs: bigint }> = [];
      emitter.on('nalu', (f: unknown) => {
        receivedFrames.push(f as { naluData: Buffer; isKeyframe: boolean; timestampUs: bigint });
      });

      // Act — push all 3 packets in a single stdout chunk
      mockProcess.stdout.push(combined);

      // Give the event loop a tick to flush all synchronous handlers
      await new Promise(resolve => setTimeout(resolve, 10));
      service.stopCapture(sessionId);

      // Assert — all 3 frames parsed and emitted as separate nalu events
      expect(receivedFrames.length).toBe(3);
      expect(receivedFrames[0]!.naluData.equals(nalu1)).toBe(true);
      expect(receivedFrames[0]!.isKeyframe).toBe(true);
      expect(receivedFrames[0]!.timestampUs).toBe(1000n);
      expect(receivedFrames[1]!.naluData.equals(nalu2)).toBe(true);
      expect(receivedFrames[1]!.isKeyframe).toBe(false);
      expect(receivedFrames[1]!.timestampUs).toBe(2000n);
      expect(receivedFrames[2]!.naluData.equals(nalu3)).toBe(true);
      expect(receivedFrames[2]!.isKeyframe).toBe(false);
      expect(receivedFrames[2]!.timestampUs).toBe(3000n);
    });

    it('spawns the capture binary with --format h264 args when captureFormat is h264', async () => {
      // Arrange
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act — start capture explicitly with the h264 format
      service.startCapture('session-h264-spawn-args', 'ios', 'UDID-H264-ARGS', 30, 'Test Device', 'h264');

      // Yield so the promise chain resolves
      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — spawn was called with '--format' and 'h264' in the args array
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-capture-stream'),
        expect.arrayContaining(['--format', 'h264']),
        expect.any(Object),
      );
    });

    it('does NOT pass --format flag when captureFormat is jpeg', async () => {
      // Arrange
      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      // Act — start capture with the default jpeg format
      service.startCapture('session-jpeg-no-flag', 'ios', 'UDID-JPEG-ARGS', 30, 'Test Device', 'jpeg');
      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — spawn args must NOT include 'h264'
      const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
      expect(spawnArgs).toBeDefined();
      expect(spawnArgs).not.toContain('h264');
    });

    it('sends K\\n to stdin when requestKeyframe is called', async () => {
      // Arrange — spy on stdin.write to capture what is written
      const writtenChunks: string[] = [];
      const mockProcess = makeMockChildProcess();
      vi.spyOn(mockProcess.stdin, 'write').mockImplementation((chunk: unknown) => {
        writtenChunks.push(String(chunk));
        return true;
      });

      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-keyframe-request';
      service.startCapture(sessionId, 'ios', 'UDID-KF-REQ', 30, 'Test Device', 'h264');

      // Wait for the process to be spawned so captureProcess is set on the session
      await new Promise(resolve => setTimeout(resolve, 0));

      // Act — request a keyframe
      service.requestKeyframe(sessionId);

      service.stopCapture(sessionId);

      // Assert — 'K\n' was written to stdin
      expect(writtenChunks).toContain('K\n');
    });

    it('requestKeyframe is a no-op when no capture is running for that sessionId', () => {
      // Act & Assert — must not throw even with unknown sessionId
      expect(() => service.requestKeyframe('nonexistent-session-h264')).not.toThrow();
    });

    it('does not emit nalu events after stopCapture is called', async () => {
      // Arrange
      const naluData = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]);
      const packet = buildH264FramePacket(naluData, true, 1000n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-stop-no-nalu';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-STOP-NALU', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      let naluCount = 0;
      emitter.on('nalu', () => { naluCount++; });

      // Stop BEFORE pushing data
      service.stopCapture(sessionId);

      // Push data after stopping — session.active is false, so no event should fire
      mockProcess.stdout.push(packet);

      // Give the event loop a tick
      await new Promise(resolve => setTimeout(resolve, 10));

      // Assert — no nalu event was emitted
      expect(naluCount).toBe(0);
    });

    it('correctly handles large NALU payloads (> 1 KB)', async () => {
      // Arrange — 2000-byte NALU payload tests that the parser handles large data
      const innerPayload = Buffer.alloc(2000, 0xcc);
      const naluData = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65]), innerPayload]);
      const packet = buildH264FramePacket(naluData, true, 9999999999n);

      const mockProcess = makeMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const sessionId = 'session-h264-large';
      const emitter = service.startCapture(sessionId, 'ios', 'UDID-LARGE', 30, 'Test', 'h264');
      await new Promise(resolve => setTimeout(resolve, 0));

      const naluPromise = waitForEvent(emitter, 'nalu');
      mockProcess.stdout.push(packet);

      const frame = await naluPromise;
      service.stopCapture(sessionId);

      // Assert — all bytes are correctly transmitted through the parser
      const naluFrame = frame as { naluData: Buffer; timestampUs: bigint };
      expect(naluFrame.naluData.length).toBe(naluData.length);
      expect(naluFrame.naluData.equals(naluData)).toBe(true);
      expect(naluFrame.timestampUs).toBe(9999999999n);
    });
  });
});
