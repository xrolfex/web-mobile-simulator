/**
 * Tests for SessionManagerService (Phase 3B-3)
 *
 * NODE_ENV is set to 'test' automatically by Vitest, which means:
 *   - The constructor skips initDb()
 *   - persistSession() is a no-op
 *
 * All external dependencies are mocked at the module level before any imports.
 */

// ---------------------------------------------------------------------------
// All vi.mock() calls MUST come before any imports
// ---------------------------------------------------------------------------

// Mock exec utilities
vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execJSON: vi.fn(),
}));

// Mock config — mutable object so individual tests can override values
const mockConfig = {
  maxConcurrentSessions: 6,
  maxSessionsPerPlatform: 0,
  sessionMemoryEvictionMs: 15 * 60 * 1000,
  androidSdkRoot: '/mock/android/sdk',
  iosWarmPoolSize: 0,
};
vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

// Mock iOS simulator service
vi.mock('./ios-simulator.js', () => ({
  iosSimulatorService: {
    createDevice: vi.fn(),
    bootDevice: vi.fn(),
    shutdownDevice: vi.fn(),
    deleteDevice: vi.fn(),
    listDevices: vi.fn(),
    openSimulatorApp: vi.fn(),
  },
}));

// Mock Android emulator service
vi.mock('./android-emulator.js', () => ({
  androidEmulatorService: {
    createAVD: vi.fn(),
    bootEmulator: vi.fn(),
    shutdownEmulator: vi.fn(),
    deleteAVD: vi.fn(),
    listAVDs: vi.fn(),
    getAdbPort: vi.fn(),
  },
}));

// Mock screen capture service
vi.mock('./screen-capture.js', () => ({
  screenCaptureService: {
    startCapture: vi.fn().mockReturnValue({
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    }),
    stopCapture: vi.fn(),
    cleanup: vi.fn(),
  },
}));

// Mock event bus service
vi.mock('./event-bus.js', () => ({
  eventBusService: {
    emit: vi.fn(),
  },
}));

// Mock database modules (no-ops in test, but must be resolvable)
vi.mock('../db/migrate.js', () => ({
  initializeDatabase: vi.fn(),
}));

