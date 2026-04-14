import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Session } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Mock services BEFORE importing the route module.
// Vitest hoists vi.mock() calls, so these always run before imports.
// ---------------------------------------------------------------------------

vi.mock('../services/index.js', () => ({
  screenCaptureService: {
    getEmitter: vi.fn(),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
  },
  sessionManagerService: {
    getSession: vi.fn(),
    getIosDeviceName: vi.fn(),
  },
  iosSimulatorService: {
    sendTap: vi.fn(),
    sendSwipe: vi.fn(),
    sendKeyEvent: vi.fn(),
  },
  androidEmulatorService: {
    sendTap: vi.fn(),
    sendSwipe: vi.fn(),
    sendKeyEvent: vi.fn(),
  },
}));

import wsStreamRoutes from './ws-stream.js';
import {
  screenCaptureService,
  sessionManagerService,
  androidEmulatorService,
  iosSimulatorService,
} from '../services/index.js';

// ---------------------------------------------------------------------------
// Typed mock references for easier usage in tests
// ---------------------------------------------------------------------------

const mockGetSession = vi.mocked(sessionManagerService.getSession);
const mockGetEmitter = vi.mocked(screenCaptureService.getEmitter);
const mockSendTap = vi.mocked(androidEmulatorService.sendTap);
const mockSendSwipe = vi.mocked(androidEmulatorService.sendSwipe);
const mockAndroidSendKeyEvent = vi.mocked(androidEmulatorService.sendKeyEvent);
const mockIosSendTap = vi.mocked(iosSimulatorService.sendTap);
const mockIosSendSwipe = vi.mocked(iosSimulatorService.sendSwipe);
const mockIosSendKeyEvent = vi.mocked(iosSimulatorService.sendKeyEvent);

// ---------------------------------------------------------------------------
// Test infrastructure — mock WebSocket and Fastify-like instance
// ---------------------------------------------------------------------------

/**
 * A map of event name → list of registered listener functions,
 * mirroring the subset of `ws.WebSocket` we need to test.
 */
interface MockSocketHandlers {
  close: Array<() => void>;
  error: Array<(err: Error) => void>;
  message: Array<(data: Buffer) => void>;
}

interface MockWebSocket {
  readyState: number;
  readonly OPEN: 1;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _handlers: MockSocketHandlers;
}

/** Build a fresh mock WebSocket whose `on()` stores listeners for later dispatch. */
function createMockSocket(readyState = 1): MockWebSocket {
  const handlers: MockSocketHandlers = { close: [], error: [], message: [] };

  const socket: MockWebSocket = {
    readyState,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') handlers.close.push(handler as () => void);
      else if (event === 'error') handlers.error.push(handler as (err: Error) => void);
      else if (event === 'message') handlers.message.push(handler as (data: Buffer) => void);
    }),
    _handlers: handlers,
  };

  return socket;
}

/** Build a mock Fastify-like request with the given sessionId. */
function createMockRequest(sessionId: string, query: Record<string, string> = {}) {
  return { params: { sessionId }, query };
}

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

/** Build a minimal active iOS session. */
function makeIosSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-ios-001',
    status: 'active',
    device: {
      id: 'device-ios-1',
      platform: 'ios',
      platformDeviceId: 'UDID-0001',
      deviceType: {
        id: 'dt-ios',
        name: 'iPhone 15',
        platform: 'ios',
        modelName: 'iPhone 15',
        modelIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
      },
      runtime: {
        id: 'rt-ios',
        platform: 'ios',
        version: 'iOS 17.5',
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        status: 'installed',
      },
      state: 'booted',
    },
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    ...overrides,
  } as Session;
}

