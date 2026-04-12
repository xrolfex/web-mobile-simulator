import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiResponse,
  DeviceType,
  DeviceTypeListResponse,
  Platform,
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Device types route plugin.
 *
 * Registers endpoints for device type discovery:
 * - GET /api/devices            — List all available device types (iOS + Android)
 * - GET /api/devices/:platform  — List device types for a specific platform
 */
const deviceRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/devices
   *
   * Queries iOS Simulator and Android Emulator services in parallel, then
   * merges results into a single {@link DeviceTypeListResponse}.  If one
   * service fails the other's results are still returned, accompanied by a
   * warning in the response payload.
   */
  fastify.get(
    '/api/devices',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [iosResult, androidResult] = await Promise.allSettled([
        iosSimulatorService.listDeviceTypes(),
        androidEmulatorService.listDeviceTypes(),
      ]);

      const deviceTypes: DeviceType[] = [];
      const warnings: string[] = [];

      if (iosResult.status === 'fulfilled') {
        deviceTypes.push(...iosResult.value);
      } else {
        warnings.push(
          `iOS device types unavailable: ${String(iosResult.reason)}`,
        );
      }

      if (androidResult.status === 'fulfilled') {
        deviceTypes.push(...androidResult.value);
      } else {
        warnings.push(
          `Android device types unavailable: ${String(androidResult.reason)}`,
        );
      }

      // If both services failed, return a 502 with a combined error message.
      if (deviceTypes.length === 0 && warnings.length === 2) {
        const body = errorResponse(
          'SERVICE_UNAVAILABLE',
          'Both iOS and Android services failed to return device types.',
          warnings,
        );
        return reply.code(502).send(body);
      }

      const responseData: DeviceTypeListResponse & { warnings?: string[] } = {
        deviceTypes,
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      return reply.code(200).send(successResponse(responseData));
    },
  );

  /**
   * GET /api/devices/:platform
   *
   * Returns device types for a single platform (`'ios'` or `'android'`).
   * Responds with 400 if the platform parameter is not recognised.
   */
  fastify.get(
    '/api/devices/:platform',
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
        const deviceTypes =
          platform === 'ios'
            ? await iosSimulatorService.listDeviceTypes()
            : await androidEmulatorService.listDeviceTypes();

        const body = successResponse<DeviceTypeListResponse>({ deviceTypes });
        return reply.code(200).send(body);
      } catch (error: unknown) {
        const body = errorResponse(
          'SERVICE_ERROR',
          `Failed to list ${platform} device types.`,
          String(error),
        );
        return reply.code(502).send(body);
      }
    },
  );
};

export default deviceRoutes;
