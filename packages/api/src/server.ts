import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { registerRoutes } from './routes/index.js';
import { sessionManagerService, vncProxyService } from './services/index.js';

/**
 * Builds and configures the Fastify application instance.
 * Registers CORS, WebSocket support, and all route plugins.
 *
 * @returns A fully configured, ready-to-listen Fastify instance.
 */
async function buildServer() {
  const fastify = Fastify({
    logger: true,
  });

  // --- Plugins ---
  await fastify.register(cors, {
    origin: true, // reflect request origin; tighten per-environment as needed
  });

  await fastify.register(websocket);

  // --- Routes ---
  await registerRoutes(fastify);

  return fastify;
}

/**
 * Starts the HTTP server and sets up graceful shutdown handlers for
 * SIGTERM and SIGINT signals.
 */
async function start(): Promise<void> {
  const fastify = await buildServer();

  /** Gracefully close the server, flushing in-flight requests. */
  async function shutdown(signal: string): Promise<void> {
    fastify.log.info(`Received ${signal} — shutting down gracefully…`);
    try {
      // Terminate all active simulator sessions and stop VNC proxies before
      // closing the HTTP server so resources are released cleanly.
      await sessionManagerService.cleanup();
      await vncProxyService.cleanup();
      await fastify.close();
      fastify.log.info('Server closed. Goodbye.');
      process.exit(0);
    } catch (err) {
      fastify.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    const address = await fastify.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`🚀  API server listening at ${address}`);
  } catch (err) {
    fastify.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

await start();
