import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { createConnection } from 'node:net';
import { vncProxyService } from '../services/index.js';

// ---------------------------------------------------------------------------
// Module-level helpers (mirrors ws-events.ts style)
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WsVncRoute]';

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
 * VNC WebSocket bridge route plugin.
 *
 * Registers `GET /ws/vnc/:sessionId` as a WebSocket endpoint.  When a browser
 * connects, the route:
 * 1. Looks up the VNC TCP target for the given session via
 *    {@link vncProxyService.getProxyTarget}.
 * 2. Opens a raw TCP connection to the VNC server.
 * 3. Bridges data bidirectionally between the browser WebSocket and the TCP
 *    socket (WebSocket ↔ VNC server), mirroring the logic in
 *    `VNCProxyService.handleBrowserConnection`.
 * 4. Tears down both sides cleanly on any close or error.
 *
 * nginx already proxies `/ws/*` to the API, so this route is reachable from
 * the browser through the standard nginx port without any extra port exposure.
 */
const wsVncRoutes: FastifyPluginAsync = async (fastify) => {
  // @fastify/websocket v11 + Fastify 5: handler receives (socket, request)
  // where `socket` is the raw `ws` WebSocket instance.
  fastify.get(
    '/ws/vnc/:sessionId',
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };

      log(`VNC WebSocket connection for session ${sessionId}`);

      // Look up the VNC TCP target for this session.
      const target = vncProxyService.getProxyTarget(sessionId);
      if (!target) {
        warn(`No VNC proxy found for session ${sessionId}`);
        socket.close(1008, 'No VNC proxy found for this session');
        return;
      }

      // Open a TCP connection to the VNC server.
      const tcp = createConnection({ host: target.host, port: target.port }, () => {
        log(`TCP connected to ${target.host}:${target.port} for session ${sessionId}`);
      });

      // ---- WebSocket → TCP (browser → VNC server) --------------------------
      socket.on('message', (data: Buffer) => {
        if (tcp.writable) {
          tcp.write(data);
        }
      });

      // ---- TCP → WebSocket (VNC server → browser) --------------------------
      tcp.on('data', (data: Buffer) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(data);
        }
      });

      // ---- WebSocket close / error ------------------------------------------
      socket.on('close', () => {
        log(`VNC WebSocket closed for session ${sessionId}`);
        tcp.destroy();
      });

      socket.on('error', (err: Error) => {
        warn(`VNC WebSocket error for session ${sessionId}: ${err.message}`);
        tcp.destroy();
      });

      // ---- TCP close / error -----------------------------------------------
      tcp.on('close', () => {
        log(`VNC TCP closed for session ${sessionId}`);
        if (socket.readyState === socket.OPEN) {
          socket.close();
        }
      });

      tcp.on('error', (err: Error) => {
        warn(`VNC TCP error for session ${sessionId}: ${err.message}`);
        if (socket.readyState === socket.OPEN) {
          socket.close(1011, 'VNC server connection failed');
        }
      });
    },
  );
};

export default wsVncRoutes;
