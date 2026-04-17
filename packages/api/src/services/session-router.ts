import WebSocket from 'ws';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { sessionWorkerMapRepository } from '../db/session-worker-map-repository.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[SessionRouterService]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** In-memory routing entry for a single session. */
interface RouteEntry {
  /** UUID of the worker that owns this session. */
  workerId: string;
  /** Base URL of the owning worker (e.g. "http://10.0.1.10:3000"). */
  workerUrl: string;
}

// ---------------------------------------------------------------------------
// Hop-by-hop headers that must NOT be forwarded when proxying
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Routes session-specific requests from the master to the worker that owns
 * each session.
 *
 * Responsibilities:
 * - Maintain an in-memory `sessionId → { workerId, workerUrl }` routing table.
 * - Persist assignments to the `session_worker_map` SQLite table so the table
 *   survives master restarts.
 * - Proxy HTTP requests for a given session to the owning worker using the
 *   global `fetch` API (Node 20 built-in).
 * - Proxy WebSocket connections for a given session to the owning worker by
 *   tunnelling bidirectionally with the `ws` library.
 *
 * Export the singleton `sessionRouterService` rather than constructing
 * instances directly.
 */
export class SessionRouterService {
  /** In-memory routing table — primary source of truth for active sessions. */
  private readonly routes = new Map<string, RouteEntry>();

  // -------------------------------------------------------------------------
  // Public API — routing table management
  // -------------------------------------------------------------------------

  /**
   * Assign a session to a worker and persist the mapping.
   *
   * Called by the master's session-creation route after the worker confirms
   * the session has been created.
   *
   * @param sessionId - The session UUID returned by the worker.
   * @param workerId  - The UUID of the worker that owns the session.
   * @param workerUrl - The base URL of the owning worker.
   */
  assignSession(sessionId: string, workerId: string, workerUrl: string): void {
    this.routes.set(sessionId, { workerId, workerUrl });
    sessionWorkerMapRepository.create({
      sessionId,
      workerId,
      workerUrl,
      createdAt: new Date().toISOString(),
    });
    log(`Session ${sessionId} assigned to worker ${workerId} (${workerUrl})`);
  }

  /**
   * Return the base URL of the worker that owns the given session, or `null`
   * if the session is not in the routing table.
   *
   * @param sessionId - The session UUID to look up.
   * @returns Worker base URL string, or `null` if unknown.
   */
  resolveWorkerUrl(sessionId: string): string | null {
    return this.routes.get(sessionId)?.workerUrl ?? null;
  }

  /**
   * Return the worker ID that owns the given session, or `null` if unknown.
   *
   * @param sessionId - The session UUID to look up.
   * @returns Worker UUID string, or `null` if unknown.
   */
  resolveWorkerId(sessionId: string): string | null {
    return this.routes.get(sessionId)?.workerId ?? null;
  }

  /**
   * Remove the routing entry for a session and delete it from the DB.
   *
   * Should be called after a session is successfully terminated.
   *
   * @param sessionId - The session UUID to remove.
   */
  removeSession(sessionId: string): void {
    this.routes.delete(sessionId);
    sessionWorkerMapRepository.deleteBySessionId(sessionId);
    log(`Session ${sessionId} removed from routing table`);
  }

  /**
   * Load all session→worker mappings from the database into the in-memory
   * routing table.
   *
   * Should be called once during master-mode startup, after the DB is
   * initialised, to restore the routing state from before a restart.
   */
  rehydrate(): void {
    const entries = sessionWorkerMapRepository.findAll();
    for (const entry of entries) {
      this.routes.set(entry.sessionId, {
        workerId: entry.workerId,
        workerUrl: entry.workerUrl,
      });
    }
    log(`Rehydrated ${entries.length} session→worker mapping(s) from DB`);
  }

  // -------------------------------------------------------------------------
  // Public API — proxying
  // -------------------------------------------------------------------------

