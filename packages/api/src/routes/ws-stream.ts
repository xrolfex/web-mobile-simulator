import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { screenCaptureService, sessionManagerService, iosSimulatorService, androidEmulatorService } from '../services/index.js';
import type { NaluFrame } from '../services/screen-capture.js';

// ---------------------------------------------------------------------------
// Module-level helpers (mirrors ws-events.ts style)
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WsStreamRoute]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Screenshot-based MJPEG streaming and H.264 NALU streaming WebSocket route plugin.
 *
 * Registers `GET /ws/stream/:sessionId` as a WebSocket endpoint.
 * Supports two streaming modes selected via the `?format` query parameter:
 *
 * **MJPEG mode** (default, no query param or `?format=mjpeg`):
 * 1. The session is verified to exist and be in `'active'` status.
 * 2. The frame emitter for the session is retrieved from
 *    {@link screenCaptureService}.
 * 3. Each `'frame'` event from the emitter is forwarded to the browser as a
 *    binary WebSocket message (raw JPEG or PNG bytes).
 * 4. On WebSocket close or error, subscriptions are cleaned up.
 * 5. On capture error the WebSocket is closed with code 1011.
 *
 * **H.264 mode** (`?format=h264`):
 * 1. The session is verified to exist and be in `'active'` status.
 * 2. Any existing JPEG capture is stopped and a new H.264 capture is started
 *    via {@link screenCaptureService.startCapture}.
 * 3. Each `'nalu'` event is forwarded to the browser as a binary WebSocket
 *    message with a 9-byte header: `[1B flags (bit 0 = isKeyframe)][8B BE timestamp_us][NALU data]`.
 * 4. On WebSocket close or error, subscriptions are cleaned up and
 *    {@link screenCaptureService.stopCapture} is called.
 * 5. On capture error the WebSocket is closed with code 1011.
 *
 * Input messages from the browser are JSON-encoded events for touch and key
 * input forwarding to the device (identical in both modes).
 */
