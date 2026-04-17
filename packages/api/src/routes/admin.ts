import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse, Session } from '@web-mobile-simulator/shared';
import { sessionManagerService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Route-local helpers
// ---------------------------------------------------------------------------

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
// Route types
// ---------------------------------------------------------------------------

/** Fastify request shape for routes with a `:id` path param. */
type SessionIdParamRequest = FastifyRequest<{ Params: { id: string } }>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Admin route plugin.
 *
 * Registers privileged endpoints for session management and history cleanup:
 * - GET    /api/admin/sessions          — List ALL sessions with capacity info
 * - DELETE /api/admin/sessions/history  — Clear all terminated/error sessions
 * - DELETE /api/admin/sessions/:id      — Force-purge a single session
 *
 * IMPORTANT: The `/history` route is registered before `/:id` so that Fastify
 * does not treat the literal string "history" as a session ID parameter.
 */
const adminRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/admin/sessions
   *
   * Returns all sessions tracked by the session manager (regardless of status)
   * together with current capacity information.
   *
   * Responds with:
   * - 200 OK — array of all {@link Session} records plus capacity snapshot
   */
  fastify.get(
    '/api/admin/sessions',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const sessions: Session[] = sessionManagerService.listSessions();
      const capacity = sessionManagerService.getCapacityInfo();

      return reply.code(200).send(successResponse({ sessions, capacity }));
    },
  );

  /**
   * DELETE /api/admin/sessions/history
   *
   * Removes all sessions with status `terminated` or `error` from both the
   * in-memory store and the database.
   *
   * Responds with:
   * - 200 OK — history cleared, includes count of removed sessions
   */
  fastify.delete(
    '/api/admin/sessions/history',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const count = sessionManagerService.clearHistory();

      return reply.code(200).send(
        successResponse({
          message: `Cleared ${count} terminated/error session(s) from history.`,
          count,
        }),
      );
    },
  );

  /**
   * DELETE /api/admin/sessions/:id
   *
   * Force-purges a single session from both the in-memory store and the
   * database, regardless of its current status.  If the session is `active`
   * or `creating`, screen capture is stopped and a best-effort device teardown
   * is attempted before deletion.
   *
   * Responds with:
   * - 200 OK        — session purged successfully
   * - 404 Not Found — no session with the given ID
   * - 500 Internal Server Error — purge failure
   */
  fastify.delete(
    '/api/admin/sessions/:id',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      // Verify the session exists before attempting the purge.
      const session: Session | null = sessionManagerService.getSession(id);

      if (session === null) {
        return reply.code(404).send(
          errorResponse(
            'SESSION_NOT_FOUND',
            `Session "${id}" not found.`,
          ),
        );
      }

      try {
        await sessionManagerService.forcePurgeSession(id);
        return reply.code(200).send(successResponse({ message: 'Session purged' }));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'SESSION_PURGE_FAILED',
            `Failed to purge session "${id}".`,
            String(error),
          ),
        );
      }
    },
  );
};

export default adminRoutes;
