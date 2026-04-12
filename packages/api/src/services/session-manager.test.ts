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
    getVNCPort: vi.fn(),
    shutdownDevice: vi.fn(),
    deleteDevice: vi.fn(),
    listDevices: vi.fn(),
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

// Mock VNC proxy service
vi.mock('./vnc-proxy.js', () => ({
  vncProxyService: {
    startProxy: vi.fn(),
    stopProxy: vi.fn(),
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
import { vncProxyService } from './vnc-proxy.js';
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
  asMock(iosSimulatorService.getVNCPort).mockResolvedValue(5900);
  asMock(vncProxyService.startProxy).mockResolvedValue({
    wsPort: 6900,
    wsUrl: 'ws://localhost:6900',
  });
}

function mockSuccessfulAndroidCreation(): void {
  asMock(androidEmulatorService.createAVD).mockResolvedValue('wms_session_mock');
  asMock(androidEmulatorService.bootEmulator).mockResolvedValue({
    pid: 1234,
    adbPort: 5554,
  });
  asMock(vncProxyService.startProxy).mockResolvedValue({
    wsPort: 6901,
    wsUrl: 'ws://localhost:6901',
  });
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
      expect(session.streamUrl).toBe('ws://localhost:6900');
      expect(session.proxyPort).toBe(6900);
      expect(session.device.platform).toBe('ios');
    });

    it('populates device with the UDID returned by createDevice', async () => {
      mockSuccessfulIOSCreation();

      const session = await service.createSession(IOS_REQUEST);

      expect(session.device.id).toBe('MOCK-UDID-1234');
      expect(session.device.platformDeviceId).toBe('MOCK-UDID-1234');
    });

    it('calls createDevice, bootDevice, getVNCPort, startProxy in the correct order', async () => {
      mockSuccessfulIOSCreation();

      await service.createSession(IOS_REQUEST);

      const createOrder = asMock(iosSimulatorService.createDevice).mock.invocationCallOrder[0]!;
      const bootOrder = asMock(iosSimulatorService.bootDevice).mock.invocationCallOrder[0]!;
      const vncOrder = asMock(iosSimulatorService.getVNCPort).mock.invocationCallOrder[0]!;
      const proxyOrder = asMock(vncProxyService.startProxy).mock.invocationCallOrder[0]!;

      expect(createOrder).toBeLessThan(bootOrder);
      expect(bootOrder).toBeLessThan(vncOrder);
      expect(vncOrder).toBeLessThan(proxyOrder);
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
      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow('boot failed');

      const sessions = (service as unknown as { sessions: Map<string, { status: string }> })
        .sessions;
      const session = [...sessions.values()][0]!;
      expect(session.status).toBe('error');

      // stopProxy should have been called for cleanup
      expect(asMock(vncProxyService.stopProxy)).toHaveBeenCalled();
    });

    it('throws and sets status=error when getVNCPort returns null', async () => {
      asMock(iosSimulatorService.createDevice).mockResolvedValue('MOCK-UDID-NULL');
      asMock(iosSimulatorService.bootDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.getVNCPort).mockResolvedValue(null);
      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await expect(service.createSession(IOS_REQUEST)).rejects.toThrow(
        'Could not discover VNC port',
      );

      const sessions = (service as unknown as { sessions: Map<string, { status: string }> })
        .sessions;
      const session = [...sessions.values()][0]!;
      expect(session.status).toBe('error');
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
      expect(session.streamUrl).toBe('ws://localhost:6901');
      expect(session.proxyPort).toBe(6901);
      expect(session.device.platform).toBe('android');
    });

    it('calls createAVD, bootEmulator, startProxy in the correct order', async () => {
      mockSuccessfulAndroidCreation();

      await service.createSession(ANDROID_REQUEST);

      const createOrder =
        asMock(androidEmulatorService.createAVD).mock.invocationCallOrder[0]!;
      const bootOrder =
        asMock(androidEmulatorService.bootEmulator).mock.invocationCallOrder[0]!;
      const proxyOrder = asMock(vncProxyService.startProxy).mock.invocationCallOrder[0]!;

      expect(createOrder).toBeLessThan(bootOrder);
      expect(bootOrder).toBeLessThan(proxyOrder);
    });

    it('uses adbPort + 1 as the VNC target port when starting the proxy', async () => {
      mockSuccessfulAndroidCreation();

      await service.createSession(ANDROID_REQUEST);

      // bootEmulator resolves with adbPort: 5554, so VNC port should be 5555
      expect(asMock(vncProxyService.startProxy)).toHaveBeenCalledWith(
        expect.any(String),
        'localhost',
        5555, // adbPort (5554) + 1
      );
    });

    it('sets status=error and runs cleanup when bootEmulator fails', async () => {
      asMock(androidEmulatorService.createAVD).mockResolvedValue('wms_session_fail');
      asMock(androidEmulatorService.bootEmulator).mockRejectedValue(
        new Error('emulator boot failed'),
      );
      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
      asMock(androidEmulatorService.shutdownEmulator).mockResolvedValue(undefined);
      asMock(androidEmulatorService.deleteAVD).mockResolvedValue(undefined);

      await expect(service.createSession(ANDROID_REQUEST)).rejects.toThrow(
        'emulator boot failed',
      );

      const sessions = (service as unknown as { sessions: Map<string, { status: string }> })
        .sessions;
      const session = [...sessions.values()][0]!;
      expect(session.status).toBe('error');

      expect(asMock(vncProxyService.stopProxy)).toHaveBeenCalled();
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
      asMock(iosSimulatorService.getVNCPort).mockResolvedValue(5900);
      asMock(vncProxyService.startProxy).mockResolvedValue({
        wsPort: 6900,
        wsUrl: 'ws://localhost:6900',
      });

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
      asMock(iosSimulatorService.getVNCPort).mockResolvedValue(5900);
      asMock(vncProxyService.startProxy).mockResolvedValue({
        wsPort: 6900,
        wsUrl: 'ws://localhost:6900',
      });
      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
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
      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);

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

      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.terminateSession(session.id);

      const terminated = service.getSession(session.id);
      expect(terminated?.status).toBe('terminated');
    });

    it('calls stopProxy and teardown (shutdownDevice + deleteDevice) for iOS', async () => {
      mockSuccessfulIOSCreation();
      const session = await service.createSession(IOS_REQUEST);

      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
      asMock(iosSimulatorService.shutdownDevice).mockResolvedValue(undefined);
      asMock(iosSimulatorService.deleteDevice).mockResolvedValue(undefined);

      await service.terminateSession(session.id);

      expect(asMock(vncProxyService.stopProxy)).toHaveBeenCalledWith(session.id);
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

      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
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
      asMock(iosSimulatorService.getVNCPort).mockResolvedValue(5901);
      asMock(vncProxyService.startProxy).mockResolvedValue({
        wsPort: 6901,
        wsUrl: 'ws://localhost:6901',
      });

      const session2 = await service.createSession(IOS_REQUEST);

      asMock(vncProxyService.stopProxy).mockResolvedValue(undefined);
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

      // Make stopProxy throw to simulate failure
      asMock(vncProxyService.stopProxy).mockRejectedValue(new Error('proxy error'));
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
});
