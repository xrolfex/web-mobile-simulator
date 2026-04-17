import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type {
  ApiResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  Platform,
  Session,
} from '@web-mobile-simulator/shared';
import { workerRegistryService, sessionRouterService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[MasterSessionsRoute]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

/**
 * Build a typed error {@link ApiResponse}.
 *
 * @param code    - Machine-readable error code.
 * @param message - Human-readable description.
 * @param details - Optional extra context (e.g. caught error message).
 */
function errorResponse(
  code: string,
  message: string,
  details?: unknown,
): ApiResponse<never> {
  return { success: false, error: { code, message, details } };
}

/**
 * Wrap a successful payload in the standard {@link ApiResponse} envelope.
 *
 * @param data - The payload to wrap.
 */
function successResponse<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Hop-by-hop headers that must NOT be forwarded
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
// Platform validation
// ---------------------------------------------------------------------------

/**
 * Return `true` if the given string is a valid {@link Platform} value.
 *
 * @param platform - The raw string to validate.
 */
function validatePlatform(platform: string): platform is Platform {
  return platform === 'ios' || platform === 'android';
}

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

/** Fastify request shape for POST /api/sessions body. */
type CreateSessionRequestType = FastifyRequest<{ Body: CreateSessionRequest }>;

/** Fastify request shape for routes with a `:id` path param. */
type SessionIdParamRequest = FastifyRequest<{ Params: { id: string } }>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Master-mode session lifecycle routes.
 *
 * Handles session creation (with worker selection and routing assignment) and
 * deletion (with proxy-to-worker and routing cleanup).
 *
 * Only register this plugin when `config.nodeMode === 'master'`.
 *
 * Registers:
 * - POST   /api/sessions      — Pick a worker, forward create, record assignment
 * - DELETE /api/sessions/:id  — Proxy delete to owning worker, clean up routing
 */
const masterSessionsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/sessions ─────────────────────────────────────────────────────

  /**
   * POST /api/sessions (master mode)
   *
   * 1. Validates the request body (same rules as the worker-mode sessions route).
   * 2. Calls `workerRegistryService.pickWorker(platform)` to select the
   *    least-loaded healthy worker with remaining capacity.
   * 3. Forwards the create request to `{worker.url}/api/sessions`.
   * 4. On success (2xx from worker), parses the response to extract `session.id`
   *    and calls `sessionRouterService.assignSession()` to record the mapping.
   * 5. Returns the worker's response to the frontend unchanged.
   *
   * Responds with:
   * - 201 Created             — session created on chosen worker
   * - 400 Bad Request         — invalid/missing body fields
   * - 503 Service Unavailable — no healthy worker with capacity for the platform
   * - 502 Bad Gateway         — worker unreachable or network error
   */
  fastify.post(
    '/api/sessions',
    async (request: CreateSessionRequestType, reply: FastifyReply) => {
      const body = request.body as Partial<CreateSessionRequest> | undefined;

      // --- Validate request body ---
      if (!body || typeof body !== 'object') {
        return reply
          .code(400)
          .send(errorResponse('INVALID_REQUEST', 'Request body is required.'));
      }

      const { platform, runtimeId, deviceTypeId } = body;

      if (!platform || !validatePlatform(platform)) {
        return reply.code(400).send(
          errorResponse(
            'INVALID_PLATFORM',
            `Invalid or missing "platform". Must be "ios" or "android".`,
          ),
        );
      }

      if (!runtimeId || typeof runtimeId !== 'string' || runtimeId.trim() === '') {
        return reply.code(400).send(
          errorResponse(
            'INVALID_RUNTIME_ID',
            '"runtimeId" is required and must be a non-empty string.',
          ),
        );
      }

      if (!deviceTypeId || typeof deviceTypeId !== 'string' || deviceTypeId.trim() === '') {
        return reply.code(400).send(
          errorResponse(
            'INVALID_DEVICE_TYPE_ID',
            '"deviceTypeId" is required and must be a non-empty string.',
          ),
        );
      }

      const sessionRequest: CreateSessionRequest = {
        platform,
        runtimeId: runtimeId.trim(),
        deviceTypeId: deviceTypeId.trim(),
      };

      // --- Pick a worker ---
      const worker = workerRegistryService.pickWorker(platform);
      if (!worker) {
        return reply.code(503).send(
          errorResponse(
            'NO_WORKERS_AVAILABLE',
            `No healthy worker with ${platform} capacity is currently available.`,
          ),
        );
      }

      log(`Forwarding session create (platform=${platform}) to worker ${worker.id} (${worker.url})`);

      // --- Forward to worker ---
      try {
        const response = await fetch(`${worker.url}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sessionRequest),
        });

        // Forward response headers (drop hop-by-hop).
        response.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            void reply.header(key, value);
          }
        });

        const responseBuffer = Buffer.from(await response.arrayBuffer());

        // If worker returned success (2xx), extract the session ID and record routing.
        if (response.ok) {
          try {
            const parsed = JSON.parse(responseBuffer.toString()) as ApiResponse<CreateSessionResponse>;
            const sessionId = (parsed as { success: boolean; data?: { session?: Session } }).data?.session?.id;

            if (sessionId) {
              sessionRouterService.assignSession(sessionId, worker.id, worker.url);
              log(`Session ${sessionId} assigned to worker ${worker.id}`);
            } else {
              warn(`Worker ${worker.id} returned success but session ID could not be parsed`);
            }
          } catch {
            warn(`Failed to parse session creation response from worker ${worker.id}`);
          }
        }

        return reply.code(response.status).send(responseBuffer);

      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        warn(`Failed to forward session create to worker ${worker.id}: ${errMsg}`);
        return reply.code(502).send(
          errorResponse('WORKER_UNREACHABLE', 'Failed to reach the selected worker.', errMsg),
        );
      }
    },
  );

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────────

  /**
   * DELETE /api/sessions/:id (master mode)
   *
   * 1. Resolves the owning worker URL from `sessionRouterService`.
   * 2. Proxies the DELETE request to `{workerUrl}/api/sessions/{id}`.
   * 3. Always removes the routing entry from `sessionRouterService` after
   *    the proxy attempt completes (even on error), to avoid stale mappings.
   * 4. Returns the worker's response to the frontend.
   *
   * Responds with:
   * - 200 OK          — session terminated (worker response forwarded)
   * - 404 Not Found   — session not in master routing table
   * - 502 Bad Gateway — worker unreachable
   */
  fastify.delete(
    '/api/sessions/:id',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const workerUrl = sessionRouterService.resolveWorkerUrl(id);
      if (!workerUrl) {
        return reply.code(404).send(
          errorResponse('SESSION_NOT_FOUND', `Session "${id}" not found.`),
        );
      }

      log(`Forwarding session delete (id=${id}) to worker at ${workerUrl}`);

      try {
        const response = await fetch(`${workerUrl}/api/sessions/${id}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
        });

        // Forward response headers (drop hop-by-hop).
        response.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            void reply.header(key, value);
          }
        });

        const responseBuffer = Buffer.from(await response.arrayBuffer());
        return reply.code(response.status).send(responseBuffer);

      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        warn(`Failed to forward session delete to worker at ${workerUrl}: ${errMsg}`);
        return reply.code(502).send(
          errorResponse('WORKER_UNREACHABLE', 'Worker unreachable during session termination.', errMsg),
        );
      } finally {
        // Always remove the routing entry to avoid stale mappings,
        // regardless of whether the worker responded successfully.
        sessionRouterService.removeSession(id);
        log(`Session ${id} removed from routing table`);
      }
    },
  );
};

export default masterSessionsRoutes;
