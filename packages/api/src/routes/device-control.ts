import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiResponse,
  DeviceOrientation,
  GetClipboardResponse,
  OpenUrlRequest,
  PressButtonRequest,
  SendTextRequest,
  SetClipboardRequest,
  SetOrientationRequest,
  SimulatorButton,
} from '@web-mobile-simulator/shared';
import { sessionManagerService, iosSimulatorService, androidEmulatorService } from '../services/index.js';
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

/** Fastify request shape for clipboard set endpoint. */
type SetClipboardRequestType = FastifyRequest<{
  Params: { id: string };
  Body: SetClipboardRequest;
}>;

/** Fastify request shape for open-url endpoint. */
type OpenUrlRequestType = FastifyRequest<{
  Params: { id: string };
  Body: OpenUrlRequest;
}>;

/** Fastify request shape for send-text endpoint. */
type SendTextRequestType = FastifyRequest<{
  Params: { id: string };
  Body: SendTextRequest;
}>;

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
 * Look up a session and verify it is active.
 * Returns the session on success, or sends an error reply and returns `null`.
 *
 * @param id    - Session UUID from the route param.
 * @param reply - The Fastify reply instance.
 * @returns The session, or `null` if a response has already been sent.
 */
async function resolveActiveSession(
  id: string,
  reply: FastifyReply,
): Promise<import('@web-mobile-simulator/shared').Session | null> {
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

  return session;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Device control route plugin.
 *
 * Registers endpoints for hardware-level simulator/emulator interactions that
  * cannot be performed through the stream (iOS and Android supported unless
 * noted):
 * - POST /api/sessions/:id/control/button     — Press a hardware button
 * - POST /api/sessions/:id/control/rotate     — Set device orientation
 * - POST /api/sessions/:id/control/shake      — Trigger a shake gesture (iOS only)
 * - GET  /api/sessions/:id/control/screenshot — Capture and return a PNG screenshot
 * - POST /api/sessions/:id/control/clipboard  — Set clipboard text
 * - GET  /api/sessions/:id/control/clipboard  — Get clipboard text
 * - POST /api/sessions/:id/control/open-url   — Open a URL or deep-link
 * - POST /api/sessions/:id/control/send-text  — Type text into the focused field
 */
const deviceControlRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/sessions/:id/control/button ──────────────────────────────────

  /**
   * Press a hardware button on the session's simulator or emulator (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — button pressed successfully
   * - 400 Bad Request  — invalid button name or session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
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

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.pressButton(session.device.platformDeviceId, button);
        } else {
          await androidEmulatorService.pressButton(session.device.platformDeviceId, button);
        }
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to press button.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/rotate ──────────────────────────────────

  /**
   * Set the orientation of the session's simulator or emulator (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — orientation set successfully
   * - 400 Bad Request  — invalid orientation or session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
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

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.setOrientation(session.device.platformDeviceId, orientation);
        } else {
          await androidEmulatorService.setOrientation(session.device.platformDeviceId, orientation);
        }
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to set orientation.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/shake ───────────────────────────────────

  /**
   * Trigger a shake gesture on the session's iOS simulator.
   *
   * Note: Shake is iOS-only. Android sessions receive a 400 with
   * `UNSUPPORTED_ACTION`.
   *
   * Responds with:
   * - 200 OK           — shake triggered successfully
   * - 400 Bad Request  — session not active or Android session
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
   */
  fastify.post(
    '/api/sessions/:id/control/shake',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      if (session.device.platform !== 'ios') {
        return reply.code(400).send(
          errorResponse('UNSUPPORTED_ACTION', 'Shake gesture is not supported on Android.'),
        );
      }

      try {
        await iosSimulatorService.shake(session.device.platformDeviceId);
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to trigger shake.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── GET /api/sessions/:id/control/screenshot ───────────────────────────────

  /**
   * Capture a PNG screenshot of the session's simulator or emulator and return
   * it as a binary response with content-type `image/png`.
   *
   * The screenshot is written to a temporary file, read into memory, returned
   * to the client, and then cleaned up — all in a single request cycle.
   *
   * Responds with:
   * - 200 OK           — PNG image body
   * - 400 Bad Request  — session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
   * - 500 Internal Server Error — temp file read failure
   */
  fastify.get(
    '/api/sessions/:id/control/screenshot',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      const tempPath = join(tmpdir(), `screenshot-${id}-${Date.now()}.png`);

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.takeScreenshot(session.device.platformDeviceId, tempPath);
        } else {
          await androidEmulatorService.takeScreenshot(session.device.platformDeviceId, tempPath);
        }

        const imageBuffer = await readFile(tempPath);
        return reply.code(200).type('image/png').send(imageBuffer);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Failed to take screenshot.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      } finally {
        // Always clean up the temp file, whether the request succeeded or not.
        await unlink(tempPath).catch(() => {
          // Ignore cleanup errors — file may not exist if the command failed before writing.
        });
      }
    },
  );

  // ── POST /api/sessions/:id/control/clipboard ───────────────────────────────

  /**
   * Set the clipboard text on the session's simulator or emulator (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — clipboard set successfully
   * - 400 Bad Request  — missing/invalid text or session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
   */
  fastify.post(
    '/api/sessions/:id/control/clipboard',
    async (request: SetClipboardRequestType, reply: FastifyReply) => {
      const { id } = request.params;
      const { text } = (request.body ?? {}) as Partial<SetClipboardRequest>;

      if (text === undefined || text === null || typeof text !== 'string') {
        return reply.code(400).send(
          errorResponse('INVALID_TEXT', '"text" is required and must be a string.'),
        );
      }

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.setClipboard(session.device.platformDeviceId, text);
        } else {
          await androidEmulatorService.setClipboard(session.device.platformDeviceId, text);
        }
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to set clipboard.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── GET /api/sessions/:id/control/clipboard ────────────────────────────────

  /**
   * Get the clipboard text from the session's simulator or emulator (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — `{ text: string }` payload
   * - 400 Bad Request  — session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — device command failed
   */
  fastify.get(
    '/api/sessions/:id/control/clipboard',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      const { id } = request.params;

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        const text = session.device.platform === 'ios'
          ? await iosSimulatorService.getClipboard(session.device.platformDeviceId)
          : await androidEmulatorService.getClipboard(session.device.platformDeviceId);
        return reply.code(200).send(successResponse<GetClipboardResponse>({ text }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to get clipboard.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/open-url ────────────────────────────────

  /**
   * Open a URL or deep-link on the session's device (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — URL opened successfully
   * - 400 Bad Request  — missing/invalid URL, session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — command failed
   */
  fastify.post(
    '/api/sessions/:id/control/open-url',
    async (request: OpenUrlRequestType, reply: FastifyReply) => {
      const { id } = request.params;
      const { url } = (request.body ?? {}) as Partial<OpenUrlRequest>;

      if (!url || typeof url !== 'string' || url.trim() === '') {
        return reply.code(400).send(
          errorResponse('INVALID_URL', '"url" is required and must be a non-empty string.'),
        );
      }

      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.openUrl(session.device.platformDeviceId, url.trim());
        } else {
          // For Android, platformDeviceId is the AVD name
          await androidEmulatorService.openUrl(session.device.platformDeviceId, url.trim());
        }
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to open URL.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );

  // ── POST /api/sessions/:id/control/send-text ───────────────────────────────

  /**
   * Type text into the currently focused field on the session's device
   * (iOS and Android supported).
   *
   * Responds with:
   * - 200 OK           — text sent successfully
   * - 400 Bad Request  — missing/invalid text, session not active
   * - 404 Not Found    — session does not exist
   * - 502 Bad Gateway  — command failed
   */
  fastify.post(
    '/api/sessions/:id/control/send-text',
    async (request: SendTextRequestType, reply: FastifyReply) => {
      const { id } = request.params;
      const { text } = (request.body ?? {}) as Partial<SendTextRequest>;

      if (text === undefined || text === null || typeof text !== 'string') {
        return reply.code(400).send(
          errorResponse('INVALID_TEXT', '"text" is required and must be a string.'),
        );
      }

      // Allow empty string (it's a valid "type nothing" case, though unusual)
      const session = await resolveActiveSession(id, reply);
      if (session === null) return;

      try {
        if (session.device.platform === 'ios') {
          await iosSimulatorService.sendText(session.device.platformDeviceId, text);
        } else {
          await androidEmulatorService.sendText(session.device.platformDeviceId, text);
        }
        return reply.code(200).send(successResponse({ success: true }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to send text.';
        return reply.code(502).send(
          errorResponse('COMMAND_ERROR', message, String(error)),
        );
      }
    },
  );
};

export default deviceControlRoutes;
