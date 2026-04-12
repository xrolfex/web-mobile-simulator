import type { FastifyInstance } from 'fastify';
import healthRoutes from './health.js';
import sessionRoutes from './sessions.js';
import deviceRoutes from './devices.js';
import runtimeRoutes from './runtimes.js';
import wsEventsRoutes from './ws-events.js';

/**
 * Registers all API route plugins on the provided Fastify instance.
 *
 * @param fastify - The Fastify server instance to register routes on.
 */
export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(healthRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(deviceRoutes);
  await fastify.register(runtimeRoutes);
  await fastify.register(wsEventsRoutes);
}
