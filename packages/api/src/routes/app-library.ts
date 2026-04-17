import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse } from '@web-mobile-simulator/shared';
import { ALLOWED_APP_EXTENSIONS } from '@web-mobile-simulator/shared';
import type { Platform } from '@web-mobile-simulator/shared';
import { appLibraryService } from '../services/app-library-service.js';
import type { AppLibraryEntry } from '../db/app-library-repository.js';

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

/**
 * Extract the user ID from the `x-user-id` request header.
 * Falls back to `"default"` when the header is absent.
 *
 * @param request - The incoming Fastify request.
 * @returns The resolved user identifier string.
 */
function getUserId(request: FastifyRequest): string {
  const header = request.headers['x-user-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  return 'default';
}

// ---------------------------------------------------------------------------
// Route param / query types
// ---------------------------------------------------------------------------

/** Request with an `:id` path parameter (app library entry ID). */
type AppIdParamRequest = FastifyRequest<{ Params: { id: string } }>;

/** Request with `:id` and `:sessionId` path parameters. */
type InstallParamRequest = FastifyRequest<{
  Params: { id: string; sessionId: string };
}>;

/** Query string for `GET /api/apps`. */
type ListAppsQuery = FastifyRequest<{
  Querystring: { platform?: string };
}>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * App library route plugin.
 *
 * Registers RESTful endpoints for managing a persistent per-user app library:
 * - GET    /api/apps                        — list user's apps
 * - POST   /api/apps                        — upload a new app to the library
 * - GET    /api/apps/:id                    — get a single app entry
 * - DELETE /api/apps/:id                    — delete an app from the library
 * - POST   /api/apps/:id/install/:sessionId — install a library app into a session
 */
const appLibraryRoutes: FastifyPluginAsync = async (fastify) => {
  // -------------------------------------------------------------------------
  // GET /api/apps
  // -------------------------------------------------------------------------

  /**
   * List all apps in the requesting user's library.
   *
   * Query params:
   * - `platform` (optional) — filter to `'ios'` or `'android'` only.
   *
   * User is identified via the `x-user-id` header (defaults to `"default"`).
   *
   * Responds with:
   * - 200 OK — array of app library entries (may be empty)
   * - 400 Bad Request — invalid `platform` query value
   */
  fastify.get(
    '/api/apps',
    async (request: ListAppsQuery, reply: FastifyReply) => {
      try {
        const userId = getUserId(request);
        const { platform: platformParam } = request.query;

        let platform: Platform | undefined;

        if (platformParam !== undefined) {
          if (platformParam !== 'ios' && platformParam !== 'android') {
            return reply.code(400).send(
              errorResponse(
                'INVALID_PLATFORM',
                `Invalid platform "${platformParam}". Must be "ios" or "android".`,
              ),
            );
          }
          platform = platformParam as Platform;
        }

        const apps = appLibraryService.listApps(userId, platform);
        return reply.code(200).send(successResponse<AppLibraryEntry[]>(apps));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'INTERNAL_ERROR',
            'An unexpected error occurred while listing apps.',
            String(error),
          ),
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/apps
  // -------------------------------------------------------------------------

  /**
   * Upload a new app binary to the user's library.
   *
   * Expects a multipart form with:
   * - `file`     — the app binary (`.ipa` or `.apk`)
   * - `platform` — `'ios'` or `'android'`
   *
   * Responds with:
   * - 201 Created             — app saved to library
   * - 400 Bad Request         — missing/invalid fields or wrong file extension
   * - 413 Payload Too Large   — file exceeds the 2 GB limit
   * - 500 Internal Server Error — unexpected failure
   */
  fastify.post('/api/apps', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(request);

      // --- Parse multipart fields ---
      // Cast to `any` to access @fastify/multipart's `.parts()` augmentation,
      // which is not reflected in the base FastifyRequest type definitions.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = (request as any).parts() as AsyncIterable<any>;

      let platform: Platform | undefined;
      let fileBuffer: Buffer | undefined;
      let fileName: string | undefined;

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'platform') {
          const value = part.value as string;
          if (value !== 'ios' && value !== 'android') {
            return reply.code(400).send(
              errorResponse(
                'INVALID_PLATFORM',
                `Invalid platform "${value}". Must be "ios" or "android".`,
              ),
            );
          }
          platform = value as Platform;
        } else if (part.type === 'file' && part.fieldname === 'file') {
          fileName = part.filename;

          const chunks: Buffer[] = [];
          try {
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
          } catch (fileError: unknown) {
            const isTooLarge =
              fileError !== null &&
              typeof fileError === 'object' &&
              'code' in fileError &&
              (fileError as { code: string }).code === 'FST_REQ_FILE_TOO_LARGE';

            if (isTooLarge) {
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

          fileBuffer = Buffer.concat(chunks);
        }
      }

      // --- Validate required fields ---
      if (!platform) {
        return reply.code(400).send(
          errorResponse(
            'MISSING_PLATFORM',
            'The "platform" field is required. Must be "ios" or "android".',
          ),
        );
      }

      if (!fileBuffer || !fileName) {
        return reply.code(400).send(
          errorResponse(
            'NO_FILE',
            'No file was included in the request. Please upload a multipart file in the "file" field.',
          ),
        );
      }

      // --- Validate file extension ---
      const fileExt = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_APP_EXTENSIONS[platform].includes(fileExt)) {
        return reply.code(400).send(
          errorResponse(
            'INVALID_FILE_EXTENSION',
            `Invalid file extension for platform "${platform}". ` +
              `Allowed extensions: ${ALLOWED_APP_EXTENSIONS[platform].join(', ')}. ` +
              `Received file: "${fileName}".`,
          ),
        );
      }

      const entry = await appLibraryService.uploadApp(userId, platform, {
        filename: fileName,
        buffer: fileBuffer,
      });

      return reply.code(201).send(successResponse<AppLibraryEntry>(entry));
    } catch (error: unknown) {
      return reply.code(500).send(
        errorResponse(
          'INTERNAL_ERROR',
          'An unexpected error occurred while uploading the app.',
          String(error),
        ),
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/apps/:id
  // -------------------------------------------------------------------------

  /**
   * Get a single app library entry by its ID.
   *
   * Responds with:
   * - 200 OK        — app entry found
   * - 404 Not Found — no entry with this ID
   */
  fastify.get(
    '/api/apps/:id',
    async (request: AppIdParamRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const entry = appLibraryService.getApp(id);

        if (!entry) {
          return reply.code(404).send(
            errorResponse('APP_NOT_FOUND', `App library entry "${id}" not found.`),
          );
        }

        return reply.code(200).send(successResponse<AppLibraryEntry>(entry));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'INTERNAL_ERROR',
            'An unexpected error occurred while retrieving the app.',
            String(error),
          ),
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/apps/:id
  // -------------------------------------------------------------------------

  /**
   * Delete an app from the library (removes file from disk and DB row).
   *
   * Responds with:
   * - 200 OK        — app deleted
   * - 404 Not Found — no entry with this ID
   */
  fastify.delete(
    '/api/apps/:id',
    async (request: AppIdParamRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const deleted = await appLibraryService.deleteApp(id);

        if (!deleted) {
          return reply.code(404).send(
            errorResponse('APP_NOT_FOUND', `App library entry "${id}" not found.`),
          );
        }

        return reply.code(200).send(successResponse({ id, deleted: true }));
      } catch (error: unknown) {
        return reply.code(500).send(
          errorResponse(
            'INTERNAL_ERROR',
            'An unexpected error occurred while deleting the app.',
            String(error),
          ),
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/apps/:id/install/:sessionId
  // -------------------------------------------------------------------------

  /**
   * Install a library app into an active simulator session.
   *
   * Responds with:
   * - 200 OK                   — app installed successfully
   * - 400 Bad Request          — session not active or platform mismatch
   * - 404 Not Found            — app or session not found
   * - 422 Unprocessable Entity — install command failed
   * - 500 Internal Server Error — unexpected failure
   */
  fastify.post(
    '/api/apps/:id/install/:sessionId',
    async (request: InstallParamRequest, reply: FastifyReply) => {
      try {
        const { id, sessionId } = request.params;

        const result = await appLibraryService.installApp(id, sessionId);

        if (result.success) {
          return reply.code(200).send(successResponse({ message: result.message }));
        }

        return reply.code(422).send(
          errorResponse('INSTALL_FAILED', result.message),
        );
      } catch (error: unknown) {
        const message = String(error);

        // Map well-known thrown messages to appropriate HTTP status codes.
        if (
          message.includes('not found') ||
          message.includes('not found.')
        ) {
          return reply.code(404).send(
            errorResponse('NOT_FOUND', message),
          );
        }

        if (
          message.includes('not active') ||
          message.includes('does not match session platform')
        ) {
          return reply.code(400).send(
            errorResponse('BAD_REQUEST', message),
          );
        }

        return reply.code(500).send(
          errorResponse(
            'INTERNAL_ERROR',
            'An unexpected error occurred while installing the app.',
            message,
          ),
        );
      }
    },
  );
};

export default appLibraryRoutes;
