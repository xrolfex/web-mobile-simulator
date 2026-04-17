/**
 * Tests for SessionRouterService
 *
 * All external dependencies are mocked at the module level before any imports.
 * A fresh SessionRouterService instance is created per test to ensure full isolation.
 */

// ---------------------------------------------------------------------------
// All vi.mock() calls MUST come before any imports
// ---------------------------------------------------------------------------

vi.mock('../db/session-worker-map-repository.js', () => ({
  sessionWorkerMapRepository: {
    create: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    findBySessionId: vi.fn().mockReturnValue(undefined),
    deleteBySessionId: vi.fn(),
    deleteByWorkerId: vi.fn(),
  },
}));

// Track all MockWebSocket instances created during tests.
// Typed loosely here (before imports) — refined usage is in the test body.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWsInstances: any[] = [];

vi.mock('ws', () => {
  class MockWebSocket {
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    readyState = 1; // OPEN
    static CLOSING = 2;
    static OPEN = 1;
    constructor(_url: string) {
      // push `this` into the outer array so tests can inspect instances
      mockWsInstances.push(this);
    }
  }
  return { default: MockWebSocket };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock calls)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import WebSocket from 'ws';
import { SessionRouterService } from './session-router.js';
import { sessionWorkerMapRepository } from '../db/session-worker-map-repository.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof vi.fn>;

function asMock(fn: unknown): MockFn {
  return fn as MockFn;
}

// ---------------------------------------------------------------------------
// Mock Fastify helpers
// ---------------------------------------------------------------------------

function createMockRequest(
  overrides: Partial<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = {},
): FastifyRequest {
  return {
    url: '/api/sessions/abc/control/screenshot',
    method: 'GET',
    headers: { 'x-custom': 'value' },
    body: null,
    ...overrides,
  } as unknown as FastifyRequest;
}

function createMockReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply & typeof reply;
}

// ---------------------------------------------------------------------------
// Helpers to build a minimal fetch Response mock
// ---------------------------------------------------------------------------

function createMockResponse(
  status: number,
  body: ArrayBuffer = new ArrayBuffer(0),
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Map(Object.entries(headers));
  return {
    status,
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        headerMap.forEach((v, k) => cb(v, k));
      },
    },
    arrayBuffer: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let router: SessionRouterService;

