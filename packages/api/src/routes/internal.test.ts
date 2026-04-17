import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock service and config BEFORE importing the route module.
// Vitest hoists vi.mock() calls, so these always run before imports.
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  workerRegistryService: {
    registerWorker: vi.fn(),
    updateHeartbeat: vi.fn(),
    removeWorker: vi.fn(),
    getAllWorkers: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    workerSecret: 'test-secret',
  },
}));

import internalRoutes from './internal.js';
import { workerRegistryService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Typed mock references for easier usage in tests
// ---------------------------------------------------------------------------

const mockRegisterWorker = vi.mocked(workerRegistryService.registerWorker);
const mockUpdateHeartbeat = vi.mocked(workerRegistryService.updateHeartbeat);
const mockRemoveWorker = vi.mocked(workerRegistryService.removeWorker);
const mockGetAllWorkers = vi.mocked(workerRegistryService.getAllWorkers);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_AUTH = { authorization: 'Bearer test-secret' };
const WRONG_AUTH = { authorization: 'Bearer wrong-secret' };
const NO_AUTH = {};

// ---------------------------------------------------------------------------
// Fastify test instance lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  await app.register(internalRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /internal/workers/register', () => {
  const VALID_BODY = {
    url: 'http://worker.example.com',
    maxIosSessions: 3,
    maxAndroidSessions: 2,
  };

  const MOCK_REGISTRATION_RESPONSE = {
    workerId: 'worker-abc-123',
    heartbeatIntervalMs: 30000,
  };

  describe('auth', () => {
    it('returns 401 with UNAUTHORIZED when Authorization header is absent', async () => {
      // Arrange — no auth header

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: NO_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with UNAUTHORIZED when secret is wrong', async () => {
      // Arrange — wrong bearer token

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: WRONG_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('validation', () => {
    it('returns 400 with INVALID_REQUEST when url is missing', async () => {
      // Arrange
      const body = { maxIosSessions: 3, maxAndroidSessions: 2 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 with INVALID_REQUEST when url is an empty string', async () => {
      // Arrange
      const body = { url: '   ', maxIosSessions: 3, maxAndroidSessions: 2 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 with INVALID_REQUEST when maxIosSessions is missing (not a number)', async () => {
      // Arrange
      const body = { url: 'http://worker.example.com', maxAndroidSessions: 2 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 with INVALID_REQUEST when maxAndroidSessions is missing (not a number)', async () => {
      // Arrange
      const body = { url: 'http://worker.example.com', maxIosSessions: 3 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('success', () => {
    it('returns 201 with success envelope containing workerId and heartbeatIntervalMs', async () => {
      // Arrange
      mockRegisterWorker.mockReturnValue(MOCK_REGISTRATION_RESPONSE);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.workerId).toBe('worker-abc-123');
      expect(json.data.heartbeatIntervalMs).toBe(30000);
    });

    it('response body has success: true', async () => {
      // Arrange
      mockRegisterWorker.mockReturnValue(MOCK_REGISTRATION_RESPONSE);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      const json = response.json();
      expect(json.success).toBe(true);
    });

    it('calls registerWorker exactly once with the correct url, maxIosSessions, maxAndroidSessions', async () => {
      // Arrange
      mockRegisterWorker.mockReturnValue(MOCK_REGISTRATION_RESPONSE);

      // Act
      await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(mockRegisterWorker).toHaveBeenCalledOnce();
      expect(mockRegisterWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://worker.example.com',
          maxIosSessions: 3,
          maxAndroidSessions: 2,
        }),
      );
    });

    it('trims whitespace from url before passing to registerWorker', async () => {
      // Arrange
      mockRegisterWorker.mockReturnValue(MOCK_REGISTRATION_RESPONSE);
      const bodyWithPaddedUrl = { ...VALID_BODY, url: '  http://worker.example.com  ' };

      // Act
      await app.inject({
        method: 'POST',
        url: '/internal/workers/register',
        headers: VALID_AUTH,
        payload: bodyWithPaddedUrl,
      });

      // Assert — url must be trimmed
      expect(mockRegisterWorker).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://worker.example.com' }),
      );
    });
  });
});

// ---------------------------------------------------------------------------

describe('POST /internal/workers/:workerId/heartbeat', () => {
  const VALID_BODY = { currentIosSessions: 1, currentAndroidSessions: 0 };
  const WORKER_ID = 'worker-abc-123';

  describe('auth', () => {
    it('returns 401 when Authorization header is absent', async () => {
      // Arrange — no auth header

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: NO_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when secret is wrong', async () => {
      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: WRONG_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when currentIosSessions is missing', async () => {
      // Arrange
      const body = { currentAndroidSessions: 0 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 when currentAndroidSessions is missing', async () => {
      // Arrange
      const body = { currentIosSessions: 1 };

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: body,
      });

      // Assert
      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('not found', () => {
    it('returns 404 with WORKER_NOT_FOUND when updateHeartbeat returns false', async () => {
      // Arrange
      mockUpdateHeartbeat.mockReturnValue(false);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(404);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('WORKER_NOT_FOUND');
    });

    it('includes the workerId in the 404 error message', async () => {
      // Arrange
      mockUpdateHeartbeat.mockReturnValue(false);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      const json = response.json();
      expect(json.error.message).toContain(WORKER_ID);
    });
  });

  describe('success', () => {
    it('returns 204 with no body when updateHeartbeat returns true', async () => {
      // Arrange
      mockUpdateHeartbeat.mockReturnValue(true);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });

    it('calls updateHeartbeat with the correct workerId and session counts', async () => {
      // Arrange
      mockUpdateHeartbeat.mockReturnValue(true);

      // Act
      await app.inject({
        method: 'POST',
        url: `/internal/workers/${WORKER_ID}/heartbeat`,
        headers: VALID_AUTH,
        payload: VALID_BODY,
      });

      // Assert
      expect(mockUpdateHeartbeat).toHaveBeenCalledOnce();
      expect(mockUpdateHeartbeat).toHaveBeenCalledWith(
        WORKER_ID,
        expect.objectContaining({
          currentIosSessions: 1,
          currentAndroidSessions: 0,
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------

describe('DELETE /internal/workers/:workerId', () => {
  const WORKER_ID = 'worker-to-delete';

  describe('auth', () => {
    it('returns 401 when Authorization header is absent', async () => {
      // Act
      const response = await app.inject({
        method: 'DELETE',
        url: `/internal/workers/${WORKER_ID}`,
        headers: NO_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when secret is wrong', async () => {
      // Act
      const response = await app.inject({
        method: 'DELETE',
        url: `/internal/workers/${WORKER_ID}`,
        headers: WRONG_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe('success', () => {
    it('returns 204 when authorized (idempotent — regardless of whether worker exists)', async () => {
      // Act
      const response = await app.inject({
        method: 'DELETE',
        url: `/internal/workers/${WORKER_ID}`,
        headers: VALID_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });

    it('calls removeWorker with the correct workerId', async () => {
      // Act
      await app.inject({
        method: 'DELETE',
        url: `/internal/workers/${WORKER_ID}`,
        headers: VALID_AUTH,
      });

      // Assert
      expect(mockRemoveWorker).toHaveBeenCalledOnce();
      expect(mockRemoveWorker).toHaveBeenCalledWith(WORKER_ID);
    });
  });
});

// ---------------------------------------------------------------------------

describe('GET /internal/workers', () => {
  describe('auth', () => {
    it('returns 401 when Authorization header is absent', async () => {
      // Act
      const response = await app.inject({
        method: 'GET',
        url: '/internal/workers',
        headers: NO_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const json = response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when secret is wrong', async () => {
      // Act
      const response = await app.inject({
        method: 'GET',
        url: '/internal/workers',
        headers: WRONG_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe('success', () => {
    it('returns 200 with success envelope containing a workers array', async () => {
      // Arrange
      const mockWorkers = [
        { workerId: 'w1', url: 'http://worker1.example.com', maxIosSessions: 2, maxAndroidSessions: 2 },
        { workerId: 'w2', url: 'http://worker2.example.com', maxIosSessions: 4, maxAndroidSessions: 0 },
      ];
      mockGetAllWorkers.mockReturnValue(mockWorkers as ReturnType<typeof workerRegistryService.getAllWorkers>);

      // Act
      const response = await app.inject({
        method: 'GET',
        url: '/internal/workers',
        headers: VALID_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('workers');
    });

    it('workers array matches what getAllWorkers returns', async () => {
      // Arrange
      const mockWorkers = [
        { workerId: 'w1', url: 'http://worker1.example.com', maxIosSessions: 2, maxAndroidSessions: 2 },
        { workerId: 'w2', url: 'http://worker2.example.com', maxIosSessions: 4, maxAndroidSessions: 0 },
      ];
      mockGetAllWorkers.mockReturnValue(mockWorkers as ReturnType<typeof workerRegistryService.getAllWorkers>);

      // Act
      const response = await app.inject({
        method: 'GET',
        url: '/internal/workers',
        headers: VALID_AUTH,
      });

      // Assert
      const json = response.json();
      expect(json.data.workers).toEqual(mockWorkers);
    });

    it('returns an empty workers array when no workers are registered', async () => {
      // Arrange
      mockGetAllWorkers.mockReturnValue([]);

      // Act
      const response = await app.inject({
        method: 'GET',
        url: '/internal/workers',
        headers: VALID_AUTH,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.success).toBe(true);
      expect(json.data.workers).toEqual([]);
    });
  });
});
