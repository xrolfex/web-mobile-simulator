import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import {
  screenCaptureService,
  sessionManagerService,
  webRTCStreamService,
} from '../services/index.js';
import type { SignalingMessage } from '../services/webrtc-stream.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WsWebRTCRoute]';

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
 * WebRTC signaling WebSocket route plugin.
 *
 * Registers `GET /ws/webrtc/:sessionId` as a WebSocket endpoint.
 * When a browser connects:
 * 1. The WMS session is verified to exist and be in `'active'` status.
 * 2. A WebRTC peer connection is created for the session via
 *    {@link webRTCStreamService}.
 * 3. ICE candidates gathered by the server are forwarded to the browser.
 * 4. Signaling messages (SDP offer, ICE candidates) from the browser are
 *    forwarded to {@link webRTCStreamService.handleSignaling} and responses
 *    are sent back. After the SDP offer is handled and the answer is sent,
 *    any existing JPEG capture is stopped and a new H.264 capture is started.
 *    Hooking up the NALU emitter to the WebRTC video track is **deferred**
 *    until `pc.connectionState === 'connected'` so that the DTLS handshake
 *    is complete before RTP packets are written (werift silently drops packets
 *    sent before DTLS connects, which would discard the critical first keyframe).
 * 5. On WebSocket close or error the WebRTC session is torn down.
 */
const wsWebRTCRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/ws/webrtc/:sessionId',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };

      log(`WebRTC signaling WebSocket connection for session ${sessionId}`);

      // 1. Verify the session exists and is active.
      const session = sessionManagerService.getSession(sessionId);
      if (!session || session.status !== 'active') {
        warn(`Session ${sessionId} not found or not active — closing`);
        socket.close(1008, 'Session not found or not active');
        return;
      }

      // 2. Create a WebRTC peer connection for this session.
      const pc = webRTCStreamService.createSession(sessionId);

      // ── Diagnostic: log ALL connection state transitions ────────────
      pc.connectionStateChange.subscribe((state: string) => {
        log(`[DIAG] connectionState for ${sessionId}: ${state}`);
      });
      pc.iceConnectionStateChange.subscribe((state: string) => {
        log(`[DIAG] iceConnectionState for ${sessionId}: ${state}`);
      });
      pc.signalingStateChange.subscribe((state: string) => {
        log(`[DIAG] signalingState for ${sessionId}: ${state}`);
      });

      // 3. Wire up ICE candidates to be sent to the browser.
      pc.onIceCandidate.subscribe((candidate) => {
        if (candidate && socket.readyState === socket.OPEN) {
          const msg: SignalingMessage = {
            type: 'candidate',
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          };
          socket.send(JSON.stringify(msg));
        }
      });

      // 4. Handle signaling messages from the browser.
      socket.on('message', (data: Buffer) => {
        void (async () => {
          try {
            const msg = JSON.parse(data.toString()) as SignalingMessage;
            const response = await webRTCStreamService.handleSignaling(sessionId, msg);

            // [DIAG] Log full SDP offer and answer to verify H.264 codec agreement.
            if (msg.type === 'offer') {
              log(`[DIAG] SDP Offer for ${sessionId}:\n${msg.sdp}`);
              if (response && response.type === 'answer') {
                log(`[DIAG] SDP Answer for ${sessionId}:\n${(response as { type: 'answer'; sdp: string }).sdp}`);
              }
            }

            if (response && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(response));
            }

            // Both startCapture() AND connectCapture() are deferred until
            // DTLS reaches 'connected'.  This ensures the first keyframe
            // (which carries the critical SPS/PPS parameter sets) is never
            // lost — the NALU listener is installed before the Swift binary
            // emits any frames.
            if (msg.type === 'offer') {
              const udid = session.device?.platformDeviceId;
              const iosDeviceName = sessionManagerService.getIosDeviceName(sessionId);
              if (session.device?.platform === 'ios' && udid && iosDeviceName) {
                // Stop any existing JPEG capture.
                screenCaptureService.stopCapture(sessionId);

                // Defer BOTH startCapture AND connectCapture until DTLS is
                // connected.  This ensures the first keyframe (which carries
                // the critical SPS/PPS parameter sets) is never lost — the
                // NALU listener is installed before the Swift binary emits any
                // frames.
                const attachCapture = (): void => {
                  log(`DTLS connected for session ${sessionId} — starting H.264 capture`);
                  const emitter = screenCaptureService.startCapture(
                    sessionId,
                    'ios',
                    udid,
                    undefined,
                    iosDeviceName,
                    'h264',
                  );
                  webRTCStreamService.connectCapture(sessionId, emitter);
                };

                // Subscribe FIRST, then check current state, to avoid a race where
                // the state transitions between the if-check and the .subscribe() call.
                const sub = pc.connectionStateChange.subscribe((state: string) => {
                  if (state === 'connected') {
                    sub.unSubscribe();
                    attachCapture();
                  }
                });
                // If already connected by the time we subscribed, fire immediately.
                if (pc.connectionState === 'connected') {
                  sub.unSubscribe();
                  attachCapture();
                }
              }
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            warn(`Signaling error for session ${sessionId}: ${errMsg}`);
            if (socket.readyState === socket.OPEN) {
              const errorMsg: SignalingMessage = { type: 'error', message: errMsg };
              socket.send(JSON.stringify(errorMsg));
            }
          }
        })();
      });

      // 5. Clean up on close.
      socket.on('close', () => {
        log(`WebRTC signaling WebSocket closed for session ${sessionId}`);
        screenCaptureService.stopCapture(sessionId);
        void webRTCStreamService.stopSession(sessionId);
      });

      socket.on('error', (err: Error) => {
        warn(`WebRTC signaling WebSocket error for session ${sessionId}: ${err.message}`);
        screenCaptureService.stopCapture(sessionId);
        void webRTCStreamService.stopSession(sessionId);
      });
    },
  );
};

export default wsWebRTCRoutes;
