import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import type { Session } from '@web-mobile-simulator/shared';
import { workerRegistryService, sessionRouterService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[MasterProxyRoute]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

function errorResponse(code: string, message: string, details?: unknown) {
  return { success: false, error: { code, message, details } };
}

// ---------------------------------------------------------------------------
// Hop-by-hop headers that must NOT be forwarded
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

// ---------------------------------------------------------------------------
// Helper — build a safe header object for forwarding
// ---------------------------------------------------------------------------

function buildForwardHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'host' && typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper — proxy to the first available healthy worker
// ---------------------------------------------------------------------------

/**
 * Forward a request to the first healthy worker in the registry.
 * Returns 503 if no healthy workers are available, 502 on network error.
 */
async function proxyToAnyWorker(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const workers = workerRegistryService.getHealthyWorkers();

  if (workers.length === 0) {
    await reply.status(503).send(
      errorResponse('NO_WORKERS', 'No healthy workers are currently available.'),
    );
    return;
  }

  const worker = workers[0]!;
  const targetUrl = `${worker.url}${request.url}`;
  const forwardHeaders = buildForwardHeaders(request.headers as Record<string, string | string[] | undefined>);

  let bodyInit: BodyInit | undefined;
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD' && request.body != null) {
    if (Buffer.isBuffer(request.body)) {
      bodyInit = request.body;
    } else if (typeof request.body === 'string') {
      bodyInit = request.body;
    } else {
      bodyInit = JSON.stringify(request.body);
      forwardHeaders['content-type'] ??= 'application/json';
    }
  }

  try {
    const response = await fetch(targetUrl, { method, headers: forwardHeaders, body: bodyInit });

    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        void reply.header(key, value);
      }
    });

    const responseBody = Buffer.from(await response.arrayBuffer());
    await reply.status(response.status).send(responseBody);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    warn(`Proxy to worker failed for ${request.url}: ${errMsg}`);
    await reply.status(502).send(
      errorResponse('WORKER_UNREACHABLE', 'Worker unreachable.', errMsg),
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Master-mode transparent proxy routes.
 *
 * Proxies all session-specific and non-session-specific API calls to the
 * appropriate worker nodes. Also proxies the WebSocket stream.
 *
 * Only register this plugin when `config.nodeMode === 'master'`.
 */
const masterProxyRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /api/sessions (fan-out) ───────────────────────────────────────────

  /**
   * GET /api/sessions (master mode)
   *
   * Fans out to all healthy workers in parallel, merges their session arrays,
   * and returns a combined response.
   *
   * Workers that fail to respond are silently skipped (partial results).
   */
  fastify.get('/api/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const workers = workerRegistryService.getHealthyWorkers();

    if (workers.length === 0) {
      // No workers — return empty sessions list (not an error).
      return reply.status(200).send({ success: true, data: { sessions: [] } });
    }

    const forwardHeaders = buildForwardHeaders(request.headers as Record<string, string | string[] | undefined>);

    const results = await Promise.allSettled(
      workers.map(async (worker) => {
        const resp = await fetch(`${worker.url}${request.url}`, { headers: forwardHeaders });
        const data = await resp.json() as { success: boolean; data?: { sessions?: Session[] } };
        return (data.success && data.data?.sessions) ? data.data.sessions : [];
      }),
    );

    const allSessions: Session[] = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );

    log(`Fan-out GET /api/sessions: ${allSessions.length} sessions from ${workers.length} worker(s)`);
    return reply.status(200).send({ success: true, data: { sessions: allSessions } });
  });

  // ── Session-specific HTTP routes (proxy via routing table) ─────────────────

  /**
   * GET /api/sessions/:id — proxy to owning worker
   */
  fastify.get('/api/sessions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/button — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/button', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/rotate — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/shake — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/shake', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * GET /api/sessions/:id/control/screenshot — proxy to owning worker
   */
  fastify.get('/api/sessions/:id/control/screenshot', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/clipboard — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/clipboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * GET /api/sessions/:id/control/clipboard — proxy to owning worker
   */
  fastify.get('/api/sessions/:id/control/clipboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/open-url — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/open-url', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/control/send-text — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/control/send-text', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  /**
   * POST /api/sessions/:id/apps — proxy to owning worker
   */
  fastify.post('/api/sessions/:id/apps', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return sessionRouterService.proxyRequest(id, request, reply);
  });

  // ── Non-session-specific HTTP routes (proxy to any healthy worker) ─────────

  /**
   * GET /api/devices — proxy to first healthy worker
   */
  fastify.get('/api/devices', async (request: FastifyRequest, reply: FastifyReply) => {
    return proxyToAnyWorker(request, reply);
  });

  /**
   * GET /api/devices/:platform — proxy to first healthy worker
   */
  fastify.get('/api/devices/:platform', async (request: FastifyRequest, reply: FastifyReply) => {
    return proxyToAnyWorker(request, reply);
  });

  /**
   * GET /api/runtimes — proxy to first healthy worker
   */
  fastify.get('/api/runtimes', async (request: FastifyRequest, reply: FastifyReply) => {
    return proxyToAnyWorker(request, reply);
  });

  /**
   * GET /api/runtimes/:platform — proxy to first healthy worker
   */
  fastify.get('/api/runtimes/:platform', async (request: FastifyRequest, reply: FastifyReply) => {
    return proxyToAnyWorker(request, reply);
  });

  /**
   * POST /api/runtimes/download — proxy to first healthy worker
   */
  fastify.post('/api/runtimes/download', async (request: FastifyRequest, reply: FastifyReply) => {
    return proxyToAnyWorker(request, reply);
  });

  // ── WebSocket stream proxy ────────────────────────────────────────────────

  /**
   * GET /ws/stream/:sessionId (WebSocket, master mode)
   *
   * Proxies the browser WebSocket to the worker that owns the session by
   * calling `sessionRouterService.proxyWebSocket()`.
   *
   * The proxyWebSocket method opens a worker-side WebSocket and bidirectionally
   * pipes all messages. Either side closing tears down both.
   *
   * IMPORTANT: The handler must be synchronous (not async) — @fastify/websocket
   * does not support async WebSocket handlers.
   */
  fastify.get(
    '/ws/stream/:sessionId',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };
      log(`WebSocket stream proxy for session ${sessionId}`);
      sessionRouterService.proxyWebSocket(sessionId, socket, request.url);
    },
  );
};

export default masterProxyRoutes;
