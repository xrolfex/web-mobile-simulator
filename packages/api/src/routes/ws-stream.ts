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
        // H.264 mode: subscribe to 'nalu' events from an existing capture session
        // and forward them as framed binary WebSocket messages.
        // -----------------------------------------------------------------------

        const deviceId = session.device?.platformDeviceId;

        if (!deviceId) {
          warn(`Missing device info for H.264 capture on session ${sessionId} — closing`);
          socket.close(1008, 'Missing device info for H.264 capture');
          return;
        }

        // For iOS, we may need to restart capture in H.264 mode. For Android,
        // capture is already started in H.264 mode by session-manager.
        // startCapture is idempotent — returns the existing emitter if already running.
        if (session.device.platform === 'ios') {
          const iosDeviceName = sessionManagerService.getIosDeviceName(sessionId);
          screenCaptureService.startCapture(
            sessionId,
            'ios',
            deviceId,
            undefined,
            iosDeviceName ?? deviceId,
            'h264',
          );
        }
        // For Android: capture is already started by session-manager in 'h264' mode.
        // startCapture is idempotent so calling it again would be safe, but we
        // don't need to — the emitter is already active.

        const emitter = screenCaptureService.getEmitter(sessionId);
        if (!emitter) {
          warn(`No active capture emitter for H.264 session ${sessionId} — closing`);
          socket.close(1008, 'No active capture for this session');
          return;
        }

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

        // For iOS, requestKeyframe() sends "K\n" to the capture binary's stdin
        // to force the encoder to produce an IDR frame immediately.
        // For Android/scrcpy, this is a no-op (scrcpy has no stdin control).
        screenCaptureService.requestKeyframe(sessionId);

        // Replay the last cached keyframe immediately so the browser's
        // WebCodecs decoder can start without waiting for the next natural IDR.
        // This is the primary mechanism for Android (where requestKeyframe is a
        // no-op) and an extra safety net for iOS.
        const cachedKeyframe = screenCaptureService.getLastKeyframe(sessionId);
        if (cachedKeyframe) {
          onNalu(cachedKeyframe);
        }

        // Clean up subscriptions and capture on disconnect.
        // For iOS, the H.264 capture lifecycle is tied to the WebSocket connection.
        // For Android, capture is owned by session-manager — we still stop it here
        // for symmetry (session-manager will also clean up on session termination).
        const cleanup = (): void => {
          emitter.off('nalu', onNalu);
          emitter.off('error', onCaptureError);
          // Only stop capture for iOS — for Android, capture lifecycle is managed by session-manager.
          if (session.device.platform === 'ios') {
            screenCaptureService.stopCapture(sessionId);
          }
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
      //   { type: 'touch', action: 'swipe', startX: 0.1, startY: 0.5, endX: 0.9, endY: 0.5, ... }
      //   { type: 'touch', action: 'drag-start', x: 0.5, y: 0.25 }  — iOS real-time drag begin
      //   { type: 'touch', action: 'drag-move',  x: 0.5, y: 0.30 }  — iOS real-time drag move (throttled ~30 fps)
      //   { type: 'touch', action: 'drag-end',   x: 0.5, y: 0.35 }  — iOS real-time drag end (Android: atomic swipe fallback)
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
              // For Android: normalised coords × real device resolution.
              // scrcpy streams at max_size=720 (downscaled), so deviceX/deviceY from
              // the frontend are in scrcpy frame space, not real device space.
              // We query the real resolution and scale normX/normY instead.
              if (typeof normX !== 'number' || typeof normY !== 'number') return;
              const platformDeviceId = session.device.platformDeviceId;
              androidEmulatorService.getScreenResolution(platformDeviceId).then((resolution) => {
                const realX = normX * resolution.width;
                const realY = normY * resolution.height;
                return androidEmulatorService.sendTap(platformDeviceId, realX, realY);
              }).catch((err: unknown) => {
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
              // For Android: normalised coords × real device resolution.
              // Same rationale as tap: scrcpy downscales to max_size=720 so
              // deviceStartX/Y etc. are in scrcpy frame space, not real device space.
              if (
                typeof normStartX !== 'number' || typeof normStartY !== 'number' ||
                typeof normEndX !== 'number' || typeof normEndY !== 'number'
              ) return;
              const platformDeviceId = session.device.platformDeviceId;
              androidEmulatorService.getScreenResolution(platformDeviceId).then((resolution) => {
                const realStartX = normStartX * resolution.width;
                const realStartY = normStartY * resolution.height;
                const realEndX = normEndX * resolution.width;
                const realEndY = normEndY * resolution.height;
                return androidEmulatorService.sendSwipe(
                  platformDeviceId,
                  realStartX, realStartY,
                  realEndX, realEndY,
                );
              }).catch((err: unknown) => {
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

          } else if (msg.type === 'touch' && msg.action === 'drag-start') {
            // Real-time drag: touch-down (Began) phase.
            // iOS: inject via IndigoHID immediately.
            // Android: store start coords for atomic swipe fallback on drag-end.
            const normX = msg.x as number;
            const normY = msg.y as number;
            if (typeof normX !== 'number' || typeof normY !== 'number') return;

            if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              iosSimulatorService.sendTouchBegin(
                session.device.platformDeviceId,
                normX,
                normY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward drag-start for session ${sessionId}: ${errMsg}`);
              });
            } else if (session.device.platform === 'android') {
              // Inject touch-down via the scrcpy control socket (action=0 = AMOTION_EVENT_ACTION_DOWN).
              screenCaptureService.sendScrcpyTouchEvent(sessionId, 0, normX, normY);
            }

          } else if (msg.type === 'touch' && msg.action === 'drag-move') {
            // Real-time drag: touch-move (Changed) phase.
            // iOS: fire-and-forget — no await to avoid queueing latency.
            // Android: inject via scrcpy control socket (fire-and-forget).
            const normX = msg.x as number;
            const normY = msg.y as number;
            if (typeof normX !== 'number' || typeof normY !== 'number') return;

            if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              iosSimulatorService.sendTouchMoveFire(
                session.device.platformDeviceId,
                normX,
                normY,
              );
            } else if (session.device.platform === 'android') {
              // Inject touch-move via the scrcpy control socket (action=2 = AMOTION_EVENT_ACTION_MOVE).
              screenCaptureService.sendScrcpyTouchEvent(sessionId, 2, normX, normY);
            }

          } else if (msg.type === 'touch' && msg.action === 'drag-end') {
            // Real-time drag: touch-up (Ended) phase.
            // iOS: inject via IndigoHID to close the gesture.
            // Android: fire an atomic swipe from the stored drag-start coords.
            const normX = msg.x as number;
            const normY = msg.y as number;
            if (typeof normX !== 'number' || typeof normY !== 'number') return;

            if (session.device.platform === 'ios' && session.device.platformDeviceId) {
              iosSimulatorService.sendTouchEnd(
                session.device.platformDeviceId,
                normX,
                normY,
              ).catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                warn(`Failed to forward drag-end for session ${sessionId}: ${errMsg}`);
              });
            } else if (session.device.platform === 'android') {
              // Inject touch-up via the scrcpy control socket (action=1 = AMOTION_EVENT_ACTION_UP).
              screenCaptureService.sendScrcpyTouchEvent(sessionId, 1, normX, normY);
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
