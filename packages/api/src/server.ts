import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { registerRoutes } from './routes/index.js';
import { sessionManagerService } from './services/index.js';
import { exec } from './utils/exec.js';

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

  await fastify.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB max
      files: 1, // Only one file per upload
    },
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

  // Clean up any orphan devices left by a prior crash.
  // This runs after DB init and session rehydration but before accepting requests.
  await sessionManagerService.cleanupOrphanDevices().catch((err) => {
    console.warn('[startup] Orphan device cleanup failed:', err);
  });

  // Verify iOS toolchain availability
  try {
    await exec('xcrun', ['--find', 'simctl'], {
      env: {
        ...process.env,
        DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
      },
    });
    console.log('[startup] ✅ xcrun simctl is available');
  } catch {
    console.warn(
      `[startup] ⚠️  xcrun simctl not found at XCODE_PATH="${config.xcodePath}". ` +
        'iOS simulator features will not work. ' +
        'Fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
    );
  }

  // Verify Android toolchain availability
  try {
    await exec(`${config.androidSdkRoot}/platform-tools/adb`, ['version']);
    console.log('[startup] ✅ adb is available');
  } catch {
    console.warn(
      `[startup] ⚠️  adb not found at ANDROID_SDK_ROOT="${config.androidSdkRoot}". ` +
        'Android emulator features will not work. ' +
        'Fix: Set ANDROID_SDK_ROOT in .env to your Android SDK path.',
    );
  }

  /** Gracefully close the server, flushing in-flight requests. */
  async function shutdown(signal: string): Promise<void> {
    fastify.log.info(`Received ${signal} — shutting down gracefully…`);
    try {
      // Terminate all active simulator sessions before closing the HTTP server
      // so resources are released cleanly.
      await sessionManagerService.cleanup();
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
