import type { FastifyPluginAsync } from 'fastify';

/**
 * Health check route plugin.
 * Registers GET /api/health — returns server status, uptime, and timestamp.
 */
const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
    };
  });
};

export default healthRoutes;
