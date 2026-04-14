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

            if (response && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(response));
            }

            // Start H.264 capture AFTER the SDP answer has been sent, so the
            // peer connection's video track is ready to receive NALUs.
            // Connecting the NALU emitter to the track is deferred until the
            // DTLS handshake completes — RTCRtpSender.sendRtp() silently drops
            // all packets (including the critical first SPS/PPS keyframe) until
            // the transport state reaches 'connected'.
            if (msg.type === 'offer') {
              const udid = session.device?.platformDeviceId;
              const iosDeviceName = sessionManagerService.getIosDeviceName(sessionId);
              if (session.device?.platform === 'ios' && udid && iosDeviceName) {
                // Stop any existing JPEG capture.
                screenCaptureService.stopCapture(sessionId);

                // Start H.264 capture (process begins compiling/spawning in
                // the background while DTLS negotiation proceeds in parallel).
                const emitter = screenCaptureService.startCapture(
                  sessionId,
                  'ios',
                  udid,           // arg 3: deviceId = UDID ✓
                  undefined,      // arg 4: targetFps (use default)
                  iosDeviceName,  // arg 5: deviceName = "wms-session-XXXXXXXX" ✓
                  'h264',         // arg 6: captureFormat
                );

                // Defer connecting the NALU stream to the WebRTC video track
                // until DTLS transport is established — otherwise
                // RTCRtpSender.sendRtp() silently drops all packets (including
                // the critical first keyframe with SPS/PPS parameter sets).
                const attachCapture = (): void => {
                  log(`DTLS connected for session ${sessionId} — attaching H.264 capture`);
                  webRTCStreamService.connectCapture(sessionId, emitter);
                };

                if (pc.connectionState === 'connected') {
                  attachCapture();
                } else {
                  const sub = pc.connectionStateChange.subscribe((state: string) => {
                    if (state === 'connected') {
                      sub.unSubscribe();
                      attachCapture();
                    }
                  });
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
        void webRTCStreamService.stopSession(sessionId);
      });

      socket.on('error', (err: Error) => {
        warn(`WebRTC signaling WebSocket error for session ${sessionId}: ${err.message}`);
        void webRTCStreamService.stopSession(sessionId);
      });
    },
  );
};

export default wsWebRTCRoutes;
