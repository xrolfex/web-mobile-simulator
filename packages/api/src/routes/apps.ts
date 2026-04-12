import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse, AppUploadResponse } from '@web-mobile-simulator/shared';
import { ALLOWED_APP_EXTENSIONS } from '@web-mobile-simulator/shared';
import {
  sessionManagerService,
  appInstallService,
  androidEmulatorService,
} from '../services/index.js';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
 * App upload and install route plugin.
 *
 * Registers endpoints for uploading app binaries to simulator sessions:
 * - POST /api/sessions/:id/apps — Upload and install an app on a running session
 */
const appRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/sessions/:id/apps
   *
   * Accepts a multipart file upload, validates the session and file extension,
   * saves the file to a temp directory, delegates to {@link appInstallService},
   * and cleans up the temp file in a `finally` block.
   *
   * Responds with:
   * - 200 OK                  — app installed successfully
   * - 400 Bad Request         — session not active, no file, or invalid extension
   * - 404 Not Found           — session does not exist
   * - 413 Payload Too Large   — uploaded file exceeds the 2 GB limit
   * - 422 Unprocessable Entity — install command failed
   * - 500 Internal Server Error — unexpected failure
   */
  fastify.post(
    '/api/sessions/:id/apps',
    async (request: SessionIdParamRequest, reply: FastifyReply) => {
      let tempFilePath: string | null = null;

      try {
        const { id } = request.params;

        // --- Step 1: Look up the session ---
        const session = sessionManagerService.getSession(id);

        if (session === null) {
          return reply.code(404).send(
            errorResponse('SESSION_NOT_FOUND', `Session "${id}" not found.`),
          );
        }

        // --- Step 2: Validate session is active ---
        if (session.status !== 'active') {
          return reply.code(400).send(
            errorResponse(
              'SESSION_NOT_ACTIVE',
              `Session "${id}" is not active (current status: "${session.status}"). ` +
                `The session must be active to install apps.`,
            ),
          );
        }

        // --- Step 3: Get the multipart file ---
        let file: Awaited<ReturnType<typeof request.file>>;

        try {
          file = await request.file();
        } catch (fileError: unknown) {
          // @fastify/multipart throws FST_REQ_FILE_TOO_LARGE when the limit is hit
          const code =
            fileError !== null &&
            typeof fileError === 'object' &&
            'code' in fileError &&
            fileError.code === 'FST_REQ_FILE_TOO_LARGE'
              ? 413
              : 400;

          if (code === 413) {
            return reply.code(413).send(
              errorResponse(
                'FILE_TOO_LARGE',
                'The uploaded file exceeds the maximum allowed size of 2 GB.',
                String(fileError),
              ),
            );
          }

          return reply.code(400).send(
            errorResponse(
              'FILE_READ_ERROR',
              'Failed to read the uploaded file.',
              String(fileError),
            ),
          );
        }

        if (!file) {
          return reply.code(400).send(
            errorResponse(
              'NO_FILE',
              'No file was included in the request. Please upload a multipart file.',
            ),
          );
        }

        // --- Step 4: Validate filename extension ---
        const { platform } = session.device;

        if (!appInstallService.validateExtension(file.filename, platform)) {
          const allowed = ALLOWED_APP_EXTENSIONS[platform].join(', ');
          return reply.code(400).send(
            errorResponse(
              'INVALID_FILE_EXTENSION',
              `Invalid file extension for platform "${platform}". ` +
                `Allowed extensions: ${allowed}. ` +
                `Received file: "${file.filename}".`,
            ),
          );
        }

        // --- Step 5: Save to temp file ---
        const uploadDir = join(tmpdir(), 'wms-uploads');
        await mkdir(uploadDir, { recursive: true });

        const tempFilename = `${randomUUID()}${extname(file.filename)}`;
        tempFilePath = join(uploadDir, tempFilename);

        // Collect the stream into a buffer before writing
        const chunks: Buffer[] = [];
        for await (const chunk of file.file) {
          chunks.push(chunk as Buffer);
        }
        const buffer = Buffer.concat(chunks);
        await writeFile(tempFilePath, buffer);

        // --- Step 6: Determine the platformDeviceId ---
        let platformDeviceId: string;

        if (platform === 'ios') {
          // For iOS, platformDeviceId is the UDID directly
          platformDeviceId = session.device.platformDeviceId;
        } else {
          // For Android, platformDeviceId is the AVD name.
          // We need to resolve the ADB serial (e.g. "emulator-5554").
          const avdName = session.device.platformDeviceId;
          const adbPort = await androidEmulatorService.getAdbPort(avdName);

          if (adbPort === null) {
            return reply.code(500).send(
              errorResponse(
                'ADB_SERIAL_UNAVAILABLE',
                `Cannot determine ADB serial for Android emulator "${avdName}". ` +
                  `Ensure the emulator is running and reachable via adb.`,
              ),
            );
          }

          platformDeviceId = `emulator-${adbPort}`;
        }

        // --- Step 7: Call the install service ---
        const result = await appInstallService.installApp(
          tempFilePath,
          platform,
          platformDeviceId,
          file.filename,
        );

        // --- Step 9: Return response ---
        if (result.success) {
          return reply
            .code(200)
            .send(successResponse<AppUploadResponse>({ result }));
        }

        return reply.code(422).send(
          errorResponse(
            'INSTALL_FAILED',
            result.message,
            { result },
          ),
        );
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'INTERNAL_ERROR',
            'An unexpected error occurred while processing the app upload.',
            String(error),
          ),
        );
      } finally {
        // --- Step 8: Cleanup temp file (always) ---
        if (tempFilePath !== null) {
          await unlink(tempFilePath).catch(() => {});
        }
      }
    },
  );
};

export default appRoutes;
