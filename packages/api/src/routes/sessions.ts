import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  Platform,
  Session,
  SessionStatus,
} from '@web-mobile-simulator/shared';
import { sessionManagerService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Route-local helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` if the given string is a valid {@link Platform} value.
 *
 * @param platform - The raw string to validate.
 */
function validatePlatform(platform: string): platform is Platform {
  return platform === 'ios' || platform === 'android';
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
// Route types
// ---------------------------------------------------------------------------

/** Fastify request shape for POST /api/sessions body. */
type CreateSessionRequestType = FastifyRequest<{ Body: CreateSessionRequest }>;

/** Fastify request shape for routes with a `:id` path param. */
type SessionIdParamRequest = FastifyRequest<{ Params: { id: string } }>;

/** Fastify request shape for GET /api/sessions with optional `?status` query param. */
type ListSessionsRequest = FastifyRequest<{ Querystring: { status?: string } }>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Session management route plugin.
 *
 * Registers endpoints for simulator session lifecycle:
 * - POST   /api/sessions       — Create a new simulator session
 * - GET    /api/sessions       — List all active sessions
 * - GET    /api/sessions/:id   — Get details of a specific session
 * - DELETE /api/sessions/:id   — Terminate a session
 */
const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/sessions
   *
   * Validates the {@link CreateSessionRequest} body, provisions a simulator
   * device for the requested platform, and returns the initialised session.
   *
   * Responds with:
   * - 201 Created   — session created successfully
   * - 400 Bad Request — invalid or missing body fields
   * - 500 Internal Server Error — service-level failure
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

      // --- Create the session ---
      try {
        const session: Session = await sessionManagerService.createSession(sessionRequest);
        const responseData: CreateSessionResponse = { session };
        return reply.code(201).send(successResponse(responseData));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'SESSION_CREATE_FAILED',
            'Failed to create simulator session.',
            String(error),
          ),
        );
      }
    },
  );

  /**
   * GET /api/sessions
   *
   * Returns all sessions currently tracked by the session manager.
   * An optional `?status` query parameter filters to a specific
   * {@link SessionStatus} (e.g. `?status=active`).
   *
   * Responds with:
   * - 200 OK — array of matching {@link Session} records
   */
  fastify.get(
    '/api/sessions',
    async (request: ListSessionsRequest, reply: FastifyReply) => {
      const { status } = request.query;

      const sessions: Session[] = status
        ? sessionManagerService.listSessions(status as SessionStatus)
        : sessionManagerService.listSessions();

      return reply.code(200).send(successResponse({ sessions }));
    },
  );

  /**
   * GET /api/sessions/:id
   *
   * Returns a single session by its ID.
   *
   * Responds with:
   * - 200 OK        — session found
   * - 404 Not Found — no session with the given ID
   */
  fastify.get(
    '/api/sessions/:id',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const session: Session | null = sessionManagerService.getSession(id);

      if (session === null) {
        return reply.code(404).send(
          errorResponse(
            'SESSION_NOT_FOUND',
            `Session "${id}" not found.`,
          ),
        );
      }

      return reply.code(200).send(successResponse({ session }));
    },
  );

  /**
   * DELETE /api/sessions/:id
   *
   * Terminates the session with the given ID, stops the VNC proxy, and
   * shuts down the underlying platform device.
   *
   * Responds with:
   * - 200 OK        — session terminated
   * - 404 Not Found — no session with the given ID
   * - 500 Internal Server Error — termination failure
   */
  fastify.delete(
    '/api/sessions/:id',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      // Verify the session exists before attempting termination.
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
        await sessionManagerService.terminateSession(id);
        return reply.code(200).send(successResponse({ message: 'Session terminated' }));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'SESSION_TERMINATE_FAILED',
            `Failed to terminate session "${id}".`,
            String(error),
          ),
        );
      }
    },
  );
};

export default sessionRoutes;
