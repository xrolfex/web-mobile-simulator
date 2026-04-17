import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiResponse,
  Platform,
  Runtime,
  RuntimeDownloadRequest,
  RuntimeDownloadProgress,
  RuntimeListResponse,
} from '@web-mobile-simulator/shared';
import { iosSimulatorService, androidEmulatorService } from '../services/index.js';

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

/** Fastify request shape for routes that carry a `:platform` path param. */
type PlatformParamRequest = FastifyRequest<{ Params: { platform: string } }>;

/** Fastify request shape for the POST /api/runtimes/download body. */
type DownloadRequest = FastifyRequest<{ Body: RuntimeDownloadRequest }>;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Runtime management route plugin.
 *
 * Registers endpoints for OS runtime discovery and download:
 * - GET  /api/runtimes            — List all runtimes (iOS + Android)
 * - GET  /api/runtimes/:platform  — List runtimes for a specific platform
 * - POST /api/runtimes/download   — Initiate a runtime/system-image download
 *
 * NOTE: iOS runtime downloads are fire-and-forget (spawned background process).
 * Progress reporting via WebSocket events will be added in a subsequent iteration.
 */
const runtimeRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/runtimes
   *
   * Queries iOS Simulator (simctl) and Android Emulator (sdkmanager) services
   * in parallel, then merges results into a single {@link RuntimeListResponse}.
   * If one service fails, the other's results are still returned with a warning.
   */
  fastify.get(
    '/api/runtimes',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [iosResult, androidResult] = await Promise.allSettled([
        iosSimulatorService.listRuntimes(),
        androidEmulatorService.listSystemImages(),
      ]);

      const runtimes: Runtime[] = [];
      const warnings: string[] = [];

      if (iosResult.status === 'fulfilled') {
        runtimes.push(...iosResult.value);
      } else {
        warnings.push(`iOS runtimes unavailable: ${String(iosResult.reason)}`);
      }

      if (androidResult.status === 'fulfilled') {
        runtimes.push(...androidResult.value);
      } else {
        warnings.push(
          `Android system images unavailable: ${String(androidResult.reason)}`,
        );
      }

      // If both services failed, return 502.
      if (runtimes.length === 0 && warnings.length === 2) {
        const body = errorResponse(
          'SERVICE_UNAVAILABLE',
          'Both iOS and Android services failed to return runtime information.',
          warnings,
        );
        return reply.code(502).send(body);
      }

      const responseData: RuntimeListResponse & { warnings?: string[] } = {
        runtimes,
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      return reply.code(200).send(successResponse(responseData));
    },
  );

  /**
   * GET /api/runtimes/:platform
   *
   * Returns runtimes for a single platform (`'ios'` or `'android'`).
   * Responds with 400 if the platform parameter is not recognised.
   */
  fastify.get(
    '/api/runtimes/:platform',
    async (request: PlatformParamRequest, reply: FastifyReply) => {
      const { platform } = request.params;

      if (!validatePlatform(platform)) {
        const body = errorResponse(
          'INVALID_PLATFORM',
          `Invalid platform "${platform}". Must be "ios" or "android".`,
        );
        return reply.code(400).send(body);
      }

      try {
        const runtimes =
          platform === 'ios'
            ? await iosSimulatorService.listRuntimes()
            : await androidEmulatorService.listSystemImages();

        const body = successResponse<RuntimeListResponse>({ runtimes });
        return reply.code(200).send(body);
      } catch (error: unknown) {
        const body = errorResponse(
          'SERVICE_ERROR',
          `Failed to list ${platform} runtimes.`,
          String(error),
        );
        return reply.code(502).send(body);
      }
    },
  );

  /**
   * POST /api/runtimes/download
   *
   * Initiates a download/installation of the specified runtime or system image.
   *
   * - iOS:     calls `iosSimulatorService.downloadRuntime(identifier)`
   *            which uses `xcrun simctl runtime add` (Xcode 14+).
   * - Android: calls `androidEmulatorService.installSystemImage(identifier)`
   *            which uses `sdkmanager --install`.
   *
   * Returns 202 Accepted with an initial {@link RuntimeDownloadProgress} once
   * the operation completes.  Progress streaming via WebSocket will be wired
   * up in a future iteration.
   *
   * Responds with 400 for missing/invalid body fields, 502 on service failure.
   */
  fastify.post(
    '/api/runtimes/download',
    async (request: DownloadRequest, reply: FastifyReply) => {
      const body = request.body as Partial<RuntimeDownloadRequest> | undefined;

      // --- Validate request body ---
      if (!body || typeof body !== 'object') {
        return reply.code(400).send(
          errorResponse('INVALID_REQUEST', 'Request body is required.'),
        );
      }

      const { platform, identifier } = body;

      if (!platform || !validatePlatform(platform)) {
        return reply.code(400).send(
          errorResponse(
            'INVALID_PLATFORM',
            `Invalid or missing "platform". Must be "ios" or "android".`,
          ),
        );
      }

      if (!identifier || typeof identifier !== 'string' || identifier.trim() === '') {
        return reply.code(400).send(
          errorResponse(
            'INVALID_IDENTIFIER',
            '"identifier" is required and must be a non-empty string.',
          ),
        );
      }

      const cleanIdentifier = identifier.trim();

      // --- Dispatch to the appropriate service ---
      try {
        if (platform === 'ios') {
          // downloadRuntime() is non-blocking (fire-and-forget spawn).
          // We still await the Promise so any synchronous setup errors
          // (e.g. simctl not found) are caught and returned as 502.
          await iosSimulatorService.downloadRuntime(cleanIdentifier);
        } else {
          await androidEmulatorService.installSystemImage(cleanIdentifier);
        }
      } catch (error: unknown) {
        return reply.code(502).send(
          errorResponse(
            'DOWNLOAD_FAILED',
            `Failed to initiate ${platform} runtime download for "${cleanIdentifier}".`,
            String(error),
          ),
        );
      }

      // --- Return 202 Accepted with initial progress snapshot ---
      const progress: RuntimeDownloadProgress = {
        platform,
        identifier: cleanIdentifier,
        progress: 100,
        status: 'completed',
        message: `${platform === 'ios' ? 'iOS runtime' : 'Android system image'} download initiated successfully.`,
      };

      return reply.code(202).send(successResponse(progress));
    },
  );
};

export default runtimeRoutes;
