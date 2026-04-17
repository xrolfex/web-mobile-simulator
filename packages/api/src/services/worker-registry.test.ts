import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `ws` before importing the service — vitest hoists vi.mock() calls so
// the mock is in place before any module-level imports are resolved.
// ---------------------------------------------------------------------------
vi.mock('ws', () => {
  // Must use a real `function` (not an arrow) so `new MockWebSocket()` works.
  const MockWebSocket = vi.fn().mockImplementation(function (this: any) {
    this.on = vi.fn();
    this.close = vi.fn();
    this.readyState = 1; // OPEN
  });
  (MockWebSocket as any).CLOSING = 2;
  (MockWebSocket as any).OPEN = 1;
  return { default: MockWebSocket };
});

// ---------------------------------------------------------------------------
// Mock the event-bus so we don't need a real EventEmitter in these tests.
// ---------------------------------------------------------------------------
vi.mock('./event-bus.js', () => ({
  eventBusService: { emit: vi.fn() },
}));

import { WorkerRegistryService } from './worker-registry.js';
import {
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_OFFLINE_THRESHOLD_MS,
} from '@web-mobile-simulator/shared';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid WorkerRegistrationRequest. */
function makeRegReq(overrides: Partial<{
  url: string;
  maxIosSessions: number;
  maxAndroidSessions: number;
}> = {}) {
  return {
    url: 'http://worker-1.local:4000',
    maxIosSessions: 2,
    maxAndroidSessions: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkerRegistryService', () => {
  let registry: WorkerRegistryService;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new WorkerRegistryService();
  });

  afterEach(() => {
    registry.stop();
  });

  // -------------------------------------------------------------------------
  // registerWorker()
  // -------------------------------------------------------------------------

  describe('registerWorker()', () => {
    it('returns a non-empty workerId UUID string', () => {
      const res = registry.registerWorker(makeRegReq());

      expect(res.workerId).toBeTypeOf('string');
      expect(res.workerId.length).toBeGreaterThan(0);
      // UUID v4 pattern
      expect(res.workerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('returns heartbeatIntervalMs equal to DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS', () => {
      const res = registry.registerWorker(makeRegReq());

      expect(res.heartbeatIntervalMs).toBe(DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS);
    });

    it('the registered worker appears in getAllWorkers()', () => {
      const res = registry.registerWorker(makeRegReq({ url: 'http://worker-a.local' }));

      const all = registry.getAllWorkers();
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(res.workerId);
      expect(all[0]!.url).toBe('http://worker-a.local');
    });

    it('new worker has isHealthy = true', () => {
      const res = registry.registerWorker(makeRegReq());

      const worker = registry.getWorker(res.workerId);
      expect(worker!.isHealthy).toBe(true);
    });

    it('new worker has currentIosSessions = 0 and currentAndroidSessions = 0', () => {
      const res = registry.registerWorker(makeRegReq());

      const worker = registry.getWorker(res.workerId);
      expect(worker!.capacity.currentIosSessions).toBe(0);
      expect(worker!.capacity.currentAndroidSessions).toBe(0);
    });

    it('creates a WebSocket connection (ws mock constructor called once)', () => {
      registry.registerWorker(makeRegReq());

      expect(WebSocket).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // updateHeartbeat()
  // -------------------------------------------------------------------------

  describe('updateHeartbeat()', () => {
    it('returns true and updates session counts when worker exists', () => {
      const { workerId } = registry.registerWorker(makeRegReq());

      const result = registry.updateHeartbeat(workerId, {
        currentIosSessions: 1,
        currentAndroidSessions: 2,
      });

      expect(result).toBe(true);
      const worker = registry.getWorker(workerId);
      expect(worker!.capacity.currentIosSessions).toBe(1);
      expect(worker!.capacity.currentAndroidSessions).toBe(2);
    });

    it('returns false when workerId is unknown', () => {
      const result = registry.updateHeartbeat('non-existent-id', {
        currentIosSessions: 0,
        currentAndroidSessions: 0,
      });

      expect(result).toBe(false);
    });

    it('sets isHealthy back to true after a heartbeat', () => {
      const { workerId } = registry.registerWorker(makeRegReq());
      // Manually mark offline first
      registry.markOffline(workerId);
      expect(registry.getWorker(workerId)!.isHealthy).toBe(false);

      registry.updateHeartbeat(workerId, {
        currentIosSessions: 0,
        currentAndroidSessions: 0,
      });

      expect(registry.getWorker(workerId)!.isHealthy).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // markOffline()
  // -------------------------------------------------------------------------

  describe('markOffline()', () => {
    it('sets isHealthy = false on the worker', () => {
      const { workerId } = registry.registerWorker(makeRegReq());

      registry.markOffline(workerId);

      expect(registry.getWorker(workerId)!.isHealthy).toBe(false);
    });

    it('calls close() on the open events socket', () => {
      const { workerId } = registry.registerWorker(makeRegReq());
      // The mock constructor records instances in .mock.instances
      const socketInstance = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.instances[0] as { close: ReturnType<typeof vi.fn> };

      registry.markOffline(workerId);

      expect(socketInstance.close).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for an unknown workerId (does not throw)', () => {
      expect(() => registry.markOffline('unknown-id')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // removeWorker()
  // -------------------------------------------------------------------------

  describe('removeWorker()', () => {
    it('worker no longer appears in getAllWorkers() after removal', () => {
      const { workerId } = registry.registerWorker(makeRegReq());
      expect(registry.getAllWorkers()).toHaveLength(1);

      registry.removeWorker(workerId);

      expect(registry.getAllWorkers()).toHaveLength(0);
    });

    it('is a no-op for an unknown workerId (does not throw)', () => {
      expect(() => registry.removeWorker('unknown-id')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getAllWorkers() / getHealthyWorkers()
  // -------------------------------------------------------------------------

  describe('getAllWorkers()', () => {
    it('returns both healthy and unhealthy workers', () => {
      const { workerId: id1 } = registry.registerWorker(makeRegReq({ url: 'http://w1.local' }));
      const { workerId: id2 } = registry.registerWorker(makeRegReq({ url: 'http://w2.local' }));

      registry.markOffline(id2);

      const all = registry.getAllWorkers();
      expect(all).toHaveLength(2);
      const ids = all.map((w) => w.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it('returns an empty array when no workers are registered', () => {
      expect(registry.getAllWorkers()).toEqual([]);
    });
  });

  describe('getHealthyWorkers()', () => {
    it('returns only workers where isHealthy === true', () => {
      const { workerId: id1 } = registry.registerWorker(makeRegReq({ url: 'http://w1.local' }));
      const { workerId: id2 } = registry.registerWorker(makeRegReq({ url: 'http://w2.local' }));

      registry.markOffline(id2);

      const healthy = registry.getHealthyWorkers();
      expect(healthy).toHaveLength(1);
      expect(healthy[0]!.id).toBe(id1);
    });

    it('returns an empty array when all workers are unhealthy', () => {
      const { workerId } = registry.registerWorker(makeRegReq());
      registry.markOffline(workerId);

      expect(registry.getHealthyWorkers()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getWorker()
  // -------------------------------------------------------------------------

  describe('getWorker()', () => {
    it('returns a WorkerNode with the correct id and url for a known worker', () => {
      const { workerId } = registry.registerWorker(makeRegReq({ url: 'http://known.local' }));

      const worker = registry.getWorker(workerId);

      expect(worker).not.toBeNull();
      expect(worker!.id).toBe(workerId);
      expect(worker!.url).toBe('http://known.local');
    });

    it('returns null for an unknown workerId', () => {
      expect(registry.getWorker('does-not-exist')).toBeNull();
    });

    it('does NOT expose _eventsSocket or _eventsReconnectAttempts fields', () => {
      const { workerId } = registry.registerWorker(makeRegReq());

      const worker = registry.getWorker(workerId) as Record<string, unknown>;

      expect(worker).not.toHaveProperty('_eventsSocket');
      expect(worker).not.toHaveProperty('_eventsReconnectAttempts');
    });
  });

  // -------------------------------------------------------------------------
  // pickWorker()
  // -------------------------------------------------------------------------

  describe('pickWorker()', () => {
    it('returns null when there are no registered workers', () => {
      expect(registry.pickWorker('ios')).toBeNull();
      expect(registry.pickWorker('android')).toBeNull();
    });

    it('returns null when all workers are unhealthy', () => {
      const { workerId } = registry.registerWorker(makeRegReq());
      registry.markOffline(workerId);

      expect(registry.pickWorker('ios')).toBeNull();
    });

    it('returns null for ios when the only worker has currentIosSessions >= maxIosSessions', () => {
      const { workerId } = registry.registerWorker(makeRegReq({ maxIosSessions: 1 }));
      registry.updateHeartbeat(workerId, { currentIosSessions: 1, currentAndroidSessions: 0 });

      expect(registry.pickWorker('ios')).toBeNull();
    });

    it('returns null for android when the only worker has currentAndroidSessions >= maxAndroidSessions', () => {
      const { workerId } = registry.registerWorker(makeRegReq({ maxAndroidSessions: 1 }));
      registry.updateHeartbeat(workerId, { currentIosSessions: 0, currentAndroidSessions: 1 });

      expect(registry.pickWorker('android')).toBeNull();
    });

    it('returns the worker when ios capacity is available', () => {
      const { workerId } = registry.registerWorker(makeRegReq({ maxIosSessions: 2 }));

      const picked = registry.pickWorker('ios');

      expect(picked).not.toBeNull();
      expect(picked!.id).toBe(workerId);
    });

    it('returns the worker when android capacity is available', () => {
      const { workerId } = registry.registerWorker(makeRegReq({ maxAndroidSessions: 2 }));

      const picked = registry.pickWorker('android');

      expect(picked).not.toBeNull();
      expect(picked!.id).toBe(workerId);
    });

    it('picks the least-loaded worker (lowest total sessions) when multiple candidates exist', () => {
      // Register two workers
      const { workerId: id1 } = registry.registerWorker(makeRegReq({ url: 'http://w1.local', maxIosSessions: 4 }));
      const { workerId: id2 } = registry.registerWorker(makeRegReq({ url: 'http://w2.local', maxIosSessions: 4 }));

      // Worker 1 has 3 total sessions, worker 2 has 1 — expect worker 2 to be picked
      registry.updateHeartbeat(id1, { currentIosSessions: 2, currentAndroidSessions: 1 });
      registry.updateHeartbeat(id2, { currentIosSessions: 1, currentAndroidSessions: 0 });

      const picked = registry.pickWorker('ios');

      expect(picked!.id).toBe(id2);
    });

    it('an unhealthy worker is never returned even if it has capacity', () => {
      const { workerId: id1 } = registry.registerWorker(makeRegReq({ url: 'http://w1.local', maxIosSessions: 4 }));
      const { workerId: id2 } = registry.registerWorker(makeRegReq({ url: 'http://w2.local', maxIosSessions: 4 }));

      // Mark the first worker offline — it has plenty of capacity but should be excluded
      registry.markOffline(id1);

      const picked = registry.pickWorker('ios');

      expect(picked).not.toBeNull();
      expect(picked!.id).toBe(id2);
    });
  });

  // -------------------------------------------------------------------------
  // startHealthCheckInterval()
  // -------------------------------------------------------------------------

  describe('startHealthCheckInterval()', () => {
    it('calling it twice does NOT start two intervals (idempotency)', () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        registry.startHealthCheckInterval();
        registry.startHealthCheckInterval(); // second call should be a no-op

        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('clears the health-check interval so no further ticks fire', () => {
      vi.useFakeTimers();
      try {
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        registry.startHealthCheckInterval();
        registry.stop();

        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls close() on any open event sockets', () => {
      // Register a worker so a WebSocket is created
      registry.registerWorker(makeRegReq());

      const socketInstance = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.instances[0] as { close: ReturnType<typeof vi.fn> };

      registry.stop();

      expect(socketInstance.close).toHaveBeenCalledTimes(1);
    });

    it('calling stop() twice does not throw', () => {
      registry.startHealthCheckInterval();

      expect(() => {
        registry.stop();
        registry.stop();
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // runHealthCheck() — triggered by advancing fake timers 30 s
  // -------------------------------------------------------------------------

  describe('runHealthCheck() (via fake timer tick)', () => {
    it('marks a worker offline when lastHeartbeatAt is older than WORKER_OFFLINE_THRESHOLD_MS', () => {
      vi.useFakeTimers();
      try {
        const { workerId } = registry.registerWorker(makeRegReq());
        registry.startHealthCheckInterval();

        // Advance time past the offline threshold so the worker's heartbeat is stale
        vi.advanceTimersByTime(WORKER_OFFLINE_THRESHOLD_MS + 30_000);

        expect(registry.getWorker(workerId)!.isHealthy).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT mark a recently-heartbeating worker offline', () => {
      vi.useFakeTimers();
      try {
        const { workerId } = registry.registerWorker(makeRegReq());
        registry.startHealthCheckInterval();

        // Send a fresh heartbeat just before the health check fires
        registry.updateHeartbeat(workerId, { currentIosSessions: 0, currentAndroidSessions: 0 });

        // Advance only 30 s (one health-check tick) — well within the threshold
        vi.advanceTimersByTime(30_000);

        expect(registry.getWorker(workerId)!.isHealthy).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