vi.mock('../db/session-repository.js', () => ({
  sessionRepository: {
    create: vi.fn(),
    update: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock calls)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManagerService, SessionCapacityError } from './session-manager.js';
import { iosSimulatorService } from './ios-simulator.js';
import { androidEmulatorService } from './android-emulator.js';
import { screenCaptureService } from './screen-capture.js';
import { eventBusService } from './event-bus.js';
import { execJSON } from '../utils/exec.js';

// ---------------------------------------------------------------------------
// Type helpers for mocked functions
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof vi.fn>;

function asMock(fn: unknown): MockFn {
  return fn as MockFn;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const IOS_REQUEST = {
  platform: 'ios' as const,
  runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
  deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
};

const ANDROID_REQUEST = {
  platform: 'android' as const,
  runtimeId: 'system-images;android-34;google_apis;arm64-v8a',
  deviceTypeId: 'pixel_8',
};

// ---------------------------------------------------------------------------
// Mock setup helpers
// ---------------------------------------------------------------------------

function mockSuccessfulIOSCreation(): void {
  asMock(iosSimulatorService.createDevice).mockResolvedValue('MOCK-UDID-1234');
  asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);
  // screenCaptureService.startCapture already has a default mock return value
}

function mockSuccessfulAndroidCreation(): void {
  asMock(androidEmulatorService.createAVD).mockResolvedValue('wms_session_mock');
  asMock(androidEmulatorService.bootEmulator).mockResolvedValue({
    pid: 1234,
    adbPort: 5554,
  });
  // screenCaptureService.startCapture already has a default mock return value
}

// ---------------------------------------------------------------------------
// Deferred promise helper (for mutex tests)
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createService(): SessionManagerService {
  return new SessionManagerService();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('SessionManagerService', () => {
  let service: SessionManagerService;

  beforeEach(() => {
    // Reset all mocks to a clean state
    vi.clearAllMocks();

    // Reset mockConfig to safe defaults before each test
    mockConfig.maxConcurrentSessions = 6;
    mockConfig.maxSessionsPerPlatform = 0;
    mockConfig.sessionMemoryEvictionMs = 15 * 60 * 1000;
    mockConfig.iosWarmPoolSize = 0;

    // Suppress noisy console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    service = createService();
  });

  afterEach(async () => {
    // Always clean up to clear setInterval timers and avoid leaks
    await service.cleanup();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. createSession — iOS flow
  // =========================================================================

  describe('createSession — iOS flow', () => {
    it('creates an iOS session with status=active and streamUrl set', async () => {
      mockSuccessfulIOSCreation();

      const session = await service.createSession(IOS_REQUEST);

      expect(session.status).toBe('active');
      expect(session.streamUrl).toBe(`/ws/stream/${session.id}`);
      expect(session.device.platform).toBe('ios');
    });

    it('populates device with the UDID returned by createDevice', async () => {
      mockSuccessfulIOSCreation();

      const session = await service.createSession(IOS_REQUEST);

      expect(session.device.id).toBe('MOCK-UDID-1234');
      expect(session.device.platformDeviceId).toBe('MOCK-UDID-1234');
    });

    it('calls createDevice, bootDevice, startCapture in the correct order', async () => {
      mockSuccessfulIOSCreation();

      await service.createSession(IOS_REQUEST);

      const createOrder = asMock(iosSimulatorService.createDevice).mock.invocationCallOrder[0]!;
      const bootOrder = asMock(iosSimulatorService.bootDevice).mock.invocationCallOrder[0]!;
      const captureOrder = asMock(screenCaptureService.startCapture).mock.invocationCallOrder[0]!;

      expect(createOrder).toBeLessThan(bootOrder);
      expect(bootOrder).toBeLessThan(captureOrder);
    });

    it('emits session_status_changed events for creating → active transitions', async () => {
      mockSuccessfulIOSCreation();

      await service.createSession(IOS_REQUEST);

      const emitMock = asMock(eventBusService.emit);
      expect(emitMock).toHaveBeenCalledTimes(2);

      // First emission: creating (initial placeholder emitted as creating→creating,
      // which represents the "session is now in creating state" event)
      const firstCall = emitMock.mock.calls[0]!;
      expect(firstCall[0]).toBe('session_status_changed');
      expect((firstCall[1] as { status: string }).status).toBe('creating');

      // Second emission: active
      const secondCall = emitMock.mock.calls[1]!;
      expect(secondCall[0]).toBe('session_status_changed');
      expect((secondCall[1] as { status: string }).status).toBe('active');
      expect((secondCall[1] as { previousStatus: string }).previousStatus).toBe('creating');
    });

    it('sets status=error and calls cleanupFailedSession when bootDevice fails', async () => {
      asMock(iosSimulatorService.createDevice).mockResolvedValue('MOCK-UDID-ERR');
      asMock(iosSimulatorService.bootDevice).mockRejectedValue(new Error('boot failed'));
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow('boot failed');

      const sessions = (service as unknown as { sessions: Map<string, { status: string }> })
        .sessions;
      const session = [...sessions.values()][0]!;
      expect(session.status).toBe('error');

      // stopCapture should have been called for cleanup
      expect(asMock(screenCaptureService.stopCapture)).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. createSession — Android flow
  // =========================================================================

  describe('createSession — Android flow', () => {
    it('creates an Android session with status=active and streamUrl set', async () => {
      mockSuccessfulAndroidCreation();

      const session = await service.createSession(ANDROID_REQUEST);

      expect(session.status).toBe('active');
      expect(session.streamUrl).toBe(`/ws/stream/${session.id}`);
      expect(session.device.platform).toBe('android');
    });

    it('calls createAVD, bootEmulator, startCapture in the correct order', async () => {
      mockSuccessfulAndroidCreation();

      await service.createSession(ANDROID_REQUEST);

      const createOrder =
        asMock(androidEmulatorService.createAVD).mock.invocationCallOrder[0]!;
      const bootOrder =
        asMock(androidEmulatorService.bootEmulator).mock.invocationCallOrder[0]!;
      const captureOrder = asMock(screenCaptureService.startCapture).mock.invocationCallOrder[0]!;

      expect(createOrder).toBeLessThan(bootOrder);
      expect(bootOrder).toBeLessThan(captureOrder);
    });

    it('sets status=error and runs cleanup when bootEmulator fails', async () => {
      asMock(androidEmulatorService.createAVD).mockResolvedValue('wms_session_fail');
      asMock(androidEmulatorService.bootEmulator).mockRejectedValue(
        new Error('emulator boot failed'),
      );
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(androidEmulatorService.shutdownEmulator).mockResolvedValue(undefined);
      asMock(androidEmulatorService.deleteAVD).mockResolvedValue(undefined);

      await expect(service.createSession(ANDROID_REQUEST)).rejects.toThrow(
        'emulator boot failed',
      );

      const sessions = (service as unknown as { sessions: Map<string, { status: string }> })
        .sessions;
      const session = [...sessions.values()][0]!;
      expect(session.status).toBe('error');

      expect(asMock(screenCaptureService.stopCapture)).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Creation mutex
  // =========================================================================

  describe('creation mutex', () => {
    it('serialises two concurrent createSession calls — second waits for first', async () => {
      const firstDeferred = deferred<string>();

      let createDeviceCallCount = 0;
      asMock(iosSimulatorService.createDevice).mockImplementation(() => {
        createDeviceCallCount++;
        if (createDeviceCallCount === 1) {
          // First call returns a slow promise
          return firstDeferred.promise;
        }
        return Promise.resolve('MOCK-UDID-SECOND');
      });

      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);

      // Fire both without awaiting
      const first = service.createSession(IOS_REQUEST);
      const second = service.createSession(IOS_REQUEST);

      // Yield so the event loop can start the first creation
      await Promise.resolve();
      await Promise.resolve();

      // Only 1 createDevice should have been called (second is blocked)
      expect(createDeviceCallCount).toBe(1);

      // Resolve the first device creation
      firstDeferred.resolve('MOCK-UDID-FIRST');

      // Now let both complete
      await first;
      await second;

      // Both creations should have run
      expect(createDeviceCallCount).toBe(2);
    });

    it('allows second creation to proceed even if first throws', async () => {
      let callCount = 0;
      asMock(iosSimulatorService.createDevice).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('first failed'));
        }
        return Promise.resolve('MOCK-UDID-SECOND');
      });

      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      const first = service.createSession(IOS_REQUEST);
      const second = service.createSession(IOS_REQUEST);

      await expect(first).rejects.toThrow('first failed');
      const secondSession = await second;
      expect(secondSession.status).toBe('active');
    });

    it('releases the mutex even when creation throws', async () => {
      asMock(iosSimulatorService.createDevice).mockRejectedValue(
        new Error('create failed'),
      );
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow('create failed');

      // After the failure, set up for a successful second creation
      mockSuccessfulIOSCreation();

      // This should not hang (mutex was released)
      const session = await service.createSession(IOS_REQUEST);
      expect(session.status).toBe('active');
    });
  });

  // =========================================================================
  // 4. Concurrent session cap
  // =========================================================================

  describe('concurrent session cap', () => {
    /** Helper: inject a pre-built session directly into the in-memory Map */
    function injectSession(
      id: string,
      platform: 'ios' | 'android',
      status: 'creating' | 'active' | 'terminated' | 'error',
    ): void {
      const sessions = (
        service as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set(id, {
        id,
        status,
        device: {
          id: id,
          platformDeviceId: id,
          platform,
          deviceType: { id: 'dt', name: 'dt', platform, modelName: 'dt', modelIdentifier: 'dt' },
          runtime: {
            id: 'rt',
            platform,
            version: '1.0',
            identifier: 'rt',
            status: 'installed',
          },
          state: 'booted',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    it('throws SessionCapacityError with code=CAPACITY_GLOBAL when at global limit', async () => {
      mockConfig.maxConcurrentSessions = 2;

      injectSession('s1', 'ios', 'active');
      injectSession('s2', 'ios', 'active');

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow(
        SessionCapacityError,
      );

      try {
        await service.createSession(IOS_REQUEST);
      } catch (err) {
        expect(err).toBeInstanceOf(SessionCapacityError);
        expect((err as SessionCapacityError).code).toBe('CAPACITY_GLOBAL');
      }
    });

    it('does NOT throw when below the global limit', async () => {
      mockConfig.maxConcurrentSessions = 3;

      injectSession('s1', 'ios', 'active');
      injectSession('s2', 'ios', 'active');
      // 2 active < limit of 3 — should succeed
      mockSuccessfulIOSCreation();

      const session = await service.createSession(IOS_REQUEST);
      expect(session.status).toBe('active');
    });

    it('respects maxConcurrentSessions=0 as unlimited', async () => {
      mockConfig.maxConcurrentSessions = 0;

      // Fill 10 sessions — should still not throw
      for (let i = 0; i < 10; i++) {
        injectSession(`s${i}`, 'ios', 'active');
      }

      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);
      expect(session.status).toBe('active');
    });

    it('throws SessionCapacityError with code=CAPACITY_PLATFORM at per-platform limit', async () => {
      mockConfig.maxConcurrentSessions = 10;
      mockConfig.maxSessionsPerPlatform = 2;

      injectSession('s1', 'ios', 'active');
      injectSession('s2', 'ios', 'active');

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow(
        SessionCapacityError,
      );

      try {
        await service.createSession(IOS_REQUEST);
      } catch (err) {
        expect(err).toBeInstanceOf(SessionCapacityError);
        expect((err as SessionCapacityError).code).toBe('CAPACITY_PLATFORM');
      }
    });

    it('respects maxSessionsPerPlatform=0 as unlimited per-platform', async () => {
      mockConfig.maxConcurrentSessions = 20;
      mockConfig.maxSessionsPerPlatform = 0;

      for (let i = 0; i < 8; i++) {
        injectSession(`s${i}`, 'ios', 'active');
      }

      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);
      expect(session.status).toBe('active');
    });

    it('SessionCapacityError has correct currentCount and maxCount', async () => {
      mockConfig.maxConcurrentSessions = 3;

      injectSession('s1', 'ios', 'active');
      injectSession('s2', 'android', 'active');
      injectSession('s3', 'ios', 'creating');

      let error: SessionCapacityError | null = null;
      try {
        await service.createSession(IOS_REQUEST);
      } catch (err) {
        error = err as SessionCapacityError;
      }

      expect(error).not.toBeNull();
      expect(error!.currentCount).toBe(3);
      expect(error!.maxCount).toBe(3);
    });
  });

  // =========================================================================
  // 5. getCapacityInfo
  // =========================================================================

  describe('getCapacityInfo', () => {
    function injectSession(
      id: string,
      platform: 'ios' | 'android',
      status: 'creating' | 'active' | 'terminated' | 'error',
    ): void {
      const sessions = (
        service as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set(id, {
        id,
        status,
        device: {
          id,
          platformDeviceId: id,
          platform,
          deviceType: { id: 'dt', name: 'dt', platform, modelName: 'dt', modelIdentifier: 'dt' },
          runtime: {
            id: 'rt',
            platform,
            version: '1.0',
            identifier: 'rt',
            status: 'installed',
          },
          state: 'booted',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    it('returns activeSessions=0 when no sessions exist', () => {
      const info = service.getCapacityInfo();
      expect(info.activeSessions).toBe(0);
    });

    it('counts only creating and active sessions (not terminated/error)', () => {
      injectSession('active-ios', 'ios', 'active');
      injectSession('creating-android', 'android', 'creating');
      injectSession('terminated-ios', 'ios', 'terminated');
      injectSession('error-android', 'android', 'error');

      const info = service.getCapacityInfo();
      expect(info.activeSessions).toBe(2);
    });

    it('returns correct maxConcurrentSessions from config', () => {
      mockConfig.maxConcurrentSessions = 8;

      const info = service.getCapacityInfo();
      expect(info.maxConcurrentSessions).toBe(8);
    });

    it('returns correct per-platform breakdown', () => {
      injectSession('ios-1', 'ios', 'active');
      injectSession('ios-2', 'ios', 'creating');
      injectSession('android-1', 'android', 'active');

      const info = service.getCapacityInfo();
      expect(info.perPlatform.ios.active).toBe(2);
      expect(info.perPlatform.android.active).toBe(1);
    });
  });

  // =========================================================================
  // 6. terminateSession
  // =========================================================================

  describe('terminateSession', () => {
    it('terminates an active iOS session through terminating→terminated', async () => {
      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.terminateSession(session.id);

      const terminated = service.getSession(session.id);
      expect(terminated?.status).toBe('terminated');
    });

    it('calls stopCapture and teardown (shutdownDevice + deleteDevice) for iOS', async () => {
      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.terminateSession(session.id);

      expect(asMock(screenCaptureService.stopCapture)).toHaveBeenCalledWith(session.id);
      expect(asMock(iosSimulatorService.shutdownDevice)).toHaveBeenCalledWith(
        'MOCK-UDID-1234',
      );
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith(
        'MOCK-UDID-1234',
      );
    });

    it('throws an error if session is not found', async () => {
      await expect(
        service.terminateSession('non-existent-session-id'),
      ).rejects.toThrow('Session not found: non-existent-session-id');
    });

    it('emits status change events during termination (active→terminating→terminated)', async () => {
      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      // Clear previous emit calls from creation
      asMock(eventBusService.emit).mockClear();

      await service.terminateSession(session.id);

      const emitMock = asMock(eventBusService.emit);
      expect(emitMock).toHaveBeenCalledTimes(2);

      const firstCall = emitMock.mock.calls[0]!;
      expect((firstCall[1] as { status: string }).status).toBe('terminating');

      const secondCall = emitMock.mock.calls[1]!;
      expect((secondCall[1] as { status: string }).status).toBe('terminated');
      expect((secondCall[1] as { previousStatus: string }).previousStatus).toBe('terminating');
    });
  });

  // =========================================================================
  // 7. cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('terminates all active and creating sessions', async () => {
      mockSuccessfulIOSCreation();
      const session1 = await service.createSession(IOS_REQUEST);

      // Reset mock for second creation
      asMock(iosSimulatorService.createDevice).mockResolvedValue('MOCK-UDID-5678');
      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);

      const session2 = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      // Create a fresh service for this specific test so afterEach cleanup
      // doesn't interfere; note: afterEach already calls cleanup on `service`
      // which is what we're testing here.
      await service.cleanup();

      const s1 = service.getSession(session1.id);
      const s2 = service.getSession(session2.id);
      expect(s1?.status).toBe('terminated');
      expect(s2?.status).toBe('terminated');
    });

    it('calls screenCaptureService.cleanup() at the end of global cleanup', async () => {
      mockSuccessfulIOSCreation();
      await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.cleanup();

      expect(asMock(screenCaptureService.cleanup)).toHaveBeenCalled();
    });

    it('clears both the timeout and eviction intervals', () => {
      // Verify internal handles exist (set in constructor)
      const svc = service as unknown as {
        timeoutCheckInterval: unknown;
        evictionCheckInterval: unknown;
      };

      // Before cleanup they should be set
      expect(svc.timeoutCheckInterval).not.toBeNull();
      expect(svc.evictionCheckInterval).not.toBeNull();

      // Call cleanup synchronously via void — the interval clearing is sync
      void service.cleanup();

      // After cleanup they should be null
      expect(svc.timeoutCheckInterval).toBeNull();
      expect(svc.evictionCheckInterval).toBeNull();
    });

    it('does not throw if termination of a session fails during cleanup', async () => {
      mockSuccessfulIOSCreation();
      await service.createSession(IOS_REQUEST);

      // Make stopCapture throw to simulate failure
      asMock(screenCaptureService.stopCapture).mockImplementation(() => {
        throw new Error('capture stop error');
      });
      asMock(iosSimulatorService.shutdownDevice).mockRejectedValue(
        new Error('shutdown error'),
      );
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      // cleanup should not throw
      await expect(service.cleanup()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 8. Memory eviction
  // =========================================================================

  describe('memory eviction', () => {
    const EVICTION_MS = 15 * 60 * 1000; // 15 minutes

    function injectSessionWithAge(
      id: string,
      status: 'terminated' | 'error' | 'active',
      ageMs: number,
    ): void {
      const sessions = (
        service as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      const updatedAt = new Date(Date.now() - ageMs).toISOString();
      sessions.set(id, {
        id,
        status,
        device: {
          id,
          platformDeviceId: id,
          platform: 'ios',
          deviceType: {
            id: 'dt',
            name: 'dt',
            platform: 'ios',
            modelName: 'dt',
            modelIdentifier: 'dt',
          },
          runtime: {
            id: 'rt',
            platform: 'ios',
            version: '1.0',
            identifier: 'rt',
            status: 'installed',
          },
          state: 'booted',
        },
        createdAt: updatedAt,
        updatedAt,
      });
    }

    it('evicts terminated sessions older than sessionMemoryEvictionMs', () => {
      mockConfig.sessionMemoryEvictionMs = EVICTION_MS;
      injectSessionWithAge('old-terminated', 'terminated', EVICTION_MS + 1000);

      const svc = service as unknown as {
        evictStaleMemorySessions: () => void;
        sessions: Map<string, unknown>;
      };
      svc.evictStaleMemorySessions();

      expect(svc.sessions.has('old-terminated')).toBe(false);
    });

    it('evicts error sessions older than sessionMemoryEvictionMs', () => {
      mockConfig.sessionMemoryEvictionMs = EVICTION_MS;
      injectSessionWithAge('old-error', 'error', EVICTION_MS + 1000);

      const svc = service as unknown as {
        evictStaleMemorySessions: () => void;
        sessions: Map<string, unknown>;
      };
      svc.evictStaleMemorySessions();

      expect(svc.sessions.has('old-error')).toBe(false);
    });

    it('does NOT evict active sessions regardless of age', () => {
      mockConfig.sessionMemoryEvictionMs = EVICTION_MS;
      injectSessionWithAge('old-active', 'active', EVICTION_MS + 1000);

      const svc = service as unknown as {
        evictStaleMemorySessions: () => void;
        sessions: Map<string, unknown>;
      };
      svc.evictStaleMemorySessions();

      // Active session should remain
      expect(svc.sessions.has('old-active')).toBe(true);
    });

    it('does NOT evict recently terminated sessions within TTL', () => {
      mockConfig.sessionMemoryEvictionMs = EVICTION_MS;
      // Only 1 minute old — well within the 15-minute TTL
      injectSessionWithAge('recent-terminated', 'terminated', 60 * 1000);

      const svc = service as unknown as {
        evictStaleMemorySessions: () => void;
        sessions: Map<string, unknown>;
      };
      svc.evictStaleMemorySessions();

      expect(svc.sessions.has('recent-terminated')).toBe(true);
    });
  });

  // =========================================================================
  // 9. Orphan cleanup — iOS
  // =========================================================================

  describe('orphan cleanup — iOS', () => {
    const SIMCTL_OUTPUT = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
          {
            udid: 'ORPHAN-UDID-0001',
            name: 'wms-session-abcd1234',
            state: 'Shutdown',
            isAvailable: true,
          },
          {
            udid: 'ORPHAN-UDID-0002',
            name: 'wms-session-booted5678',
            state: 'Booted',
            isAvailable: true,
          },
          {
            udid: 'NON-WMS-UDID-0003',
            name: 'iPhone 15',
            state: 'Shutdown',
            isAvailable: true,
          },
        ],
      },
    };

    beforeEach(() => {
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);
    });

    it('deletes iOS devices matching the wms-session- prefix that are not tracked', async () => {
      asMock(execJSON).mockResolvedValue(SIMCTL_OUTPUT);

      await service.cleanupOrphanDevices();

      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith(
        'ORPHAN-UDID-0001',
      );
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith(
        'ORPHAN-UDID-0002',
      );
    });

    it('skips devices that do not match the wms-session- prefix', async () => {
      asMock(execJSON).mockResolvedValue(SIMCTL_OUTPUT);

      await service.cleanupOrphanDevices();

      expect(asMock(iosSimulatorService.deleteDevice)).not.toHaveBeenCalledWith(
        'NON-WMS-UDID-0003',
      );
    });

    it('shuts down booted orphan devices before deleting them', async () => {
      asMock(execJSON).mockResolvedValue(SIMCTL_OUTPUT);

      await service.cleanupOrphanDevices();

      // ORPHAN-UDID-0002 is 'Booted' — should call shutdown before delete
      const shutdownOrder =
        asMock(iosSimulatorService.shutdownDevice).mock.invocationCallOrder[0]!;
      // Find the delete call for ORPHAN-UDID-0002
      const deleteCall = asMock(iosSimulatorService.deleteDevice).mock.calls.find(
        (c) => c[0] === 'ORPHAN-UDID-0002',
      );
      expect(deleteCall).toBeDefined();
      expect(asMock(iosSimulatorService.shutdownDevice)).toHaveBeenCalledWith(
        'ORPHAN-UDID-0002',
      );

      const deleteOrder = asMock(
        iosSimulatorService.deleteDevice,
      ).mock.invocationCallOrder.find(
        (_, i) =>
          asMock(iosSimulatorService.deleteDevice).mock.calls[i]?.[0] === 'ORPHAN-UDID-0002',
      )!;
      expect(shutdownOrder).toBeLessThan(deleteOrder);
    });

    it('handles scan errors gracefully and does not throw', async () => {
      asMock(execJSON).mockRejectedValue(new Error('xcrun not available'));

      await expect(service.cleanupOrphanDevices()).resolves.not.toThrow();
    });

    it('skips tracked iOS devices that are already in the sessions map', async () => {
      // Inject a tracked session with a known UDID
      const sessions = (
        service as unknown as {
          sessions: Map<string, { _iosUdid?: string; status: string; device: unknown }>
        }
      ).sessions;
      sessions.set('tracked-session', {
        _iosUdid: 'ORPHAN-UDID-0001',
        status: 'active',
        device: {
          id: 'ORPHAN-UDID-0001',
          platformDeviceId: 'ORPHAN-UDID-0001',
          platform: 'ios',
          deviceType: { id: 'dt', name: 'dt', platform: 'ios', modelName: 'dt', modelIdentifier: 'dt' },
          runtime: { id: 'rt', platform: 'ios', version: '1.0', identifier: 'rt', status: 'installed' },
          state: 'booted',
        },
      });

      asMock(execJSON).mockResolvedValue(SIMCTL_OUTPUT);

      await service.cleanupOrphanDevices();

      // ORPHAN-UDID-0001 is now tracked — should NOT be deleted
      expect(asMock(iosSimulatorService.deleteDevice)).not.toHaveBeenCalledWith(
        'ORPHAN-UDID-0001',
      );
      // ORPHAN-UDID-0002 is untracked — should still be deleted
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith(
        'ORPHAN-UDID-0002',
      );
    });
  });

  // =========================================================================
  // 10. Orphan cleanup — Android
  // =========================================================================

  describe('orphan cleanup — Android', () => {
    const ORPHAN_AVDS = [
      {
        id: 'wms_session_aabbccdd',
        platformDeviceId: 'wms_session_aabbccdd',
        platform: 'android' as const,
        state: 'shutdown' as const,
        deviceType: { id: 'dt', name: 'dt', platform: 'android' as const, modelName: 'dt', modelIdentifier: 'dt' },
        runtime: { id: 'rt', platform: 'android' as const, version: '1.0', identifier: 'rt', status: 'installed' as const },
      },
      {
        id: 'wms_session_booted1122',
        platformDeviceId: 'wms_session_booted1122',
        platform: 'android' as const,
        state: 'booted' as const,
        deviceType: { id: 'dt', name: 'dt', platform: 'android' as const, modelName: 'dt', modelIdentifier: 'dt' },
        runtime: { id: 'rt', platform: 'android' as const, version: '1.0', identifier: 'rt', status: 'installed' as const },
      },
      {
        id: 'unrelated-avd',
        platformDeviceId: 'unrelated-avd',
        platform: 'android' as const,
        state: 'shutdown' as const,
        deviceType: { id: 'dt', name: 'dt', platform: 'android' as const, modelName: 'dt', modelIdentifier: 'dt' },
        runtime: { id: 'rt', platform: 'android' as const, version: '1.0', identifier: 'rt', status: 'installed' as const },
      },
    ];

    beforeEach(() => {
      asMock(androidEmulatorService.shutdownEmulator).mockResolvedValue(undefined);
      asMock(androidEmulatorService.deleteAVD).mockResolvedValue(undefined);
      asMock(execJSON).mockResolvedValue({ devices: {} }); // iOS scan: no iOS orphans
    });

    it('deletes Android AVDs matching the wms_session_ prefix that are not tracked', async () => {
      asMock(androidEmulatorService.listAVDs).mockResolvedValue(ORPHAN_AVDS);

      await service.cleanupOrphanDevices();

      expect(asMock(androidEmulatorService.deleteAVD)).toHaveBeenCalledWith(
        'wms_session_aabbccdd',
      );
      expect(asMock(androidEmulatorService.deleteAVD)).toHaveBeenCalledWith(
        'wms_session_booted1122',
      );
    });

    it('shuts down booted orphan AVDs before deleting', async () => {
      asMock(androidEmulatorService.listAVDs).mockResolvedValue(ORPHAN_AVDS);

      await service.cleanupOrphanDevices();

      expect(asMock(androidEmulatorService.shutdownEmulator)).toHaveBeenCalledWith(
        'wms_session_booted1122',
      );
      // shutdown should come before delete
      const shutdownOrder =
        asMock(androidEmulatorService.shutdownEmulator).mock.invocationCallOrder[0]!;
      const deleteCallIdx = asMock(androidEmulatorService.deleteAVD).mock.calls.findIndex(
        (c) => c[0] === 'wms_session_booted1122',
      );
      const deleteOrder =
        asMock(androidEmulatorService.deleteAVD).mock.invocationCallOrder[deleteCallIdx]!;
      expect(shutdownOrder).toBeLessThan(deleteOrder);
    });

    it('does NOT call shutdownEmulator for already-shutdown AVDs', async () => {
      asMock(androidEmulatorService.listAVDs).mockResolvedValue(ORPHAN_AVDS);

      await service.cleanupOrphanDevices();

      // wms_session_aabbccdd is shutdown — should not call shutdownEmulator for it
      expect(asMock(androidEmulatorService.shutdownEmulator)).not.toHaveBeenCalledWith(
        'wms_session_aabbccdd',
      );
    });

    it('skips AVDs that do not match the wms_session_ prefix', async () => {
      asMock(androidEmulatorService.listAVDs).mockResolvedValue(ORPHAN_AVDS);

      await service.cleanupOrphanDevices();

      expect(asMock(androidEmulatorService.deleteAVD)).not.toHaveBeenCalledWith(
        'unrelated-avd',
      );
    });

    it('handles listAVDs errors gracefully and does not throw', async () => {
      asMock(androidEmulatorService.listAVDs).mockRejectedValue(
        new Error('adb not found'),
      );

      await expect(service.cleanupOrphanDevices()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 11. SessionCapacityError class
  // =========================================================================

  describe('SessionCapacityError', () => {
    it('has the correct name=SessionCapacityError', () => {
      const err = new SessionCapacityError('test', 'CAPACITY_GLOBAL', 5, 5);
      expect(err.name).toBe('SessionCapacityError');
    });

    it('exposes correct code, currentCount, and maxCount properties', () => {
      const err = new SessionCapacityError(
        'Maximum reached',
        'CAPACITY_PLATFORM',
        3,
        3,
      );
      expect(err.code).toBe('CAPACITY_PLATFORM');
      expect(err.currentCount).toBe(3);
      expect(err.maxCount).toBe(3);
      expect(err.message).toBe('Maximum reached');
    });

    it('is an instanceof Error', () => {
      const err = new SessionCapacityError('oops', 'CAPACITY_GLOBAL', 6, 6);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SessionCapacityError);
    });
  });

  // =========================================================================
  // 12. iOS warm device pool
  // =========================================================================

  describe('iOS warm device pool', () => {
    // Helper: access the internal iosPool map directly.
    function getPool(
      svc: SessionManagerService,
    ): Map<string, Array<{ udid: string; deviceName: string }>> {
      return (svc as unknown as { iosPool: Map<string, Array<{ udid: string; deviceName: string }>> }).iosPool;
    }

    beforeEach(() => {
      // Enable pool (size 1) for all tests in this suite.
      mockConfig.iosWarmPoolSize = 1;

      // Standard iOS mock setup.
      asMock(iosSimulatorService.createDevice).mockResolvedValue('WARM-UDID-0001');
      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);
    });

    it('does NOT call shutdownDevice/deleteDevice when terminating an iOS session with pool space', async () => {
      const session = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      vi.clearAllMocks(); // clear creation call counts

      await service.terminateSession(session.id);

      expect(asMock(iosSimulatorService.shutdownDevice)).not.toHaveBeenCalled();
      expect(asMock(iosSimulatorService.deleteDevice)).not.toHaveBeenCalled();
    });

    it('adds the device UDID to the pool after termination', async () => {
      const session = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);

      await service.terminateSession(session.id);

      const pool = getPool(service);
      const key = `${IOS_REQUEST.deviceTypeId}:${IOS_REQUEST.runtimeId}`;
      expect(pool.has(key)).toBe(true);
      expect(pool.get(key)![0]!.udid).toBe('WARM-UDID-0001');
    });

    it('reuses the pooled device on the next createSession — skips createDevice and bootDevice', async () => {
      // Create + terminate session 1 (fills the pool).
      const s1 = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      // Clear call counts so we can check session 2 in isolation.
      vi.clearAllMocks();

      // Create session 2 — should hit pool.
      const s2 = await service.createSession(IOS_REQUEST);

      expect(asMock(iosSimulatorService.createDevice)).not.toHaveBeenCalled();
      expect(asMock(iosSimulatorService.bootDevice)).not.toHaveBeenCalled();
      expect(asMock(iosSimulatorService.openSimulatorApp)).not.toHaveBeenCalled();
      expect(s2.status).toBe('active');
      expect(s2.device.platformDeviceId).toBe('WARM-UDID-0001');
    });

    it('passes the original deviceName to startCapture when reusing from pool', async () => {
      const s1 = await service.createSession(IOS_REQUEST);
      // Capture the deviceName that was used in the first startCapture call.
      const firstCaptureCall = asMock(screenCaptureService.startCapture).mock.calls[0]!;
      const originalDeviceName = firstCaptureCall[4] as string; // 5th arg

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      vi.clearAllMocks();
      await service.createSession(IOS_REQUEST);

      const secondCaptureCall = asMock(screenCaptureService.startCapture).mock.calls[0]!;
      const reusedDeviceName = secondCaptureCall[4] as string;

      expect(reusedDeviceName).toBe(originalDeviceName);
    });

    it('calls teardownDevice (shutdownDevice + deleteDevice) when pool is full', async () => {
      // Create two sessions back-to-back while pool is empty so both go
      // through the cold path (pool has no entries to claim yet).
      asMock(iosSimulatorService.createDevice).mockResolvedValue('COLD-UDID-0001');
      const s1 = await service.createSession(IOS_REQUEST);

      asMock(iosSimulatorService.createDevice).mockResolvedValue('COLD-UDID-0002');
      const s2 = await service.createSession(IOS_REQUEST);

      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);

      // Terminate s1 first — goes to pool (pool now full at size=1).
      await service.terminateSession(s1.id);

      vi.clearAllMocks();
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      // Terminate s2 — pool is full, so s2's device must be torn down.
      await service.terminateSession(s2.id);

      expect(asMock(iosSimulatorService.shutdownDevice)).toHaveBeenCalledWith('COLD-UDID-0002');
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith('COLD-UDID-0002');
    });

    it('calls teardownDevice normally when iosWarmPoolSize=0 (pool disabled)', async () => {
      mockConfig.iosWarmPoolSize = 0;

      const session = await service.createSession(IOS_REQUEST);

      vi.clearAllMocks();
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);
      await service.terminateSession(session.id);

      expect(asMock(iosSimulatorService.shutdownDevice)).toHaveBeenCalledWith('WARM-UDID-0001');
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith('WARM-UDID-0001');
    });

    it('does NOT reuse pool when runtimeId differs', async () => {
      // Session 1 uses IOS_REQUEST runtimeId.
      const s1 = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      vi.clearAllMocks();
      asMock(iosSimulatorService.createDevice).mockResolvedValue('NEW-UDID-DIFF');
      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);

      // Session 2 uses a different runtimeId.
      const differentRequest = { ...IOS_REQUEST, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0' };
      const s2 = await service.createSession(differentRequest);

      // Should have gone through the cold path.
      expect(asMock(iosSimulatorService.createDevice)).toHaveBeenCalled();
      expect(asMock(iosSimulatorService.bootDevice)).toHaveBeenCalled();
      expect(s2.device.platformDeviceId).toBe('NEW-UDID-DIFF');
    });

    it('cleanupOrphanIOSDevices skips pooled devices', async () => {
      // Fill the pool.
      const s1 = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      vi.clearAllMocks();

      // Simulate simctl output that includes the pooled UDID.
      const SIMCTL_WITH_POOLED = {
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            {
              udid: 'WARM-UDID-0001', // pooled — must be skipped
              name: 'wms-session-warmtest',
              state: 'Booted',
              isAvailable: true,
            },
            {
              udid: 'ORPHAN-UDID-9999', // real orphan — must be cleaned
              name: 'wms-session-orphan',
              state: 'Shutdown',
              isAvailable: true,
            },
          ],
        },
      };
      const { execJSON } = await import('../utils/exec.js');
      asMock(execJSON).mockResolvedValue(SIMCTL_WITH_POOLED);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.cleanupOrphanDevices();

      expect(asMock(iosSimulatorService.deleteDevice)).not.toHaveBeenCalledWith('WARM-UDID-0001');
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith('ORPHAN-UDID-9999');
    });

    it('cleanup() drains the warm pool (calls shutdownDevice + deleteDevice for pooled devices)', async () => {
      // Fill the pool.
      const s1 = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      vi.clearAllMocks();
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.cleanup();

      expect(asMock(iosSimulatorService.shutdownDevice)).toHaveBeenCalledWith('WARM-UDID-0001');
      expect(asMock(iosSimulatorService.deleteDevice)).toHaveBeenCalledWith('WARM-UDID-0001');
    });

    it('pool is empty after cleanup()', async () => {
      const s1 = await service.createSession(IOS_REQUEST);
      asMock(screenCaptureService.stopCapture).mockReturnValue(undefined);
      await service.terminateSession(s1.id);

      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.cleanup();

      const pool = getPool(service);
      expect(pool.size).toBe(0);
    });
  });
});
