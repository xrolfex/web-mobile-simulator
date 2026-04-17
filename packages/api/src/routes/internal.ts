import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type {
  WorkerRegistrationRequest,
  WorkerHeartbeatRequest,
} from '@web-mobile-simulator/shared';
import { config } from '../config.js';
import { workerRegistryService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[InternalRoutes]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

/**
 * Build a typed error response envelope.
 *
 * @param code    - Machine-readable error code.
 * @param message - Human-readable description.
 * @param details - Optional extra context (e.g. caught error message).
 */
function errorResponse(code: string, message: string, details?: unknown) {
  return { success: false, error: { code, message, details } };
}

/**
 * Wrap a successful payload in the standard response envelope.
 *
 * @param data - The payload to wrap.
 */
function successResponse<T>(data: T) {
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the request carries a valid `Authorization: Bearer <secret>`
 * header matching `config.workerSecret`.
 *
 * Always returns false if `config.workerSecret` is empty (misconfigured master).
 */
function isAuthorized(request: FastifyRequest): boolean {
  if (!config.workerSecret) return false;
  const auth = request.headers.authorization ?? '';
  return auth === `Bearer ${config.workerSecret}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Internal route plugin — worker ↔ master registration and health signalling.
 *
 * All routes require `Authorization: Bearer <WORKER_SECRET>`.
 * Only register this plugin in `master` mode.
 *
 * Registers:
 * - POST   /internal/workers/register              — worker initial registration
 * - POST   /internal/workers/:workerId/heartbeat   — periodic heartbeat
 * - DELETE /internal/workers/:workerId             — graceful deregistration
 * - GET    /internal/workers                       — admin: list all workers
 */
const internalRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /internal/workers/register ──────────────────────────────────────

  /**
   * POST /internal/workers/register
   *
   * Called by a worker on startup to announce itself to the master.
   * Assigns a UUID to the worker and begins event-stream aggregation.
   *
   * Body: WorkerRegistrationRequest
   * - url              string — worker's publicly-reachable base URL
   * - maxIosSessions   number — max concurrent iOS sessions this worker accepts
   * - maxAndroidSessions number — max concurrent Android sessions
   * - secret           string — shared secret (also validated via Authorization header)
   *
   * Responds with:
   * - 201 Created     — { workerId: string, heartbeatIntervalMs: number }
   * - 400 Bad Request — missing/invalid fields
   * - 401 Unauthorized — invalid or missing Authorization header
   */
  fastify.post(
    '/internal/workers/register',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAuthorized(request)) {
        warn('Registration attempt with invalid secret');
        return reply.status(401).send(
          errorResponse('UNAUTHORIZED', 'Invalid or missing worker secret.'),
        );
      }

      const body = request.body as Partial<WorkerRegistrationRequest> | undefined;

      if (!body || typeof body !== 'object') {
        return reply.status(400).send(
          errorResponse('INVALID_REQUEST', 'Request body is required.'),
        );
      }

      if (!body.url || typeof body.url !== 'string' || body.url.trim() === '') {
        return reply.status(400).send(
          errorResponse('INVALID_REQUEST', '"url" is required and must be a non-empty string.'),
        );
      }

      if (
        typeof body.maxIosSessions !== 'number' ||
        typeof body.maxAndroidSessions !== 'number'
      ) {
        return reply.status(400).send(
          errorResponse(
            'INVALID_REQUEST',
            '"maxIosSessions" and "maxAndroidSessions" are required numbers.',
          ),
        );
      }

      const registrationReq: WorkerRegistrationRequest = {
        url: body.url.trim(),
        maxIosSessions: body.maxIosSessions,
        maxAndroidSessions: body.maxAndroidSessions,
        secret: body.secret ?? '',
      };

      const response = workerRegistryService.registerWorker(registrationReq);
      log(`Worker registered: ${response.workerId} at ${registrationReq.url}`);

      return reply.status(201).send(successResponse(response));
    },
  );

  // ── POST /internal/workers/:workerId/heartbeat ────────────────────────────

  /**
   * POST /internal/workers/:workerId/heartbeat
   *
   * Called by a registered worker at regular intervals to report it is still
   * alive and to update its current session counts.
   *
   * Body: WorkerHeartbeatRequest
   * - currentIosSessions     number
   * - currentAndroidSessions number
   *
   * Responds with:
   * - 204 No Content  — heartbeat recorded
   * - 400 Bad Request — missing/invalid body fields
   * - 401 Unauthorized
   * - 404 Not Found   — workerId not in registry
   */
  fastify.post(
    '/internal/workers/:workerId/heartbeat',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAuthorized(request)) {
        return reply.status(401).send(
          errorResponse('UNAUTHORIZED', 'Invalid or missing worker secret.'),
        );
      }

      const { workerId } = request.params as { workerId: string };
      const body = request.body as Partial<WorkerHeartbeatRequest> | undefined;

      if (
        !body ||
        typeof body.currentIosSessions !== 'number' ||
        typeof body.currentAndroidSessions !== 'number'
      ) {
        return reply.status(400).send(
          errorResponse(
            'INVALID_REQUEST',
            '"currentIosSessions" and "currentAndroidSessions" are required numbers.',
          ),
        );
      }

      const updated = workerRegistryService.updateHeartbeat(workerId, body as WorkerHeartbeatRequest);

      if (!updated) {
        return reply.status(404).send(
          errorResponse('WORKER_NOT_FOUND', `Worker "${workerId}" not found in registry.`),
        );
      }

      return reply.status(204).send();
    },
  );

  // ── DELETE /internal/workers/:workerId ────────────────────────────────────

  /**
   * DELETE /internal/workers/:workerId
   *
   * Called by a worker during graceful shutdown to cleanly remove itself from
   * the registry.
   *
   * Responds with:
   * - 204 No Content — worker removed (or was already absent)
   * - 401 Unauthorized
   */
  fastify.delete(
    '/internal/workers/:workerId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAuthorized(request)) {
        return reply.status(401).send(
          errorResponse('UNAUTHORIZED', 'Invalid or missing worker secret.'),
        );
      }

      const { workerId } = request.params as { workerId: string };
      workerRegistryService.removeWorker(workerId);
      log(`Worker deregistered: ${workerId}`);

      return reply.status(204).send();
    },
  );

  // ── GET /internal/workers ─────────────────────────────────────────────────

  /**
   * GET /internal/workers
   *
   * Admin-facing endpoint that returns the current state of all registered
   * workers (healthy and unhealthy).
   *
   * Responds with:
   * - 200 OK           — { workers: WorkerNode[] }
   * - 401 Unauthorized
   */
  fastify.get(
    '/internal/workers',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAuthorized(request)) {
        return reply.status(401).send(
          errorResponse('UNAUTHORIZED', 'Invalid or missing worker secret.'),
        );
      }

      const workers = workerRegistryService.getAllWorkers();
      return reply.status(200).send(successResponse({ workers }));
    },
  );
};

export default internalRoutes;