  /**
   * Proxy an HTTP request to the worker that owns the given session.
   *
   * - Strips hop-by-hop and `host` headers before forwarding.
   * - Re-serialises the request body to JSON if Fastify has already parsed it.
   * - Streams the worker response back to the browser client.
   * - Returns HTTP 404 if the session is not in the routing table.
   * - Returns HTTP 502 if the worker is unreachable or returns a network error.
   *
   * @param sessionId - Session UUID extracted from the request URL.
   * @param request   - The incoming Fastify request.
   * @param reply     - The Fastify reply to send the proxied response on.
   */
  async proxyRequest(
    sessionId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const workerUrl = this.resolveWorkerUrl(sessionId);

    if (!workerUrl) {
      await reply.status(404).send({
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Session "${sessionId}" not found on any worker.`,
        },
      });
      return;
    }

    const targetUrl = `${workerUrl}${request.url}`;

    // Build forwarded headers, dropping hop-by-hop and host.
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (
        !HOP_BY_HOP.has(k.toLowerCase()) &&
        k.toLowerCase() !== 'host' &&
        typeof v === 'string'
      ) {
        forwardHeaders[k] = v;
      }
    }

    // Determine body — re-serialize if Fastify has already parsed it.
    let bodyInit: BodyInit | undefined;
    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body != null;

    if (hasBody) {
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
      const response = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: bodyInit,
      });

      // Forward response headers, dropping hop-by-hop.
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          void reply.header(key, value);
        }
      });

      const responseBody = Buffer.from(await response.arrayBuffer());
      await reply.status(response.status).send(responseBody);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      warn(`Proxy failed for session ${sessionId} → ${targetUrl}: ${errMsg}`);
      await reply.status(502).send({
        success: false,
        error: {
          code: 'WORKER_UNREACHABLE',
          message: 'Worker unreachable.',
          details: errMsg,
        },
      });
    }
  }

  /**
   * Proxy a WebSocket connection to the worker that owns the given session.
   *
   * Opens a new `ws` WebSocket to the worker at `workerUrl + pathWithQuery`,
   * then bidirectionally pipes all messages (binary and text) between the
   * browser socket and the worker socket.  Either side closing or erroring
   * tears down both sockets.
   *
   * Closes the browser socket immediately with code 1008 if the session is
   * not in the routing table.
   *
   * @param sessionId     - Session UUID for routing lookup and log messages.
   * @param browserSocket - The raw `ws` WebSocket from the browser client.
   * @param pathWithQuery - Full path + query string to append to the worker
   *                        base URL (e.g. `"/ws/stream/abc123?format=h264"`).
   */
  proxyWebSocket(
    sessionId: string,
    browserSocket: WebSocket,
    pathWithQuery: string,
  ): void {
    const workerUrl = this.resolveWorkerUrl(sessionId);

    if (!workerUrl) {
      warn(`WebSocket proxy: session ${sessionId} not found — closing browser socket`);
      browserSocket.close(1008, 'Session not found');
      return;
    }

    // Convert http(s) base URL to ws(s) for the WebSocket connection.
    const wsWorkerUrl = workerUrl.replace(/^http/, 'ws') + pathWithQuery;
    log(`Proxying WebSocket for session ${sessionId} → ${wsWorkerUrl}`);

    const workerSocket = new WebSocket(wsWorkerUrl);

    // Idempotent teardown helpers.
    const closeWorker = (): void => {
      if (workerSocket.readyState < WebSocket.CLOSING) {
        workerSocket.close();
      }
    };

    const closeBrowser = (): void => {
      if (browserSocket.readyState < WebSocket.CLOSING) {
        browserSocket.close();
      }
    };

    // Once the worker socket is open, wire up bidirectional message pipes.
    workerSocket.on('open', () => {
      log(`Worker WebSocket connected for session ${sessionId}`);

      // Browser → Worker
      browserSocket.on('message', (data, isBinary) => {
        if (workerSocket.readyState === WebSocket.OPEN) {
          workerSocket.send(data as Buffer, { binary: isBinary });
        }
      });

      // Worker → Browser
      workerSocket.on('message', (data, isBinary) => {
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.send(data as Buffer, { binary: isBinary });
        }
      });
    });

    // Teardown on close / error from either side.
    browserSocket.on('close', () => {
      log(`Browser WebSocket closed for session ${sessionId} — closing worker socket`);
      closeWorker();
    });

    workerSocket.on('close', () => {
      log(`Worker WebSocket closed for session ${sessionId} — closing browser socket`);
      closeBrowser();
    });

    browserSocket.on('error', (err: Error) => {
      warn(`Browser WebSocket error for session ${sessionId}: ${err.message}`);
      closeWorker();
    });

    workerSocket.on('error', (err: Error) => {
      warn(`Worker WebSocket error for session ${sessionId}: ${err.message}`);
      closeBrowser();
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const sessionRouterService = new SessionRouterService();