/** Build a minimal active Android session. */
function makeAndroidSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-android-001',
    status: 'active',
    device: {
      id: 'device-android-1',
      platform: 'android',
      platformDeviceId: 'WMS_AVD_abc123',
      deviceType: {
        id: 'dt-android',
        name: 'Pixel 8',
        platform: 'android',
        modelName: 'Pixel 8',
        modelIdentifier: 'pixel_8',
      },
      runtime: {
        id: 'rt-android',
        platform: 'android',
        version: 'Android 14 (API 34)',
        identifier: 'system-images;android-34;google_apis;arm64-v8a',
        status: 'installed',
      },
      state: 'booted',
    },
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    ...overrides,
  } as Session;
}

// ---------------------------------------------------------------------------
// Handler extraction helper
//
// The plugin registers the WebSocket handler via fastify.get(...).
// We capture the handler by providing a mock Fastify instance and then
// call the handler directly with mock socket + request objects —
// no real HTTP server needed.
// ---------------------------------------------------------------------------

type WsHandler = (socket: unknown, request: unknown) => void;

/**
 * Import the plugin and call it with a mock Fastify instance to capture the
 * registered WebSocket handler function, then return it ready for direct invocation.
 */
async function extractHandler(): Promise<WsHandler> {
  let capturedHandler: WsHandler | undefined;

  const mockFastify = {
    get: vi.fn(
      (_path: string, _opts: unknown, handler: WsHandler) => {
        capturedHandler = handler;
      },
    ),
  };

  // Call the plugin function (default export) with the mock Fastify instance.
  await wsStreamRoutes(mockFastify as unknown as Parameters<typeof wsStreamRoutes>[0], {});

  if (!capturedHandler) {
    throw new Error('Plugin did not register a GET handler — check ws-stream.ts');
  }

  return capturedHandler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let handler: WsHandler;

beforeEach(async () => {
  vi.clearAllMocks();

  // Suppress log noise from the route's internal log/warn helpers.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // Extract the handler once per test (cheap — no server spun up).
  handler = await extractHandler();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Session validation
// ---------------------------------------------------------------------------

describe('session validation', () => {
  it('should close socket with code 1008 when session is not found', () => {
    // Arrange
    mockGetSession.mockReturnValue(null);
    const socket = createMockSocket();
    const request = createMockRequest('session-missing');

    // Act
    handler(socket, request);

    // Assert
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('should NOT register frame/error/message listeners when session is not found', () => {
    // Arrange
    mockGetSession.mockReturnValue(null);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-missing'));

    // Assert — socket.on must never be called (no emitter subscriptions attempted)
    expect(socket.on).not.toHaveBeenCalled();
  });

  it('should close socket with code 1008 when session status is "creating"', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession({ status: 'creating' }));
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('should close socket with code 1008 when session status is "terminated"', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession({ status: 'terminated' }));
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('should close socket with code 1008 when session status is "terminating"', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession({ status: 'terminating' }));
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('should close socket with code 1008 when session status is "error"', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession({ status: 'error' }));
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// 2. Emitter validation
// ---------------------------------------------------------------------------

describe('emitter validation', () => {
  it('should close socket with code 1008 when no emitter exists for the session', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(null);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('should NOT forward any frames when emitter is null', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(null);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-android-001'));

    // Assert
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('should call getEmitter with the correct sessionId', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(null);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(mockGetEmitter).toHaveBeenCalledWith('session-ios-001');
  });

  it('should call getEmitter with a custom sessionId extracted from request params', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(null);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('my-custom-session-id'));

    // Assert
    expect(mockGetEmitter).toHaveBeenCalledWith('my-custom-session-id');
  });
});

// ---------------------------------------------------------------------------
// 3. Frame forwarding
// ---------------------------------------------------------------------------

describe('frame forwarding', () => {
  it('should forward frame buffers as binary WebSocket messages when frames are emitted', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket(); // readyState = OPEN = 1

    handler(socket, createMockRequest('session-ios-001'));

    const fakeFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    // Act
    emitter.emit('frame', fakeFrame);

    // Assert
    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith(fakeFrame);
  });

  it('should forward multiple consecutive frames in order', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const frame1 = Buffer.from([0x01]);
    const frame2 = Buffer.from([0x02]);
    const frame3 = Buffer.from([0x03]);

    // Act
    emitter.emit('frame', frame1);
    emitter.emit('frame', frame2);
    emitter.emit('frame', frame3);

    // Assert
    expect(socket.send).toHaveBeenCalledTimes(3);
    expect(socket.send).toHaveBeenNthCalledWith(1, frame1);
    expect(socket.send).toHaveBeenNthCalledWith(2, frame2);
    expect(socket.send).toHaveBeenNthCalledWith(3, frame3);
  });

  it('should NOT send frames when socket readyState is not OPEN (e.g. CLOSING = 2)', () => {
    // Arrange — socket is in CLOSING state (readyState = 2)
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket(2); // CLOSING

    handler(socket, createMockRequest('session-ios-001'));

    // Act
    emitter.emit('frame', Buffer.from([0xab, 0xcd]));

    // Assert
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('should NOT send frames when socket readyState is CLOSED (= 3)', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket(3); // CLOSED

    handler(socket, createMockRequest('session-ios-001'));

    // Act
    emitter.emit('frame', Buffer.from([0xde, 0xad]));

    // Assert
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('should NOT send frames when socket readyState is CONNECTING (= 0)', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket(0); // CONNECTING

    handler(socket, createMockRequest('session-ios-001'));

    // Act
    emitter.emit('frame', Buffer.from([0x11]));

    // Assert
    expect(socket.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('should close socket with code 1011 when the capture emitter emits an error event', () => {
    // Arrange
    const emitter = new EventEmitter();
    // Prevent Node from throwing on unhandled 'error' events during the test
    emitter.on('error', () => {});

    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const captureErr = new Error('capture failed catastrophically');

    // Act
    emitter.emit('error', captureErr);

    // Assert
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1011, expect.stringContaining('capture failed catastrophically'));
  });

  it('should NOT close socket on capture error when socket is already closed', () => {
    // Arrange
    const emitter = new EventEmitter();
    emitter.on('error', () => {});

    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket(3); // CLOSED

    handler(socket, createMockRequest('session-ios-001'));

    // Act
    emitter.emit('error', new Error('late error'));

    // Assert — readyState !== OPEN so close must not be called
    expect(socket.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Cleanup (event listener removal)
// ---------------------------------------------------------------------------

describe('cleanup on socket close/error', () => {
  it('should remove frame and error listeners from the emitter when socket closes', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // Verify that frame listener was registered
    expect(emitter.listenerCount('frame')).toBe(1);
    expect(emitter.listenerCount('error')).toBeGreaterThanOrEqual(1);

    // Act — simulate socket 'close' event
    socket._handlers.close.forEach((fn) => fn());

    // Assert — listeners removed
    expect(emitter.listenerCount('frame')).toBe(0);
  });

  it('should remove error listener from the emitter when socket closes', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const errorListenersBefore = emitter.listenerCount('error');

    // Act
    socket._handlers.close.forEach((fn) => fn());

    // Assert — onCaptureError listener removed
    expect(emitter.listenerCount('error')).toBe(errorListenersBefore - 1);
  });

  it('should remove frame and error listeners from the emitter when socket errors', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    expect(emitter.listenerCount('frame')).toBe(1);

    // Act — simulate socket 'error' event
    socket._handlers.error.forEach((fn) => fn(new Error('ws error')));

    // Assert
    expect(emitter.listenerCount('frame')).toBe(0);
  });

  it('should NOT forward frames after socket close triggers cleanup', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // Simulate close
    socket._handlers.close.forEach((fn) => fn());

    // Act — emit frame AFTER cleanup
    emitter.emit('frame', Buffer.from([0xff]));

    // Assert — no frames sent after cleanup
    expect(socket.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Touch input forwarding — tap
// ---------------------------------------------------------------------------

describe('touch input — tap', () => {
  it('should call androidEmulatorService.sendTap() with correct coordinates for Android tap events', async () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(emitter);
    mockSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 540, deviceY: 960 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));

    // Flush microtask queue so the .catch() chain settles
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).toHaveBeenCalledOnce();
    expect(mockSendTap).toHaveBeenCalledWith('WMS_AVD_abc123', 540, 960);
  });

  it('should call sendTap with the platformDeviceId from the session', async () => {
    // Arrange — Android session with a specific AVD name
    const session = makeAndroidSession();
    (session.device as { platformDeviceId: string }).platformDeviceId = 'WMS_AVD_custom99';
    mockGetSession.mockReturnValue(session);
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 100, deviceY: 200 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).toHaveBeenCalledWith('WMS_AVD_custom99', 100, 200);
  });

  it('should call iosSimulatorService.sendTap() with normalized coords and NOT call Android sendTap() for iOS tap events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // iOS tap message includes both normalized (x/y) and device pixel (deviceX/deviceY) coords
    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', x: 0.5, y: 0.3125, deviceX: 320, deviceY: 480 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — iOS service called with normalized coordinates
    expect(mockIosSendTap).toHaveBeenCalledOnce();
    expect(mockIosSendTap).toHaveBeenCalledWith('UDID-0001', 0.5, 0.3125);
    // Android service must NOT be called for an iOS session
    expect(mockSendTap).not.toHaveBeenCalled();
  });

  it('should silently ignore tap messages with missing deviceX', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    // deviceX is missing
    const badMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceY: 960 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).not.toHaveBeenCalled();
  });

  it('should silently ignore tap messages with missing deviceY', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    // deviceY is missing
    const badMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 540 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).not.toHaveBeenCalled();
  });

  it('should silently ignore tap messages where deviceX is a string instead of number', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: '540', deviceY: 960 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).not.toHaveBeenCalled();
  });

  it('should silently ignore non-JSON messages', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    // Act — send raw binary (not valid JSON)
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    socket._handlers.message.forEach((fn) => fn(binaryData));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — no tap or swipe called, no error thrown
    expect(mockSendTap).not.toHaveBeenCalled();
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore plain text messages that are not JSON', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    // Act
    const textMsg = Buffer.from('hello world');
    socket._handlers.message.forEach((fn) => fn(textMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).not.toHaveBeenCalled();
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should NOT call sendTap() when Android session has no platformDeviceId', async () => {
    // Arrange — platform is android but platformDeviceId is empty/falsy
    const session = makeAndroidSession();
    (session.device as { platformDeviceId: string }).platformDeviceId = '';
    mockGetSession.mockReturnValue(session);
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 100, deviceY: 200 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendTap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. Touch input forwarding — swipe
// ---------------------------------------------------------------------------

describe('touch input — swipe', () => {
  it('should call androidEmulatorService.sendSwipe() with correct coordinates for Android swipe events', async () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(emitter);
    mockSendSwipe.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(swipeMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).toHaveBeenCalledOnce();
    expect(mockSendSwipe).toHaveBeenCalledWith(
      'WMS_AVD_abc123',
      108, 960,
      972, 960,
    );
  });

  it('should call iosSimulatorService.sendSwipe() with normalized coords and NOT call Android sendSwipe() for iOS swipe events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendSwipe.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // iOS swipe message includes both normalized (startX/startY/endX/endY) and device pixel coords
    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        startX: 0.1,
        startY: 0.5,
        endX: 0.9,
        endY: 0.5,
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(swipeMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — iOS service called with normalized coordinates
    expect(mockIosSendSwipe).toHaveBeenCalledOnce();
    expect(mockIosSendSwipe).toHaveBeenCalledWith('UDID-0001', 0.1, 0.5, 0.9, 0.5);
    // Android service must NOT be called for an iOS session
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore swipe messages with missing deviceStartX', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        // deviceStartX missing
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore swipe messages with missing deviceStartY', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 108,
        // deviceStartY missing
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore swipe messages with missing deviceEndX', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 108,
        deviceStartY: 960,
        // deviceEndX missing
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore swipe messages with missing deviceEndY', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        // deviceEndY missing
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore swipe messages where coordinate values are strings', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const badMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: '108',
        deviceStartY: '960',
        deviceEndX: '972',
        deviceEndY: '960',
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(badMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should handle sendSwipe() promise rejection without throwing (logged as warn)', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockSendSwipe.mockRejectedValue(new Error('adb swipe failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 0,
        deviceStartY: 0,
        deviceEndX: 100,
        deviceEndY: 100,
      }),
    );

    // Act & Assert — must not throw
    expect(() => {
      socket._handlers.message.forEach((fn) => fn(swipeMsg));
    }).not.toThrow();

    // Let the rejection settle — it is caught by .catch() inside the route
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('should handle sendTap() promise rejection without throwing (logged as warn)', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockSendTap.mockRejectedValue(new Error('adb tap failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 100, deviceY: 200 }),
    );

    // Act & Assert — must not throw
    expect(() => {
      socket._handlers.message.forEach((fn) => fn(tapMsg));
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ---------------------------------------------------------------------------
// 8. Happy-path integration (session valid + emitter active)
// ---------------------------------------------------------------------------

describe('happy path — successful connection setup', () => {
  it('should NOT close the socket when session is active and emitter exists', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert — socket should remain open
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('should register close, error, and message listeners on the socket', () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-android-001'));

    // Assert — socket.on must have been called with each event type
    const registeredEvents = (socket.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(registeredEvents).toContain('close');
    expect(registeredEvents).toContain('error');
    expect(registeredEvents).toContain('message');
  });

  it('should register frame and error listeners on the emitter', () => {
    // Arrange
    const emitter = new EventEmitter();
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(emitter);
    const socket = createMockSocket();

    // Act
    handler(socket, createMockRequest('session-ios-001'));

    // Assert
    expect(emitter.listenerCount('frame')).toBe(1);
    // At least one error listener registered by the route itself
    expect(emitter.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Key input forwarding
// ---------------------------------------------------------------------------

describe('key input forwarding', () => {
  it('should call androidEmulatorService.sendKeyEvent() for Android key events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockAndroidSendKeyEvent.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: 'Enter', code: 'Enter' }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(keyMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockAndroidSendKeyEvent).toHaveBeenCalledOnce();
    expect(mockAndroidSendKeyEvent).toHaveBeenCalledWith('WMS_AVD_abc123', 'Enter', 'Enter');
    expect(mockIosSendKeyEvent).not.toHaveBeenCalled();
  });

  it('should call iosSimulatorService.sendKeyEvent() for iOS key events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendKeyEvent.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: 'a', code: 'KeyA' }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(keyMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockIosSendKeyEvent).toHaveBeenCalledOnce();
    expect(mockIosSendKeyEvent).toHaveBeenCalledWith('UDID-0001', 'a', 'KeyA');
    expect(mockAndroidSendKeyEvent).not.toHaveBeenCalled();
  });

  it('should silently ignore key messages with empty key', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: '', code: 'KeyA' }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(keyMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — empty key is rejected before any service call
    expect(mockAndroidSendKeyEvent).not.toHaveBeenCalled();
    expect(mockIosSendKeyEvent).not.toHaveBeenCalled();
  });

  it('should silently ignore key messages with non-string key', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: 123, code: 'KeyA' }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(keyMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — numeric key value must be rejected silently
    expect(mockAndroidSendKeyEvent).not.toHaveBeenCalled();
    expect(mockIosSendKeyEvent).not.toHaveBeenCalled();
  });

  it('should handle sendKeyEvent() rejection without throwing for Android', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeAndroidSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockAndroidSendKeyEvent.mockRejectedValue(new Error('key failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-android-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: 'Enter', code: 'Enter' }),
    );

    // Act & Assert — must not throw synchronously
    expect(() => {
      socket._handlers.message.forEach((fn) => fn(keyMsg));
    }).not.toThrow();

    // Let the rejection settle — it is caught by .catch() inside the route
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('should handle sendKeyEvent() rejection and send error message to socket for iOS', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendKeyEvent.mockRejectedValue(new Error('AppleScript key failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const keyMsg = Buffer.from(
      JSON.stringify({ type: 'key', key: 'Escape', code: 'Escape' }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(keyMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — error is caught and forwarded to the socket as JSON
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('Key event failed'),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. iOS tap forwarding (additional coverage)
// ---------------------------------------------------------------------------

describe('iOS tap forwarding', () => {
  it('should call iosSimulatorService.sendTap() with normalized coordinates for iOS tap events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendTap.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', x: 0.5, y: 0.25, deviceX: 540, deviceY: 480 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockIosSendTap).toHaveBeenCalledOnce();
    expect(mockIosSendTap).toHaveBeenCalledWith('UDID-0001', 0.5, 0.25);
    expect(mockSendTap).not.toHaveBeenCalled();
  });

  it('should silently ignore iOS tap when normalized coords (x/y) are missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // No x or y — only device pixel coords
    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', deviceX: 540, deviceY: 480 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — missing normalized coords causes early return before calling iOS service
    expect(mockIosSendTap).not.toHaveBeenCalled();
  });

  it('should handle iOS sendTap() rejection and send error to socket', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendTap.mockRejectedValue(new Error('AppleScript failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const tapMsg = Buffer.from(
      JSON.stringify({ type: 'touch', action: 'tap', x: 0.5, y: 0.25, deviceX: 540, deviceY: 480 }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(tapMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — error propagated back to the socket as JSON with "Tap failed"
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('Tap failed'),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. iOS swipe forwarding (additional coverage)
// ---------------------------------------------------------------------------

describe('iOS swipe forwarding', () => {
  it('should call iosSimulatorService.sendSwipe() with normalized coordinates for iOS swipe events', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendSwipe.mockResolvedValue(undefined);
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        startX: 0.1,
        startY: 0.5,
        endX: 0.9,
        endY: 0.5,
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(swipeMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(mockIosSendSwipe).toHaveBeenCalledOnce();
    expect(mockIosSendSwipe).toHaveBeenCalledWith('UDID-0001', 0.1, 0.5, 0.9, 0.5);
    expect(mockSendSwipe).not.toHaveBeenCalled();
  });

  it('should silently ignore iOS swipe when normalized coords (startX/startY/endX/endY) are missing', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    // Only device pixel coords present — no normalized startX/startY/endX/endY
    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(swipeMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — missing normalized coords causes early return before calling iOS service
    expect(mockIosSendSwipe).not.toHaveBeenCalled();
  });

  it('should handle iOS sendSwipe() rejection and send error to socket', async () => {
    // Arrange
    mockGetSession.mockReturnValue(makeIosSession());
    mockGetEmitter.mockReturnValue(new EventEmitter());
    mockIosSendSwipe.mockRejectedValue(new Error('AppleScript swipe failed'));
    const socket = createMockSocket();

    handler(socket, createMockRequest('session-ios-001'));

    const swipeMsg = Buffer.from(
      JSON.stringify({
        type: 'touch',
        action: 'swipe',
        startX: 0.1,
        startY: 0.5,
        endX: 0.9,
        endY: 0.5,
        deviceStartX: 108,
        deviceStartY: 960,
        deviceEndX: 972,
        deviceEndY: 960,
      }),
    );

    // Act
    socket._handlers.message.forEach((fn) => fn(swipeMsg));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert — error propagated back to the socket as JSON with "Swipe failed"
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('Swipe failed'),
    );
  });
});
