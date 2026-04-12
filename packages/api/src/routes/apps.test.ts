import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Session, AppInstallResult } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Mock services BEFORE importing the route module.
// Vitest hoists vi.mock() calls, so these always run before imports.
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  sessionManagerService: {
    getSession: vi.fn(),
  },
  appInstallService: {
    validateExtension: vi.fn(),
    installApp: vi.fn(),
  },
  androidEmulatorService: {
    getAdbPort: vi.fn(),
  },
}));

// Mock fs/promises to avoid touching the real filesystem
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import appRoutes from './apps.js';
import {
  sessionManagerService,
  appInstallService,
  androidEmulatorService,
} from '../services/index.js';
import { unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Typed mock references for easier usage in tests
// ---------------------------------------------------------------------------

const mockGetSession = vi.mocked(sessionManagerService.getSession);
const mockValidateExtension = vi.mocked(appInstallService.validateExtension);
const mockInstallApp = vi.mocked(appInstallService.installApp);
const mockGetAdbPort = vi.mocked(androidEmulatorService.getAdbPort);
const mockUnlink = vi.mocked(unlink);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a raw multipart/form-data body buffer with a single file field.
 * Fastify's .inject() doesn't natively support multipart, so we encode it
 * manually following RFC 2046.
 */
function buildMultipartPayload(
  filename: string,
  content: Buffer = Buffer.from('fake-app-data'),
): { body: Buffer; contentType: string } {
  const boundary = 'FormBoundary' + Date.now();

  // Each line in the MIME header must end with CRLF; the blank line before
  // body content is also CRLF.
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: application/octet-stream`,
    '',
    '',
  ].join('\r\n');

  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header),
    content,
    Buffer.from(footer),
  ]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Create a realistic mock session, with optional overrides applied last.
 * The default is an active iOS session.
 */
function createMockSession(overrides: Record<string, unknown> = {}): Session {
  return {
    id: 'test-session-id',
    status: 'active',
    device: {
      id: 'device-id',
      platform: 'ios',
      platformDeviceId: 'ABC-UDID-123',
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
    streamUrl: 'ws://localhost:6900',
    proxyPort: 6900,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Session;
}

// ---------------------------------------------------------------------------
// Fastify test instance lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();

  app = Fastify();

  // Register multipart plugin with the same limits used in production
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  });

  await app.register(appRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — session validation', () => {
  it('returns 404 when the session is not found', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(404);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 400 when the session status is "creating"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession({ status: 'creating' }));

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('returns 400 when the session status is "terminated"', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession({ status: 'terminated' }));

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('includes the current session status in the error message when not active', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession({ status: 'terminating' }));

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.message).toContain('terminating');
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — file validation', () => {
  it('returns 400 when no file is uploaded (plain JSON body)', async () => {
    // Arrange — active session exists, but the request has no multipart file
    mockGetSession.mockReturnValue(createMockSession());

    // Act — send a JSON-typed request with an empty body
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });

    // Assert
    // @fastify/multipart rejects non-multipart requests; the handler catches
    // the error and returns 400 FILE_READ_ERROR (or 400 NO_FILE).
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
  });

  it('returns 400 with NO_FILE error code when file field is absent from multipart body', async () => {
    // Arrange — active session exists; we send a multipart request but without
    // a file part.  Build a boundary-only body (no file parts).
    mockGetSession.mockReturnValue(createMockSession());

    const boundary = 'FormBoundaryNoFile' + Date.now();
    // Multipart body with no parts — just an empty body delimiter
    const emptyMultipartBody = Buffer.from(
      `--${boundary}--\r\n`,
    );

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: emptyMultipartBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    // Assert — @fastify/multipart returns undefined when there are no parts;
    // the route returns 400 with code NO_FILE.
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('NO_FILE');
  });

  it('returns 400 with INVALID_FILE_EXTENSION when extension is rejected', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession()); // ios session
    mockValidateExtension.mockReturnValue(false); // reject any extension

    const { body, contentType } = buildMultipartPayload('MyApp.exe');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INVALID_FILE_EXTENSION');
  });

  it('includes the platform and allowed extensions in the invalid-extension error message', async () => {
    // Arrange — iOS session, invalid extension
    mockGetSession.mockReturnValue(createMockSession()); // platform: 'ios'
    mockValidateExtension.mockReturnValue(false);

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — message should mention the platform and allowed extensions
    const json = response.json();
    expect(json.error.message).toMatch(/ios/i);
    // Allowed extensions for iOS are .app and .ipa
    expect(json.error.message).toMatch(/\.app|\.ipa/i);
  });

  it('includes the received filename in the invalid-extension error message', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(false);

    const { body, contentType } = buildMultipartPayload('BadFile.xyz');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    const json = response.json();
    expect(json.error.message).toContain('BadFile.xyz');
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — iOS install', () => {
  const IOS_SESSION = createMockSession({
    device: {
      id: 'device-id',
      platform: 'ios',
      platformDeviceId: 'ABC-UDID-123',
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
  });

  it('returns 200 and the install result on successful iOS install', async () => {
    // Arrange
    mockGetSession.mockReturnValue(IOS_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'Installed successfully',
      installDurationMs: 500,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.result.success).toBe(true);
    expect(json.data.result.fileName).toBe('MyApp.ipa');
    expect(json.data.result.platform).toBe('ios');
  });

  it('calls installApp with temp file path, ios platform, UDID, and original filename', async () => {
    // Arrange
    mockGetSession.mockReturnValue(IOS_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'Installed',
      installDurationMs: 500,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — verify installApp was called with correct arguments
    expect(mockInstallApp).toHaveBeenCalledOnce();
    expect(mockInstallApp).toHaveBeenCalledWith(
      expect.any(String),  // temp file path (UUID-based, non-deterministic)
      'ios',
      'ABC-UDID-123',      // platformDeviceId from the iOS session
      'MyApp.ipa',         // original filename
    );
  });

  it('returns 422 with INSTALL_FAILED error code when iOS install fails', async () => {
    // Arrange
    mockGetSession.mockReturnValue(IOS_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: false,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'simctl error: device not found',
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(422);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('INSTALL_FAILED');
  });

  it('does NOT call androidEmulatorService.getAdbPort for iOS sessions', async () => {
    // Arrange
    mockGetSession.mockReturnValue(IOS_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'Installed',
      installDurationMs: 100,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — ADB port lookup must not be called for iOS
    expect(mockGetAdbPort).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — Android install', () => {
  /** An active Android session with AVD name as platformDeviceId. */
  const ANDROID_SESSION = createMockSession({
    device: {
      id: 'android-device-id',
      platform: 'android',
      platformDeviceId: 'test_avd',
      deviceType: {
        id: 'dt-android-id',
        name: 'Pixel 7',
        platform: 'android',
        modelName: 'Pixel 7',
        modelIdentifier: 'pixel_7',
      },
      runtime: {
        id: 'rt-android-id',
        platform: 'android',
        version: 'Android 14 (API 34)',
        identifier: 'android-34',
        status: 'installed',
      },
      state: 'booted',
    },
  });

  it('returns 200 on successful Android install', async () => {
    // Arrange
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(5554);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.apk',
      platform: 'android',
      message: 'Installed successfully',
      installDurationMs: 1200,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.success).toBe(true);
    expect(json.data.result.success).toBe(true);
    expect(json.data.result.platform).toBe('android');
  });

  it('calls installApp with "emulator-<port>" as the platformDeviceId for Android', async () => {
    // Arrange
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(5554);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.apk',
      platform: 'android',
      message: 'Installed',
      installDurationMs: 800,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — ADB serial must be constructed from port number
    expect(mockInstallApp).toHaveBeenCalledWith(
      expect.any(String),  // temp file path
      'android',
      'emulator-5554',     // ADB serial derived from getAdbPort() result
      'MyApp.apk',
    );
  });

  it('calls getAdbPort with the AVD name from the session', async () => {
    // Arrange
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(5554);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.apk',
      platform: 'android',
      message: 'Installed',
      installDurationMs: 400,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — should call getAdbPort with the AVD name from the session device
    expect(mockGetAdbPort).toHaveBeenCalledOnce();
    expect(mockGetAdbPort).toHaveBeenCalledWith('test_avd');
  });

  it('returns 500 with ADB_SERIAL_UNAVAILABLE when getAdbPort returns null', async () => {
    // Arrange
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(null);

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(response.statusCode).toBe(500);
    const json = response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('ADB_SERIAL_UNAVAILABLE');
  });

  it('does not call installApp when ADB port cannot be determined', async () => {
    // Arrange
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(null);

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — early return means installApp is never called
    expect(mockInstallApp).not.toHaveBeenCalled();
  });

  it('uses the correct ADB port when emulator is on a non-default port', async () => {
    // Arrange — emulator on port 5556 instead of default 5554
    mockGetSession.mockReturnValue(ANDROID_SESSION);
    mockValidateExtension.mockReturnValue(true);
    mockGetAdbPort.mockResolvedValue(5556);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.apk',
      platform: 'android',
      message: 'Installed',
      installDurationMs: 900,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.apk');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert
    expect(mockInstallApp).toHaveBeenCalledWith(
      expect.any(String),
      'android',
      'emulator-5556',
      'MyApp.apk',
    );
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — temp file cleanup', () => {
  it('calls unlink to clean up the temp file after a successful install', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'Installed',
      installDurationMs: 300,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — unlink must be called exactly once with the temp file path
    expect(mockUnlink).toHaveBeenCalledOnce();
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('wms-uploads'));
  });

  it('calls unlink to clean up the temp file even when install fails', async () => {
    // Arrange — install returns a failure result (not a throw)
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: false,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'simctl install failed',
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — route returns 422 but cleanup still happens (finally block)
    expect(response.statusCode).toBe(422);
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('calls unlink even when installApp throws an unexpected error', async () => {
    // Arrange — make installApp throw (simulates a crash inside the service)
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockRejectedValue(new Error('Unexpected crash'));

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — route should return 500, and cleanup should still happen
    expect(response.statusCode).toBe(500);
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('does NOT call unlink when the request fails before a temp file is created', async () => {
    // Arrange — session not found; the route returns 404 before writing any file
    mockGetSession.mockReturnValue(null);

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — no temp file was created, so unlink must not be called
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/apps — response shape', () => {
  it('wraps the install result in the standard ApiResponse envelope on success', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(true);
    mockInstallApp.mockResolvedValue({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'Installed',
      installDurationMs: 250,
    });

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — check envelope shape: { success: true, data: { result: ... } }
    const json = response.json();
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
    expect(json.data).toHaveProperty('result');
    expect(json.data.result).toMatchObject({
      success: true,
      fileName: 'MyApp.ipa',
      platform: 'ios',
    });
  });

  it('wraps the error in the standard ApiResponse envelope on failure', async () => {
    // Arrange
    mockGetSession.mockReturnValue(null);

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/some-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — check envelope shape: { success: false, error: { code, message } }
    const json = response.json();
    expect(json).toHaveProperty('success', false);
    expect(json).toHaveProperty('error');
    expect(json.error).toHaveProperty('code');
    expect(json.error).toHaveProperty('message');
  });

  it('the 422 response includes the full install result in error details', async () => {
    // Arrange
    mockGetSession.mockReturnValue(createMockSession());
    mockValidateExtension.mockReturnValue(true);
    const failedResult: AppInstallResult = {
      success: false,
      fileName: 'MyApp.ipa',
      platform: 'ios',
      message: 'simctl: process died',
    };
    mockInstallApp.mockResolvedValue(failedResult);

    const { body, contentType } = buildMultipartPayload('MyApp.ipa');

    // Act
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-id/apps',
      payload: body,
      headers: { 'content-type': contentType },
    });

    // Assert — the details field should contain the install result
    expect(response.statusCode).toBe(422);
    const json = response.json();
    expect(json.error.details).toMatchObject({ result: failedResult });
  });
});
