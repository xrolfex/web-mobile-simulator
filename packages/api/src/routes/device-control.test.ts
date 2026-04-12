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
    setClipboard: vi.fn(),
    getClipboard: vi.fn(),
    openUrl: vi.fn(),
    sendText: vi.fn(),
  },
  androidEmulatorService: {
    openUrl: vi.fn(),
    sendText: vi.fn(),
  },
}));

// Mock fs/promises to avoid touching the real filesystem
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import deviceControlRoutes from './device-control.js';
import { sessionManagerService, iosSimulatorService, androidEmulatorService } from '../services/index.js';
import { readFile, unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Typed mock references for easier usage in tests
// ---------------------------------------------------------------------------

const mockGetSession = vi.mocked(sessionManagerService.getSession);
const mockPressButton = vi.mocked(iosSimulatorService.pressButton);
const mockSetOrientation = vi.mocked(iosSimulatorService.setOrientation);
const mockShake = vi.mocked(iosSimulatorService.shake);
const mockTakeScreenshot = vi.mocked(iosSimulatorService.takeScreenshot);
const mockSetClipboard = vi.mocked(iosSimulatorService.setClipboard);
const mockGetClipboard = vi.mocked(iosSimulatorService.getClipboard);
const mockIosOpenUrl = vi.mocked(iosSimulatorService.openUrl);
const mockIosSendText = vi.mocked(iosSimulatorService.sendText);
const mockAndroidOpenUrl = vi.mocked(androidEmulatorService.openUrl);
const mockAndroidSendText = vi.mocked(androidEmulatorService.sendText);
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

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/clipboard  (set clipboard — iOS only)
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/clipboard', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/clipboard',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when the session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM when session platform is "android"', async () => {
    // Arrange — text validation happens first, so provide valid text
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 400 with INVALID_TEXT when text field is missing from body', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_TEXT');
  });

  it('returns 400 with INVALID_TEXT when text is null', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: null },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_TEXT');
  });

  it('returns 400 with INVALID_TEXT when text is a number', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: 42 },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_TEXT');
  });

  it('returns 200 and calls setClipboard with correct UDID and text on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockSetClipboard.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: 'Hello clipboard' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(mockSetClipboard).toHaveBeenCalledOnce();
    expect(mockSetClipboard).toHaveBeenCalledWith('UDID-12345', 'Hello clipboard');
  });

  it('returns 200 when text is an empty string (valid edge case)', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockSetClipboard.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: '' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert — empty string is a valid string; clipboard should be cleared
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(mockSetClipboard).toHaveBeenCalledWith('UDID-12345', '');
  });

  it('returns 502 with SIMCTL_ERROR when setClipboard throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockSetClipboard.mockRejectedValue(new Error('pbcopy exited with code 1'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/clipboard',
      payload: { text: 'some text' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('pbcopy exited with code 1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/control/clipboard  (get clipboard — iOS only)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/control/clipboard', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when the session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with UNSUPPORTED_PLATFORM when session platform is "android"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('returns 200 with { text } payload and calls getClipboard with correct UDID', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockGetClipboard.mockResolvedValue('Hello World');

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.text).toBe('Hello World');
    expect(mockGetClipboard).toHaveBeenCalledOnce();
    expect(mockGetClipboard).toHaveBeenCalledWith('UDID-12345');
  });

  it('returns 200 with empty text when clipboard is empty', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockGetClipboard.mockResolvedValue('');

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.data.text).toBe('');
  });

  it('returns 502 with SIMCTL_ERROR when getClipboard throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockGetClipboard.mockRejectedValue(new Error('pbpaste failed'));

    // Act
    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-abc/control/clipboard',
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SIMCTL_ERROR');
    expect(json.error.message).toContain('pbpaste failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/open-url  (both platforms)
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/open-url', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when the session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with INVALID_URL when url field is missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_URL');
  });

  it('returns 400 with INVALID_URL when url is an empty string', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: '' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_URL');
  });

  it('returns 400 with INVALID_URL when url is whitespace only', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: '   ' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('INVALID_URL');
  });

  it('returns 400 with INVALID_URL when url is not a string', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 12345 },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('INVALID_URL');
  });

  it('returns 200 and calls iosSimulatorService.openUrl with correct args for iOS session', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosOpenUrl.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(mockIosOpenUrl).toHaveBeenCalledOnce();
    expect(mockIosOpenUrl).toHaveBeenCalledWith('UDID-12345', 'https://example.com');
    expect(mockAndroidOpenUrl).not.toHaveBeenCalled();
  });

  it('returns 200 and calls androidEmulatorService.openUrl with correct args for Android session', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);
    mockAndroidOpenUrl.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(mockAndroidOpenUrl).toHaveBeenCalledOnce();
    expect(mockAndroidOpenUrl).toHaveBeenCalledWith('test_avd', 'https://example.com');
    expect(mockIosOpenUrl).not.toHaveBeenCalled();
  });

  it('trims leading/trailing whitespace from url before passing to service', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosOpenUrl.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: '  https://example.com  ' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(mockIosOpenUrl).toHaveBeenCalledWith('UDID-12345', 'https://example.com');
  });

  it('returns 502 with COMMAND_ERROR when iosSimulatorService.openUrl throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosOpenUrl.mockRejectedValue(new Error('simctl openurl failed'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('COMMAND_ERROR');
    expect(json.error.message).toContain('simctl openurl failed');
  });

  it('returns 502 with COMMAND_ERROR when androidEmulatorService.openUrl throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);
    mockAndroidOpenUrl.mockRejectedValue(new Error('emulator is not running'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/open-url',
      payload: { url: 'https://example.com' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe('COMMAND_ERROR');
    expect(json.error.message).toContain('emulator is not running');
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/control/send-text  (both platforms)
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/control/send-text', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/control/send-text',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when the session status is not "active"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(inactiveSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 with INVALID_TEXT when text field is missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_TEXT');
  });

  it('returns 400 with INVALID_TEXT when text is not a string', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 999 },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe('INVALID_TEXT');
  });

  it('returns 200 and calls iosSimulatorService.sendText with correct args for iOS session', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosSendText.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 'Hello World' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.success).toBe(true);
    expect(mockIosSendText).toHaveBeenCalledOnce();
    expect(mockIosSendText).toHaveBeenCalledWith('UDID-12345', 'Hello World');
    expect(mockAndroidSendText).not.toHaveBeenCalled();
  });

  it('returns 200 and calls androidEmulatorService.sendText with correct args for Android session', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);
    mockAndroidSendText.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 'Hello Android' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(mockAndroidSendText).toHaveBeenCalledOnce();
    expect(mockAndroidSendText).toHaveBeenCalledWith('test_avd', 'Hello Android');
    expect(mockIosSendText).not.toHaveBeenCalled();
  });

  it('returns 200 when text is an empty string (valid edge case per spec)', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosSendText.mockResolvedValue(undefined);

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: '' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert — empty string is valid; route spec explicitly allows it
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(mockIosSendText).toHaveBeenCalledWith('UDID-12345', '');
  });

  it('returns 502 with COMMAND_ERROR when iosSimulatorService.sendText throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(activeIosSession);
    mockIosSendText.mockRejectedValue(new Error('simctl io type failed'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('COMMAND_ERROR');
    expect(json.error.message).toContain('simctl io type failed');
  });

  it('returns 502 with COMMAND_ERROR when androidEmulatorService.sendText throws', async () => {
    // Arrange
    mockGetSession.mockReturnValue(androidSession);
    mockAndroidSendText.mockRejectedValue(new Error('adb input text failed'));

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-abc/control/send-text',
      payload: { text: 'hello' },
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe('COMMAND_ERROR');
    expect(json.error.message).toContain('adb input text failed');
  });
});
