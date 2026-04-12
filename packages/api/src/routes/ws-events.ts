import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { WS_ROUTES } from '@web-mobile-simulator/shared';
import { eventBusService, type AnyEventHandler } from '../services/event-bus.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WsEventsRoute]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

/** Return an ISO-8601 timestamp for the current moment. */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * WebSocket event-stream route plugin.
 *
 * Registers `GET /ws/events` as a WebSocket endpoint.  When a browser
 * connects:
 * 1. The client is added to the tracked `Set<WebSocket>`.
 * 2. A welcome message is sent immediately.
 * 3. An `onAny` handler is registered on the {@link eventBusService}; every
 *    event published by any service is serialised to JSON and forwarded to the
 *    client.
 * 4. On disconnect or error the subscription is cleaned up and the client is
 *    removed from the tracking set.
 */
const wsEventsRoutes: FastifyPluginAsync = async (fastify) => {
  /** All currently connected WebSocket clients. */
  const clients = new Set<WebSocket>();

  // @fastify/websocket v11 + Fastify 5: handler receives (socket, request)
  // where `socket` is the raw `ws` WebSocket instance.
  fastify.get(
    WS_ROUTES.EVENTS,
    { websocket: true },
    (socket: WebSocket) => {
      clients.add(socket);
      log(`Client connected (total: ${clients.size})`);

      // --- Welcome message ---------------------------------------------------
      const welcome = JSON.stringify({
        type: 'connected',
        payload: { message: 'Connected to event stream' },
        timestamp: now(),
      });

      try {
        socket.send(welcome);
      } catch (err: unknown) {
        warn(`Failed to send welcome message: ${String(err)}`);
      }

      // --- Subscribe to all bus events and forward to this client ------------
      const busHandler: AnyEventHandler = (message) => {
        if (socket.readyState !== socket.OPEN) return;

        try {
          socket.send(JSON.stringify(message));
        } catch (err: unknown) {
          warn(`Failed to send event to client: ${String(err)}`);
        }
      };

      eventBusService.onAny(busHandler);

      // --- Cleanup on disconnect or error ------------------------------------
      function cleanup(): void {
        eventBusService.offAny(busHandler);
        clients.delete(socket);
        log(`Client disconnected (remaining: ${clients.size})`);
      }

      socket.on('close', cleanup);

      socket.on('error', (err: Error) => {
        warn(`Client socket error: ${err.message}`);
        cleanup();
      });
    },
  );
};

export default wsEventsRoutes;