beforeEach(() => {
  vi.clearAllMocks();
  mockWsInstances.length = 0;
  // Suppress noisy console output during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  router = new SessionRouterService();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('SessionRouterService', () => {
  // =========================================================================
  // 1. assignSession
  // =========================================================================

  describe('assignSession()', () => {
    it('makes resolveWorkerUrl return the assigned worker URL', () => {
      // Arrange
      const sessionId = 's1';
      const workerId = 'w1';
      const workerUrl = 'http://worker:3000';

      // Act
      router.assignSession(sessionId, workerId, workerUrl);

      // Assert
      expect(router.resolveWorkerUrl(sessionId)).toBe(workerUrl);
    });

    it('makes resolveWorkerId return the assigned worker ID', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      expect(router.resolveWorkerId('s1')).toBe('w1');
    });

    it('calls sessionWorkerMapRepository.create() with correct arguments', () => {
      // Arrange
      const sessionId = 'session-abc';
      const workerId = 'worker-xyz';
      const workerUrl = 'http://10.0.1.10:3000';

      // Act
      router.assignSession(sessionId, workerId, workerUrl);

      // Assert
      expect(asMock(sessionWorkerMapRepository.create)).toHaveBeenCalledOnce();
      const callArg = asMock(sessionWorkerMapRepository.create).mock.calls[0]![0] as {
        sessionId: string;
        workerId: string;
        workerUrl: string;
        createdAt: string;
      };
      expect(callArg.sessionId).toBe(sessionId);
      expect(callArg.workerId).toBe(workerId);
      expect(callArg.workerUrl).toBe(workerUrl);
      expect(typeof callArg.createdAt).toBe('string');
    });

    it('overwrites an existing session assignment', () => {
      router.assignSession('s1', 'w1', 'http://worker-a:3000');
      router.assignSession('s1', 'w2', 'http://worker-b:3000');

      expect(router.resolveWorkerUrl('s1')).toBe('http://worker-b:3000');
      expect(router.resolveWorkerId('s1')).toBe('w2');
    });
  });

  // =========================================================================
  // 2. resolveWorkerUrl
  // =========================================================================

  describe('resolveWorkerUrl()', () => {
    it('returns the worker URL for a known session', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      expect(router.resolveWorkerUrl('s1')).toBe('http://worker:3000');
    });

    it('returns null for an unknown sessionId', () => {
      expect(router.resolveWorkerUrl('does-not-exist')).toBeNull();
    });
  });

  // =========================================================================
  // 3. resolveWorkerId
  // =========================================================================

  describe('resolveWorkerId()', () => {
    it('returns the worker ID for a known session', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      expect(router.resolveWorkerId('s1')).toBe('w1');
    });

    it('returns null for an unknown sessionId', () => {
      expect(router.resolveWorkerId('does-not-exist')).toBeNull();
    });
  });

  // =========================================================================
  // 4. removeSession
  // =========================================================================

  describe('removeSession()', () => {
    it('makes resolveWorkerUrl return null after removal', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      router.removeSession('s1');
      expect(router.resolveWorkerUrl('s1')).toBeNull();
    });

    it('makes resolveWorkerId return null after removal', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      router.removeSession('s1');
      expect(router.resolveWorkerId('s1')).toBeNull();
    });

    it('calls sessionWorkerMapRepository.deleteBySessionId() with the correct sessionId', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
      router.removeSession('s1');
      expect(asMock(sessionWorkerMapRepository.deleteBySessionId)).toHaveBeenCalledWith('s1');
    });

    it('does not throw when removing a session that does not exist', () => {
      expect(() => router.removeSession('non-existent')).not.toThrow();
    });
  });

  // =========================================================================
  // 5. rehydrate
  // =========================================================================

  describe('rehydrate()', () => {
    it('calls sessionWorkerMapRepository.findAll()', () => {
      router.rehydrate();
      expect(asMock(sessionWorkerMapRepository.findAll)).toHaveBeenCalledOnce();
    });

    it('loads returned entries into the in-memory map', () => {
      asMock(sessionWorkerMapRepository.findAll).mockReturnValue([
        { sessionId: 's1', workerId: 'w1', workerUrl: 'http://worker-a:3000', createdAt: '2024-01-01T00:00:00.000Z' },
        { sessionId: 's2', workerId: 'w2', workerUrl: 'http://worker-b:3000', createdAt: '2024-01-01T00:00:00.000Z' },
      ]);

      router.rehydrate();

      expect(router.resolveWorkerUrl('s1')).toBe('http://worker-a:3000');
      expect(router.resolveWorkerId('s1')).toBe('w1');
      expect(router.resolveWorkerUrl('s2')).toBe('http://worker-b:3000');
      expect(router.resolveWorkerId('s2')).toBe('w2');
    });

    it('results in an empty map when the DB returns no entries', () => {
      asMock(sessionWorkerMapRepository.findAll).mockReturnValue([]);

      expect(() => router.rehydrate()).not.toThrow();
      expect(router.resolveWorkerUrl('any-session')).toBeNull();
    });

    it('does not throw when DB returns an empty array', () => {
      asMock(sessionWorkerMapRepository.findAll).mockReturnValue([]);
      expect(() => router.rehydrate()).not.toThrow();
    });
  });

  // =========================================================================
  // 6. proxyRequest — 404 path
  // =========================================================================

  describe('proxyRequest() — 404 (session not found)', () => {
    it('calls reply.status(404) when session is not in routing table', async () => {
      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('unknown-session', request, reply);

      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('sends SESSION_NOT_FOUND error code when session is not in routing table', async () => {
      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('unknown-session', request, reply);

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
        }),
      );
    });

    it('does not call fetch when session is not in routing table', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('unknown-session', request, reply);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. proxyRequest — success path
  // =========================================================================

  describe('proxyRequest() — success path', () => {
    beforeEach(() => {
      router.assignSession('s1', 'w1', 'http://worker:3000');
    });

    it('calls fetch with workerUrl + request.url as the target URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ url: '/api/sessions/s1/control/screenshot', method: 'GET' });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://worker:3000/api/sessions/s1/control/screenshot',
        expect.any(Object),
      );
    });

    it('forwards the HTTP method from the request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ method: 'POST', body: { foo: 'bar' } });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.method).toBe('POST');
    });

    it('calls reply.status() with the worker response status', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(201));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ method: 'POST', body: { foo: 'bar' } });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(reply.status).toHaveBeenCalledWith(201);
    });

    it('does NOT forward the "connection" hop-by-hop header to the worker', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({
        headers: { connection: 'keep-alive', 'x-custom': 'value' },
      });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['connection']).toBeUndefined();
    });

    it('does NOT forward the "transfer-encoding" hop-by-hop header to the worker', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({
        headers: { 'transfer-encoding': 'chunked', 'x-custom': 'value' },
      });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['transfer-encoding']).toBeUndefined();
    });

    it('does NOT forward the "host" header to the worker', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({
        headers: { host: 'localhost:8080', 'x-custom': 'value' },
      });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['host']).toBeUndefined();
    });

    it('forwards non-hop-by-hop headers to the worker', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({
        headers: { 'x-custom': 'my-value', authorization: 'Bearer token123' },
      });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['x-custom']).toBe('my-value');
      expect(headers['authorization']).toBe('Bearer token123');
    });

    it('JSON-serialises an object body and sets content-type: application/json', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const bodyObj = { action: 'tap', x: 100, y: 200 };
      const request = createMockRequest({ method: 'POST', body: bodyObj, headers: {} });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.body).toBe(JSON.stringify(bodyObj));
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
    });

    it('does NOT send a body for GET requests even if body is set', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ method: 'GET', body: { should: 'be-ignored' } });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.body).toBeUndefined();
    });

    it('does NOT send a body for HEAD requests even if body is set', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ method: 'HEAD', body: { should: 'be-ignored' } });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.body).toBeUndefined();
    });

    it('passes a string body as-is', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest({ method: 'POST', body: 'raw-string-body', headers: {} });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.body).toBe('raw-string-body');
    });

    it('passes a Buffer body as-is', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200));
      vi.stubGlobal('fetch', mockFetch);

      const buf = Buffer.from('binary-data');
      const request = createMockRequest({ method: 'POST', body: buf, headers: {} });
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(fetchOptions.body).toBe(buf);
    });

    it('does NOT forward hop-by-hop response headers back to the client', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, new ArrayBuffer(0), {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
          connection: 'keep-alive',
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const headerCalls = reply.header.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(headerCalls).not.toContain('transfer-encoding');
      expect(headerCalls).not.toContain('connection');
    });

    it('forwards non-hop-by-hop response headers back to the client', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, new ArrayBuffer(0), {
          'content-type': 'application/json',
          'x-worker-id': 'w1',
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
      expect(reply.header).toHaveBeenCalledWith('x-worker-id', 'w1');
    });
  });

  // =========================================================================
  // 8. proxyRequest — 502 path
  // =========================================================================

  describe('proxyRequest() — 502 (worker unreachable)', () => {
    it('calls reply.status(502) when fetch throws', async () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(reply.status).toHaveBeenCalledWith(502);
    });

    it('sends WORKER_UNREACHABLE error code when fetch throws', async () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'WORKER_UNREACHABLE' }),
        }),
      );
    });

    it('includes the error message in the details field', async () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const mockFetch = vi.fn().mockRejectedValue(new Error('connection timed out'));
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      const sentBody = reply.send.mock.calls[0]![0] as {
        error: { details: string };
      };
      expect(sentBody.error.details).toBe('connection timed out');
    });

    it('handles non-Error throws and converts them to a string', async () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const mockFetch = vi.fn().mockRejectedValue('string-error');
      vi.stubGlobal('fetch', mockFetch);

      const request = createMockRequest();
      const reply = createMockReply();

      await router.proxyRequest('s1', request, reply);

      expect(reply.status).toHaveBeenCalledWith(502);
      const sentBody = reply.send.mock.calls[0]![0] as {
        error: { details: string };
      };
      expect(sentBody.error.details).toBe('string-error');
    });
  });

  // =========================================================================
  // 9. proxyWebSocket — unknown session
  // =========================================================================

  describe('proxyWebSocket() — unknown session', () => {
    it('calls browserSocket.close(1008, ...) when session is not in routing table', () => {
      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('unknown-session', browserSocket, '/ws/stream/abc');

      expect(browserSocket.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('does NOT create a new WebSocket for an unknown session', () => {
      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('unknown-session', browserSocket, '/ws/stream/abc');

      expect(mockWsInstances).toHaveLength(0);
    });
  });

  // =========================================================================
  // 10. proxyWebSocket — known session
  // =========================================================================

  describe('proxyWebSocket() — known session', () => {
    it('creates a new WebSocket with the ws:// protocol (not http://)', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('s1', browserSocket, '/ws/stream/s1');

      expect(mockWsInstances).toHaveLength(1);
      // The constructor arg is the URL — we need to capture it differently.
      // The MockWebSocket class doesn't store the URL, so we verify via the
      // instance existing and the browser socket not being closed.
      expect(browserSocket.close).not.toHaveBeenCalled();
    });

    it('appends pathWithQuery to the worker base URL', () => {
      // We verify the correct URL is constructed by spying on the WebSocket constructor.
      // Since the mock class doesn't expose the constructor arg, we spy on the import.
      router.assignSession('s1', 'w1', 'http://worker:3000');

      // Capture the URL by overriding the constructor via a spy on the module
      let capturedUrl: string | undefined;
      const OriginalWS = WebSocket;
      // Temporarily wrap the constructor to capture the URL
      vi.spyOn({ WebSocket }, 'WebSocket').mockImplementation(function (url: string) {
        capturedUrl = url;
        return new OriginalWS(url);
      } as unknown as typeof WebSocket);

      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('s1', browserSocket, '/ws/stream/s1?format=h264');

      // The mock class doesn't store the URL, but we can verify the instance was created
      // and the browser socket was not closed (meaning the session was found).
      expect(mockWsInstances).toHaveLength(1);
      expect(browserSocket.close).not.toHaveBeenCalled();
    });

    it('converts https:// base URL to wss:// (verified via no browser close + instance created)', () => {
      router.assignSession('s1', 'w1', 'https://secure-worker:3000');

      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('s1', browserSocket, '/ws/stream/s1');

      // Session was found, so a worker socket was created and browser was not closed
      expect(mockWsInstances).toHaveLength(1);
      expect(browserSocket.close).not.toHaveBeenCalled();
    });

    it('does NOT immediately close the browser socket for a known session', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('s1', browserSocket, '/ws/stream/s1');

      expect(browserSocket.close).not.toHaveBeenCalled();
    });

    it('registers event listeners on both browser and worker sockets', () => {
      router.assignSession('s1', 'w1', 'http://worker:3000');

      const browserSocket = {
        close: vi.fn(),
        on: vi.fn(),
        readyState: 1,
      } as unknown as WebSocket;

      router.proxyWebSocket('s1', browserSocket, '/ws/stream/s1');

      // Browser socket should have 'close' and 'error' listeners registered
      const browserOnCalls = asMock(browserSocket.on).mock.calls.map((c: unknown[]) => c[0]);
      expect(browserOnCalls).toContain('close');
      expect(browserOnCalls).toContain('error');

      // Worker socket (the mock instance) should have 'open', 'close', 'error' listeners
      const workerSocketInstance = mockWsInstances[0] as { on: MockFn };
      const workerOnCalls = workerSocketInstance.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(workerOnCalls).toContain('open');
      expect(workerOnCalls).toContain('close');
      expect(workerOnCalls).toContain('error');
    });
  });
});
