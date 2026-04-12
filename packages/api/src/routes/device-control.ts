import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiResponse,
  DeviceOrientation,
  PressButtonRequest,
  SetOrientationRequest,
  SimulatorButton,
} from '@web-mobile-simulator/shared';
import { sessionManagerService, iosSimulatorService } from '../services/index.js';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Route-local helpers
// ---------------------------------------------------------------------------

/**
 * Build a typed error {@link ApiResponse}.
 *
 * @param code    - Machine-readable error code.
 * @param message - Human-readable description.
 * @param details - Optional extra context.
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

/** Fastify request shape for button-press endpoint. */
type PressButtonRequestType = FastifyRequest<{
  Params: { id: string };
  Body: PressButtonRequest;
}>;

/** Fastify request shape for orientation endpoint. */
type SetOrientationRequestType = FastifyRequest<{
  Params: { id: string };
  Body: SetOrientationRequest;
}>;

/** Fastify request shape for routes with only a `:id` path param. */
type SessionIdParamRequest = FastifyRequest<{ Params: { id: string } }>;

// ---------------------------------------------------------------------------
// Valid value sets
// ---------------------------------------------------------------------------

const VALID_BUTTONS: SimulatorButton[] = ['home', 'lock', 'volumeUp', 'volumeDown'];

const VALID_ORIENTATIONS: DeviceOrientation[] = [
  'portrait',
  'landscapeLeft',
  'landscapeRight',
  'portraitUpsideDown',
];

// ---------------------------------------------------------------------------
// Shared session-validation helper
// ---------------------------------------------------------------------------

/**
 * Look up a session and verify it is active on an iOS device.
 * Returns the session's `platformDeviceId` (UDID) on success, or sends an
 * error reply and returns `null` on failure.
 *
 * @param id     - Session UUID from the route param.
 * @param reply  - The Fastify reply instance used to send error responses.
 * @returns The simulator UDID, or `null` if a response has already been sent.
 */
async function resolveIosSession(
  id: string,
  reply: FastifyReply,
): Promise<string | null> {
  const session = sessionManagerService.getSession(id);

  if (session === null) {
    await reply.code(404).send(
      errorResponse('SESSION_NOT_FOUND', `Session "${id}" not found.`),
    );
    return null;
  }

  if (session.status !== 'active') {
    await reply.code(400).send(
      errorResponse(
        'SESSION_NOT_ACTIVE',
        `Session is "${session.status}", not active.`,
      ),
    );
    return null;
  }

  if (session.device.platform !== 'ios') {
    await reply.code(400).send(
      errorResponse(
        'UNSUPPORTED_PLATFORM',
        'Device control is not yet supported for Android.',
      ),
    );
    return null;
  }

  return session.device.platformDeviceId;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Device control route plugin.
 *
 * Registers endpoints for hardware-level simulator interactions that cannot
 * be performed through the VNC stream:
 * - POST /api/sessions/:id/control/button     — Press a hardware button
 * - POST /api/sessions/:id/control/rotate     — Set device orientation
 * - POST /api/sessions/:id/control/shake      — Trigger a shake gesture
 * - GET  /api/sessions/:id/control/screenshot — Capture and return a PNG screenshot
 */
const deviceControlRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/sessions/:id/control/button ──────────────────────────────────

  /**
   * Press a hardware button on the session's iOS simulator.
   *
   * Responds with:
   * - 200 OK           — button pressed successfully
   * - 400 Bad Request  — invalid button name, session not active, or non-iOS platform
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — simctl command failed
   */
  fastify.post(
    '/api/sessions/:id/control/button',
    async (request: PressButtonRequestType, reply: FastifyReply) => {
      const { id } = request.params;
      const { button } = (request.body ?? {}) as Partial<PressButtonRequest>;

      if (!button || !VALID_BUTTONS.includes(button)) {
        return reply.code(400).send(
          errorResponse(
            'INVALID_BUTTON',
            `Invalid or missing "button". Valid options: ${VALID_BUTTONS.join(', ')}.`,
          ),
        );
      }

      const udid = await resolveIosSession(id, reply);
      if (udid === null) return;

      try {
        await iosSimulatorService.pressButton(udid, button);
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to press button.';
        return reply.code(502).send(
          errorResponse('SIMCTL_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/rotate ──────────────────────────────────

  /**
   * Set the orientation of the session's iOS simulator.
   *
   * Responds with:
   * - 200 OK           — orientation set successfully
   * - 400 Bad Request  — invalid orientation, session not active, or non-iOS platform
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — simctl command failed
   */
  fastify.post(
    '/api/sessions/:id/control/rotate',
    async (request: SetOrientationRequestType, reply: FastifyReply) => {
      const { id } = request.params;
      const { orientation } = (request.body ?? {}) as Partial<SetOrientationRequest>;

      if (!orientation || !VALID_ORIENTATIONS.includes(orientation)) {
        return reply.code(400).send(
          errorResponse(
            'INVALID_ORIENTATION',
            `Invalid or missing "orientation". Valid options: ${VALID_ORIENTATIONS.join(', ')}.`,
          ),
        );
      }

      const udid = await resolveIosSession(id, reply);
      if (udid === null) return;

      try {
        await iosSimulatorService.setOrientation(udid, orientation);
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to set orientation.';
        return reply.code(502).send(
          errorResponse('SIMCTL_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/shake ───────────────────────────────────

  /**
   * Trigger a shake gesture on the session's iOS simulator.
   *
   * Note: The shake command requires Xcode 15+ — an appropriate 502 is
   * returned for older installations.
   *
   * Responds with:
   * - 200 OK           — shake triggered successfully
   * - 400 Bad Request  — session not active or non-iOS platform
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — simctl command failed or not supported
   */
  fastify.post(
    '/api/sessions/:id/control/shake',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const udid = await resolveIosSession(id, reply);
      if (udid === null) return;

      try {
        await iosSimulatorService.shake(udid);
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to trigger shake.';
        return reply.code(502).send(
          errorResponse('SIMCTL_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── GET /api/sessions/:id/control/screenshot ───────────────────────────────

  /**
   * Capture a PNG screenshot of the session's iOS simulator and return it
   * as a binary response with content-type `image/png`.
   *
   * The screenshot is written to a temporary file, read into memory, returned
   * to the client, and then cleaned up — all in a single request cycle.
   *
   * Responds with:
   * - 200 OK           — PNG image body
   * - 400 Bad Request  — session not active or non-iOS platform
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — simctl command failed
   * - 500 Internal Server Error — temp file read failure
   */
  fastify.get(
    '/api/sessions/:id/control/screenshot',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const udid = await resolveIosSession(id, reply);
      if (udid === null) return;

      const tempPath = join(tmpdir(), `screenshot-${id}-${Date.now()}.png`);

      try {
        await iosSimulatorService.takeScreenshot(udid, tempPath);

        const imageBuffer = await readFile(tempPath);
        return reply.code(200).type('image/png').send(imageBuffer);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Failed to take screenshot.';
        return reply.code(502).send(
          errorResponse('SIMCTL_ERROR', message, String(error)),
        );
      } finally {
        // Always clean up the temp file, whether the request succeeded or not.
        await unlink(tempPath).catch(() => {
          // Ignore cleanup errors — file may not exist if simctl failed before writing.
        });
      }
    },
  );
};

export default deviceControlRoutes;
