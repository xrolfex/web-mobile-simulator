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
 * 4. Any existing JPEG capture for the session is stopped and a new H.264
 *    capture is started; the resulting NALU stream is connected to the
 *    WebRTC video track.
 * 5. Signaling messages (SDP offer, ICE candidates) from the browser are
 *    forwarded to {@link webRTCStreamService.handleSignaling} and responses
 *    are sent back.
 * 6. On WebSocket close or error the WebRTC session is torn down.
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

      // 4. Start H.264 capture and connect it to the WebRTC session.
      // If there is already a JPEG capture running for this session, stop it
      // first, then start a new one in H.264 mode.
      const deviceName = session.device?.platformDeviceId;
      if (session.device?.platform === 'ios' && deviceName) {
        // Stop any existing JPEG capture.
        screenCaptureService.stopCapture(sessionId);

        // Start H.264 capture.
        const emitter = screenCaptureService.startCapture(
          sessionId,
          'ios',
          deviceName,
          undefined,
          undefined,
          'h264',
        );

        // Connect the capture NALU stream to the WebRTC video track.
        webRTCStreamService.connectCapture(sessionId, emitter);
      }

      // 5. Handle signaling messages from the browser.
      socket.on('message', (data: Buffer) => {
        void (async () => {
          try {
            const msg = JSON.parse(data.toString()) as SignalingMessage;
            const response = await webRTCStreamService.handleSignaling(sessionId, msg);

            if (response && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(response));
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

      // 6. Clean up on close.
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
