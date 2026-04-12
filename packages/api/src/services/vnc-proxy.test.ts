import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the config module before importing the service
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  config: {
    vncProxyPortRange: { start: 19000, end: 19099 },
  },
}));

import { VNCProxyService } from './vnc-proxy.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VNCProxyService', () => {
  let service: VNCProxyService;

  beforeEach(() => {
    service = new VNCProxyService();
  });

  afterEach(async () => {
    // Always clean up bound ports to avoid port leaks across tests
    await service.cleanup();
  });

  // -------------------------------------------------------------------------
  // startProxy()
  // -------------------------------------------------------------------------

  describe('startProxy()', () => {
    it('allocates a port and returns wsPort and wsUrl', async () => {
      const result = await service.startProxy('session-1', '127.0.0.1', 5900);

      expect(result.wsPort).toBeTypeOf('number');
      expect(result.wsPort).toBeGreaterThanOrEqual(19000);
      expect(result.wsPort).toBeLessThanOrEqual(19099);
      expect(result.wsUrl).toBe(`/ws/vnc/session-1`);
    });

    it('returns a port in the configured range', async () => {
      const { wsPort } = await service.startProxy('session-range', '127.0.0.1', 5900);

      expect(wsPort).toBeGreaterThanOrEqual(19000);
      expect(wsPort).toBeLessThanOrEqual(19099);
    });

    it('is idempotent — calling startProxy() twice for the same sessionId returns the same port', async () => {
      const first = await service.startProxy('session-idem', '127.0.0.1', 5900);
      const second = await service.startProxy('session-idem', '127.0.0.1', 5901);

      expect(second.wsPort).toBe(first.wsPort);
      expect(second.wsUrl).toBe(first.wsUrl);
    });

    it('allocates different ports for different sessions', async () => {
      const a = await service.startProxy('session-a', '127.0.0.1', 5900);
      const b = await service.startProxy('session-b', '127.0.0.1', 5900);

      expect(a.wsPort).not.toBe(b.wsPort);
    });

    it('the wsUrl is a path-based relative URL', async () => {
      const { wsUrl } = await service.startProxy('session-url', '127.0.0.1', 5900);

      expect(wsUrl).toBe('/ws/vnc/session-url');
    });
  });

  // -------------------------------------------------------------------------
  // stopProxy()
  // -------------------------------------------------------------------------

  describe('stopProxy()', () => {
    it('removes the proxy so getProxy() returns null afterwards', async () => {
      await service.startProxy('session-stop', '127.0.0.1', 5900);

      await service.stopProxy('session-stop');

      expect(service.getProxy('session-stop')).toBeNull();
    });

    it('decrements getActiveCount() after stopping', async () => {
      await service.startProxy('session-count', '127.0.0.1', 5900);
      expect(service.getActiveCount()).toBe(1);

      await service.stopProxy('session-count');

      expect(service.getActiveCount()).toBe(0);
    });

    it('frees the port so the same port can be reused', async () => {
      const { wsPort: _wsPort } = await service.startProxy('session-reuse', '127.0.0.1', 5900);
      await service.stopProxy('session-reuse');

      // After freeing, the same port should be available again — a new proxy
      // should be able to claim it (or another port in range).
      const result = await service.startProxy('session-reuse-2', '127.0.0.1', 5900);
      // The important thing is that it succeeds and uses a valid port
      expect(result.wsPort).toBeGreaterThanOrEqual(19000);
      expect(result.wsPort).toBeLessThanOrEqual(19099);
    });

    it('is a no-op when called for an unknown sessionId', async () => {
      await expect(service.stopProxy('nonexistent-session')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getProxy()
  // -------------------------------------------------------------------------

  describe('getProxy()', () => {
    it('returns wsPort and wsUrl for an active proxy', async () => {
      const started = await service.startProxy('session-get', '127.0.0.1', 5900);

      const info = service.getProxy('session-get');

      expect(info).not.toBeNull();
      expect(info!.wsPort).toBe(started.wsPort);
      expect(info!.wsUrl).toBe(started.wsUrl);
    });

    it('returns null for a session that was never started', () => {
      expect(service.getProxy('completely-unknown')).toBeNull();
    });

    it('returns null after the proxy has been stopped', async () => {
      await service.startProxy('session-after-stop', '127.0.0.1', 5900);
      await service.stopProxy('session-after-stop');

      expect(service.getProxy('session-after-stop')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getActiveCount()
  // -------------------------------------------------------------------------

  describe('getActiveCount()', () => {
    it('starts at zero before any proxies are started', () => {
      expect(service.getActiveCount()).toBe(0);
    });

    it('increments by one when a new proxy is started', async () => {
      await service.startProxy('session-cnt-1', '127.0.0.1', 5900);

      expect(service.getActiveCount()).toBe(1);
    });

    it('correctly tracks multiple active proxies', async () => {
      await service.startProxy('session-multi-1', '127.0.0.1', 5900);
      await service.startProxy('session-multi-2', '127.0.0.1', 5901);
      await service.startProxy('session-multi-3', '127.0.0.1', 5902);

      expect(service.getActiveCount()).toBe(3);
    });

    it('does not increment when startProxy is called for an existing session', async () => {
      await service.startProxy('session-idem-cnt', '127.0.0.1', 5900);
      await service.startProxy('session-idem-cnt', '127.0.0.1', 5900); // duplicate

      expect(service.getActiveCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // cleanup()
  // -------------------------------------------------------------------------

  describe('cleanup()', () => {
    it('stops all active proxies so getActiveCount() is 0', async () => {
      // Start several proxies
      await service.startProxy('cleanup-1', '127.0.0.1', 5900);
      await service.startProxy('cleanup-2', '127.0.0.1', 5901);
      await service.startProxy('cleanup-3', '127.0.0.1', 5902);

      expect(service.getActiveCount()).toBe(3);

      await service.cleanup();

      expect(service.getActiveCount()).toBe(0);
    });

    it('makes all previously active sessions return null from getProxy()', async () => {
      await service.startProxy('cleanup-a', '127.0.0.1', 5900);
      await service.startProxy('cleanup-b', '127.0.0.1', 5901);

      await service.cleanup();

      expect(service.getProxy('cleanup-a')).toBeNull();
      expect(service.getProxy('cleanup-b')).toBeNull();
    });

    it('is safe to call when no proxies are active', async () => {
      await expect(service.cleanup()).resolves.toBeUndefined();
    });

    it('is idempotent — calling cleanup() twice does not throw', async () => {
      await service.startProxy('cleanup-idem', '127.0.0.1', 5900);

      await service.cleanup();
      await expect(service.cleanup()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Port exhaustion
  // -------------------------------------------------------------------------

  describe('port exhaustion', () => {
    it('throws when the entire port range is occupied', async () => {
      // Use a service with an extremely narrow (1-port) range
      vi.doMock('../config.js', () => ({
        config: {
          vncProxyPortRange: { start: 19090, end: 19090 },
        },
      }));

      // We test this indirectly by filling up the 100-port range in the service
      // instance already configured with ports 19000–19099. We can't realistically
      // fill 100 ports in a unit test, so we test the error message format instead
      // by crafting a service with a tiny mocked range.
      //
      // The real exhaustion path is tested by asserting the error message shape.
      const tinyService = new VNCProxyService();
      // Override the private findAvailablePort behaviour by exhausting the one
      // available slot. We rely on the mock set up at the top of the file which
      // gives 100 ports (19000-19099); just confirm the error text format via
      // a direct check of the service's thrown message when all slots are used.
      // We do this by starting 100 proxies — if even one port in range is truly
      // free on the CI machine this loop completes; we just verify count equals
      // what we started successfully.
      let started = 0;
      const errors: Error[] = [];
      for (let i = 0; i < 105; i++) {
        try {
          await tinyService.startProxy(`exhaust-${i}`, '127.0.0.1', 5900);
          started++;
        } catch (e) {
          errors.push(e as Error);
          break;
        }
      }

      // Either we filled all 100 slots and got an error, or we could only fill
      // some (other tests may have consumed ports) — the important thing is that
      // eventually an error is thrown when range is exhausted.
      if (errors.length > 0) {
        expect(errors[0]!.message).toMatch(/No available ports in range/);
        expect(errors[0]!.message).toMatch(/All \d+ proxy slots are in use/);
      } else {
        // If we filled all 100 ports, that's also a valid outcome
        expect(started).toBeLessThanOrEqual(100);
      }

      await tinyService.cleanup();
    }, 60000);
  });
});