const wsStreamRoutes: FastifyPluginAsync = async (fastify) => {
  // @fastify/websocket v11 + Fastify 5: handler receives (socket, request)
  // where `socket` is the raw `ws` WebSocket instance.
  fastify.get(
    '/ws/stream/:sessionId',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };
      const query = request.query as Record<string, string>;
      const isH264 = query['format'] === 'h264';

      log(`Stream WebSocket connection for session ${sessionId} (${isH264 ? 'H.264' : 'MJPEG'})`);

      // 1. Verify the session exists and is active.
      const session = sessionManagerService.getSession(sessionId);
      if (!session || session.status !== 'active') {
        warn(`Session ${sessionId} not found or not active — closing`);
        socket.close(1008, 'Session not found or not active');
        return;
      }

      if (isH264) {
        // -----------------------------------------------------------------------
        // H.264 mode: stop any existing JPEG capture, start H.264, subscribe to
        // 'nalu' events and forward them as framed binary WebSocket messages.
        // -----------------------------------------------------------------------

        const udid = session.device?.platformDeviceId;
        const iosDeviceName = sessionManagerService.getIosDeviceName(sessionId);

        if (!udid || !iosDeviceName) {
          warn(`Missing device info for H.264 capture on session ${sessionId} — closing`);
          socket.close(1008, 'Missing device info for H.264 capture');
          return;
        }

        // Start H.264 capture if not already running (startCapture is idempotent —
        // returns the existing emitter if capture is already active for this session).
        const emitter = screenCaptureService.startCapture(
          sessionId,
          'ios',
          udid,
          undefined,
          iosDeviceName,
          'h264',
        );

        // Force the very first frame to be a keyframe so the client can start
        // decoding immediately instead of waiting for the next natural IDR.
        screenCaptureService.requestKeyframe(sessionId);

        // Subscribe to NALU events and forward as framed binary messages.
        // Binary message layout:
        //   [1 byte: flags (bit 0 = isKeyframe)]
        //   [8 bytes BE: timestamp in microseconds (BigInt)]
        //   [remaining: raw Annex B NALU data]
        const onNalu = (frame: NaluFrame): void => {
          if (socket.readyState === socket.OPEN) {
            const flags = Buffer.alloc(1);
            flags[0] = frame.isKeyframe ? 1 : 0;

            const timestamp = Buffer.alloc(8);
            timestamp.writeBigUInt64BE(frame.timestampUs);

            const message = Buffer.concat([flags, timestamp, frame.naluData]);
            socket.send(message);
          }
        };

        const onCaptureError = (err: Error): void => {
          warn(`H.264 capture error for session ${sessionId}: ${err.message}`);
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, `Capture error: ${err.message}`);
          }
        };

        emitter.on('nalu', onNalu);
        emitter.on('error', onCaptureError);

        // Clean up subscriptions, listeners, and capture on disconnect.
        const cleanup = (): void => {
          emitter.off('nalu', onNalu);
          emitter.off('error', onCaptureError);
          screenCaptureService.stopCapture(sessionId);
          log(`H.264 stream WebSocket cleaned up for session ${sessionId}`);
        };

        socket.on('close', () => {
          log(`H.264 stream WebSocket closed for session ${sessionId}`);
          cleanup();
        });

        socket.on('error', (err: Error) => {
          warn(`H.264 stream WebSocket error for session ${sessionId}: ${err.message}`);
          cleanup();
        });
      } else {
        // -----------------------------------------------------------------------
        // MJPEG mode: existing behaviour — unchanged.
        // -----------------------------------------------------------------------

        // 2. Get the frame emitter for this session.
        const emitter = screenCaptureService.getEmitter(sessionId);
        if (!emitter) {
          warn(`No active screen capture for session ${sessionId} — closing`);
          socket.close(1008, 'No active capture for this session');
          return;
        }

        // 3. Subscribe to frame events and forward as binary WebSocket messages.
        const onFrame = (frame: Buffer): void => {
          if (socket.readyState === socket.OPEN) {
            socket.send(frame);
          }
        };

        const onCaptureError = (err: Error): void => {
          warn(`Capture error for session ${sessionId}: ${err.message}`);
          if (socket.readyState === socket.OPEN) {
            socket.close(1011, `Capture error: ${err.message}`);
          }
        };

        emitter.on('frame', onFrame);
        emitter.on('error', onCaptureError);

        // 4. Clean up subscriptions on disconnect.
        const cleanup = (): void => {
          emitter.off('frame', onFrame);
          emitter.off('error', onCaptureError);
          log(`Stream WebSocket cleaned up for session ${sessionId}`);
        };

        socket.on('close', () => {
          log(`Stream WebSocket closed for session ${sessionId}`);
          cleanup();
        });

        socket.on('error', (err: Error) => {
          warn(`Stream WebSocket error for session ${sessionId}: ${err.message}`);
          cleanup();
        });
      }

      // -------------------------------------------------------------------------
      // 5. Handle input messages from the browser (touch/key forwarding).
      // Identical in both MJPEG and H.264 modes.
      // Messages are JSON-encoded:
      //   { type: 'touch', action: 'tap', x: 0.5, y: 0.25, deviceX: 540, deviceY: 960 }
      //   { type: 'touch', action: 'swipe', startX: 0.1, startY: 0.5, endX: 0.9, endY: 0.5, deviceStartX: 108, deviceStartY: 960, deviceEndX: 972, deviceEndY: 960 }
      // -------------------------------------------------------------------------
      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;

          if (msg.type === 'touch' && msg.action === 'tap') {
            const deviceX = msg.deviceX as number;
            const deviceY = msg.deviceY as number;
            // Normalised 0–1 coordinates sent by the frontend alongside device pixels.
            const normX = msg.x as number;
            const normY = msg.y as number;

            if (typeof deviceX !== 'number' || typeof deviceY !== 'number') {
              return; // Silently ignore malformed messages
            }

            if (session.device.platform === 'android' && session.device.platformDeviceId) {
              // For Android: use device pixel coordinates with adb input tap.
              androidEmulatorService.sendTap(
                session.device.platformDeviceId,
                deviceX,
                deviceY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward tap for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Tap failed: ${errMsg}` }));
                }
              });
            } else if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              // For iOS: use normalised coordinates for AppleScript window-relative mapping.
              if (typeof normX !== 'number' || typeof normY !== 'number') return;
              iosSimulatorService.sendTap(
                session.device.platformDeviceId,
                normX,
                normY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward tap for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Tap failed: ${errMsg}` }));
                }
              });
            }
          } else if (msg.type === 'touch' && msg.action === 'swipe') {
            const deviceStartX = msg.deviceStartX as number;
            const deviceStartY = msg.deviceStartY as number;
            const deviceEndX = msg.deviceEndX as number;
            const deviceEndY = msg.deviceEndY as number;
            // Normalised 0–1 coordinates sent by the frontend alongside device pixels.
            const normStartX = msg.startX as number;
            const normStartY = msg.startY as number;
            const normEndX = msg.endX as number;
            const normEndY = msg.endY as number;

            if (
              typeof deviceStartX !== 'number' || typeof deviceStartY !== 'number' ||
              typeof deviceEndX !== 'number' || typeof deviceEndY !== 'number'
            ) {
              return;
            }

            if (session.device.platform === 'android' && session.device.platformDeviceId) {
              // For Android: use device pixel coordinates.
              androidEmulatorService.sendSwipe(
                session.device.platformDeviceId,
                deviceStartX, deviceStartY,
                deviceEndX, deviceEndY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward swipe for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Swipe failed: ${errMsg}` }));
                }
              });
            } else if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              // For iOS: use normalised coordinates for AppleScript window-relative mapping.
              if (
                typeof normStartX !== 'number' || typeof normStartY !== 'number' ||
                typeof normEndX !== 'number' || typeof normEndY !== 'number'
              ) return;
              iosSimulatorService.sendSwipe(
                session.device.platformDeviceId,
                normStartX, normStartY,
                normEndX, normEndY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward swipe for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Swipe failed: ${errMsg}` }));
                }
              });
            }
          } else if (msg.type === 'key') {
            const key = msg.key as string;
            const code = msg.code as string;

            if (typeof key !== 'string' || !key) return;

            if (session.device.platform === 'android' && session.device.platformDeviceId) {
              androidEmulatorService.sendKeyEvent(
                session.device.platformDeviceId,
                key,
                code,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward key event for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Key event failed: ${errMsg}` }));
                }
              });
            } else if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              iosSimulatorService.sendKeyEvent(
                session.device.platformDeviceId,
                key,
                code,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward key event for session ${sessionId}: ${errMsg}`);
                if (socket.readyState === 1 /* WebSocket.OPEN */) {
                  socket.send(JSON.stringify({ type: 'error', message: `Key event failed: ${errMsg}` }));
                }
              });
            }
          }
        } catch {
          // Ignore non-JSON messages silently.
        }
      });
    },
  );
};

export default wsStreamRoutes;
