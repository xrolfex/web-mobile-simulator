import type { FastifyInstance } from 'fastify';
import type { NodeMode } from '@web-mobile-simulator/shared';
import healthRoutes from './health.js';
import sessionRoutes from './sessions.js';
import deviceRoutes from './devices.js';
import runtimeRoutes from './runtimes.js';
import wsEventsRoutes from './ws-events.js';
import wsStreamRoutes from './ws-stream.js';
import appRoutes from './apps.js';
import deviceControlRoutes from './device-control.js';
import adminRoutes from './admin.js';
import appLibraryRoutes from './app-library.js';
import internalRoutes from './internal.js';
import masterSessionsRoutes from './master-sessions.js';
import masterProxyRoutes from './master-proxy.js';

/**
 * Registers API route plugins on the provided Fastify instance.
 *
 * @param fastify - The Fastify server instance to register routes on.
 * @param mode - The node operating mode. In `'master'` mode only the master
 *   route subset is registered; in `'standalone'` or `'worker'` mode all
 *   standard routes are registered.
 */
export async function registerRoutes(fastify: FastifyInstance, mode: NodeMode = 'standalone'): Promise<void> {
  if (mode === 'master') {
    await fastify.register(healthRoutes);
    await fastify.register(wsEventsRoutes);
    await fastify.register(internalRoutes);
    await fastify.register(masterSessionsRoutes);
    await fastify.register(masterProxyRoutes);
  } else {
    await fastify.register(healthRoutes);
    await fastify.register(sessionRoutes);
    await fastify.register(deviceRoutes);
    await fastify.register(runtimeRoutes);
    await fastify.register(wsEventsRoutes);
    await fastify.register(wsStreamRoutes);
    await fastify.register(appRoutes);
    await fastify.register(deviceControlRoutes);
    await fastify.register(adminRoutes);
    await fastify.register(appLibraryRoutes);
  }
}
