import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Session } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Mock services BEFORE importing the route module.
// Vitest hoists vi.mock() calls, so these always run before imports.
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  sessionManagerService: {
    getSession: vi.fn(),
  },
  iosSimulatorService: {
    pressButton: vi.fn(),
    setOrientation: vi.fn(),
    shake: vi.fn(),
    takeScreenshot: vi.fn(),
  },
}));

// Mock fs/promises to avoid touching the real filesystem
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import deviceControlRoutes from './device-control.js';
import { sessionManagerService, iosSimulatorService } from '../services/index.js';
import { readFile, unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Typed mock references for easier usage in tests
// ---------------------------------------------------------------------------

const mockGetSession = vi.mocked(sessionManagerService.getSession);
const mockPressButton = vi.mocked(iosSimulatorService.pressButton);
const mockSetOrientation = vi.mocked(iosSimulatorService.setOrientation);
const mockShake = vi.mocked(iosSimulatorService.shake);
const mockTakeScreenshot = vi.mocked(iosSimulatorService.takeScreenshot);
const mockReadFile = vi.mocked(readFile);
const mockUnlink = vi.mocked(unlink);

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

/** An active iOS session in the standard happy-path shape. */
const activeIosSession: Session = {
  id: 'session-abc',
  status: 'active',
  device: {
    id: 'device-1',
    platform: 'ios',
    platformDeviceId: 'UDID-12345',
    deviceType: {
      id: 'dt-id',
      name: 'iPhone 15',
      platform: 'ios',
      modelName: 'iPhone 15',
      modelIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
    },
    runtime: {
      id: 'rt-id',
      platform: 'ios',
      version: 'iOS 17.5',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      status: 'installed',
    },
    state: 'booted',
  },
  createdAt: '2026-04-12T00:00:00.000Z',
  updatedAt: '2026-04-12T00:00:00.000Z',
};

/** Same session but not yet active — status is 'creating'. */
const inactiveSession: Session = {
  ...activeIosSession,
  status: 'creating',
};

/** Same session but on the Android platform. */
const androidSession: Session = {
  ...activeIosSession,
  status: 'active',
  device: {
    ...activeIosSession.device,
    platform: 'android',
    platformDeviceId: 'test_avd',
  },
};

// ---------------------------------------------------------------------------
// Fastify test instance lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();

  // Restore default mock implementations after clearAllMocks
  mockReadFile.mockResolvedValue(Buffer.from('fake-png-data'));
  mockUnlink.mockResolvedValue(undefined);

  app = Fastify();
  await app.register(deviceControlRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/button
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/button', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('includes the current status in the SESSION_NOT_ACTIVE error message', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    const json = response.json();
    expect(json.error.message).toContain('creating');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM when session platform is "android"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 400 with INVALID_BUTTON when button value is invalid', async () => {
    // Arrange — body is validated BEFORE session lookup in this endpoint
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'sideButton' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_BUTTON');
  });

  it('returns 400 with INVALID_BUTTON when button field is missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_BUTTON');
  });

  it('returns 200 and calls pressButton with the correct UDID and button on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockPressButton.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(mockPressButton).toHaveBeenCalledOnce();
    expect(mockPressButton).toHaveBeenCalledWith('UDID-12345', 'home');
  });

  it('calls pressButton with the correct button for each valid button type', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockPressButton.mockResolvedValue(undefined);

    const validButtons = ['home', 'lock', 'volumeUp', 'volumeDown'] as const;

    for (const button of validButtons) {
      vi.clearAllMocks();
      mockGetSession.mockReturnValue(activeIosSession);
      mockPressButton.mockResolvedValue(undefined);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-abc/control/button',
        payload: { button },
        headers: { 'content-type': 'application/json' },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(mockPressButton).toHaveBeenCalledWith('UDID-12345', button);
    }
  });

  it('returns 502 with SIMCTL_ERROR when pressButton throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockPressButton.mockRejectedValue(new Error('simctl failed'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'lock' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('simctl failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/rotate
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/rotate', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/rotate',
      payload: { orientation: 'portrait' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: { orientation: 'portrait' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM for Android sessions', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: { orientation: 'portrait' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 400 with INVALID_ORIENTATION when orientation value is invalid', async () => {
    // Arrange — body validated before session lookup in this endpoint
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: { orientation: 'upsideDown' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_ORIENTATION');
  });

  it('returns 400 with INVALID_ORIENTATION when orientation field is missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('INVALID_ORIENTATION');
  });

  it('returns 200 and calls setOrientation with correct UDID and orientation on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockSetOrientation.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: { orientation: 'landscapeLeft' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(mockSetOrientation).toHaveBeenCalledOnce();
    expect(mockSetOrientation).toHaveBeenCalledWith('UDID-12345', 'landscapeLeft');
  });

  it('calls setOrientation with correct value for all valid orientations', async () => {
    // Arrange
    const validOrientations = [
      'portrait',
      'landscapeLeft',
      'landscapeRight',
      'portraitUpsideDown',
    ] as const;

    for (const orientation of validOrientations) {
      vi.clearAllMocks();
      mockGetSession.mockReturnValue(activeIosSession);
      mockSetOrientation.mockResolvedValue(undefined);

      // Act
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-abc/control/rotate',
        payload: { orientation },
        headers: { 'content-type': 'application/json' },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(mockSetOrientation).toHaveBeenCalledWith('UDID-12345', orientation);
    }
  });

  it('returns 502 with SIMCTL_ERROR when setOrientation throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockSetOrientation.mockRejectedValue(new Error('orientation not supported'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/rotate',
      payload: { orientation: 'portrait' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('orientation not supported');
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/shake
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/shake', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/shake',
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/shake',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM for Android sessions', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/shake',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 200 and calls shake with the correct UDID on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockShake.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/shake',
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(mockShake).toHaveBeenCalledOnce();
    expect(mockShake).toHaveBeenCalledWith('UDID-12345');
  });

  it('returns 502 with SIMCTL_ERROR when shake throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockShake.mockRejectedValue(
      new Error('Shake gesture is not supported in this Xcode version.'),
    );

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/shake',
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('Shake gesture is not supported');
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/control/screenshot
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/control/screenshot', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/control/screenshot',
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM for Android sessions', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 200 with image/png content-type and PNG body on success', async () => {
    // Arrange
    const fakePngBuffer = Buffer.from('fake-png-data');
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(fakePngBuffer);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.rawPayload).toEqual(fakePngBuffer);
  });

  it('calls takeScreenshot with the correct UDID on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('fake-png-data'));

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert
    expect(mockTakeScreenshot).toHaveBeenCalledOnce();
    // First arg is UDID; second is the temp file path
    expect(mockTakeScreenshot).toHaveBeenCalledWith(
      'UDID-12345',
      expect.stringContaining('screenshot-session-abc-'),
    );
  });

  it('calls readFile with the same temp path that was passed to takeScreenshot', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('fake-png-data'));

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert — readFile must receive the same path as takeScreenshot
    const screenshotPath = mockTakeScreenshot.mock.calls[0]![1] as string;
    expect(mockReadFile).toHaveBeenCalledWith(screenshotPath);
  });

  it('returns 502 with SIMCTL_ERROR when takeScreenshot throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockRejectedValue(new Error('simctl io failed'));

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('simctl io failed');
  });

  it('calls unlink in the finally block after a successful screenshot', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('fake-png-data'));

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert — cleanup must always run
    expect(mockUnlink).toHaveBeenCalledOnce();
    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringContaining('screenshot-session-abc-'),
    );
  });

  it('calls unlink in the finally block even when takeScreenshot throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockTakeScreenshot.mockRejectedValue(new Error('simctl io failed'));

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/screenshot',
    });

    // Assert — cleanup must run even on error paths
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('does NOT call unlink when session validation fails (no temp file created)', async () => {
    // Arrange — session not found; route returns early before creating a temp file
    mockGetSession.mockReturnValue(null);

    // Act
    await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/control/screenshot',
    });

    // Assert — no temp file was ever created
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response envelope shape
// ---------------------------------------------------------------------------

describe('device-control response envelope', () => {
  it('wraps success in { success: true, data: { success: true } } for button press', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockPressButton.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/button',
      payload: { button: 'home' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    const json = response.json();
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
    expect(json.data).toHaveProperty('success', true);
  });

  it('wraps errors in { success: false, error: { code, message } } shape', async () => {
    // Arrange — session not found
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/some-id/control/shake',
    });

    // Assert
    const json = response.json();
    expect(json).toHaveProperty('success', false);
    expect(json).toHaveProperty('error');
    expect(json.error).toHaveProperty('code');
    expect(json.error).toHaveProperty('message');
  });
});
