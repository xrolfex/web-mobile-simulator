import type { FastifyPluginAsync } from 'fastify';
import {
  screenCaptureService,
  sessionManagerService,
} from '../services/index.js';
import type { NaluFrame } from '../services/screen-capture.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[DebugStreamRoute]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Debug H.264 stream route plugin.
 *
 * Registers `GET /api/debug/h264-stream/:sessionId` as an HTTP endpoint that
 * streams raw Annex B H.264 data to the client.  Useful for validating the
 * capture pipeline independently of WebRTC — the stream can be saved to a
 * `.h264` file and played in VLC:
 *
 * ```sh
 * curl http://localhost:3000/api/debug/h264-stream/<sessionId> > capture.h264
 * vlc capture.h264
 * ```
 *
 * Requirements:
 * 1. The session must exist and be `'active'`.
 * 2. An H.264 capture must already be running for the session (started via
 *    the WebRTC signaling flow in `ws-webrtc.ts`).
 */
const debugStreamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/debug/h264-stream/:sessionId', (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    // 1. Validate session exists and is active.
    const session = sessionManagerService.getSession(sessionId);
    if (!session || session.status !== 'active') {
      void reply.code(404).send({ error: 'Session not found or not active' });
      return;
    }

    // 2. Check for an active capture emitter.
    const emitter = screenCaptureService.getEmitter(sessionId);
    if (!emitter) {
      void reply.code(404).send({ error: 'No active capture for this session. Start a WebRTC connection first.' });
      return;
    }

    log(`Starting H.264 debug stream for session ${sessionId}`);

    // 3. Hijack the response so Fastify does not interfere with the raw stream.
    void reply.hijack();

    // Write the 200 status line and headers for a raw chunked byte stream.
    reply.raw.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="capture-${sessionId}.h264"`,
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 4. Forward each NALU directly to the response stream.
    const onNalu = (frame: NaluFrame): void => {
      try {
        reply.raw.write(frame.naluData);
      } catch {
        // Client disconnected — cleanup handled by the 'close' listener below.
      }
    };

    const onError = (): void => {
      cleanup();
      try { reply.raw.end(); } catch { /* already ended */ }
    };

    const cleanup = (): void => {
      emitter.off('nalu', onNalu);
      emitter.off('error', onError);
    };

    emitter.on('nalu', onNalu);
    emitter.on('error', onError);

    // 5. Clean up when the client disconnects.
    request.raw.on('close', () => {
      log(`H.264 debug stream client disconnected for session ${sessionId}`);
      cleanup();
      try { reply.raw.end(); } catch { /* already ended */ }
    });
  });
};

export default debugStreamRoutes;
