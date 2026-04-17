import dotenv from 'dotenv';
import { homedir } from 'node:os';
import {
  DEFAULT_API_PORT,
  DEFAULT_IOS_WARM_POOL_SIZE,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_MAX_SESSIONS_PER_PLATFORM,
  DEFAULT_SESSION_MEMORY_EVICTION_MS,
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  type NodeMode,
} from '@web-mobile-simulator/shared';

dotenv.config();

/** Parsed, validated configuration derived from environment variables. */
export const config = {
  port: parseInt(process.env.API_PORT || String(DEFAULT_API_PORT), 10),
  host: process.env.API_HOST || '0.0.0.0',
  xcodePath: process.env.XCODE_PATH || '/Applications/Xcode.app',
  androidSdkRoot:
    process.env.ANDROID_SDK_ROOT || `${homedir()}/Library/Android/sdk`,
  databaseUrl: process.env.DATABASE_URL || 'file:./data/simulator.db',

  // --- Session concurrency ---

  /**
   * Maximum number of concurrent active sessions across all platforms.
   * 0 = unlimited.  Env: `MAX_CONCURRENT_SESSIONS`.
   */
  maxConcurrentSessions: parseInt(
    process.env.MAX_CONCURRENT_SESSIONS || String(DEFAULT_MAX_CONCURRENT_SESSIONS),
    10,
  ),

  /**
   * Maximum number of concurrent active sessions per individual platform
   * (iOS or Android).  0 = unlimited (only the global cap applies).
   * Env: `MAX_SESSIONS_PER_PLATFORM`.
   */
  maxSessionsPerPlatform: parseInt(
    process.env.MAX_SESSIONS_PER_PLATFORM || String(DEFAULT_MAX_SESSIONS_PER_PLATFORM),
    10,
  ),

  /**
   * How long (in ms) terminated/error sessions are kept in the in-memory Map
   * before eviction.  The database retains them permanently regardless.
   * Env: `SESSION_MEMORY_EVICTION_MS`.
   */
  sessionMemoryEvictionMs: parseInt(
    process.env.SESSION_MEMORY_EVICTION_MS || String(DEFAULT_SESSION_MEMORY_EVICTION_MS),
    10,
  ),

  /**
   * Maximum number of warm (booted but idle) iOS Simulators kept in the
   * in-memory pool per (deviceTypeId, runtimeId) combination.
   * 0 = pool disabled (always teardown on session end).
   * Env: `IOS_WARM_POOL_SIZE`.
   */
  iosWarmPoolSize: parseInt(
    process.env.IOS_WARM_POOL_SIZE || String(DEFAULT_IOS_WARM_POOL_SIZE),
    10,
  ),

  // --- Distributed mode ---

  /**
   * Operating mode for this API server instance.
   *
   * - `'standalone'` (default) — single-machine; runs simulators locally.
   * - `'master'`               — orchestration node; routes requests to workers.
   * - `'worker'`               — simulation node; registers with master, runs simulators.
   *
   * Env: `NODE_MODE`.
   */
  nodeMode: (process.env.NODE_MODE || 'standalone') as NodeMode,

  /**
   * Base URL of the master node, used by workers to register and send
   * heartbeats.  Required when `nodeMode === 'worker'`.
   * e.g. `"http://10.0.1.1:3000"`
   * Env: `MASTER_URL`.
   */
  masterUrl: process.env.MASTER_URL || '',

  /**
   * Shared secret used to authenticate worker-to-master communication.
   * Must be set identically on both master and all worker nodes.
   * Env: `WORKER_SECRET`.
   */
  workerSecret: process.env.WORKER_SECRET || '',

  /**
   * Publicly reachable base URL of this worker node, advertised to the master
   * at registration time so the master can proxy requests back to this worker.
   * Required when `nodeMode === 'worker'`.
   * e.g. `"http://192.168.1.10:3000"`
   * Env: `WORKER_PUBLIC_URL`.
   */
  workerPublicUrl: process.env.WORKER_PUBLIC_URL || '',

  /**
   * Maximum number of concurrent iOS simulator sessions this worker accepts.
   * Only used when `nodeMode === 'worker'`.
   * Env: `WORKER_MAX_IOS_SESSIONS`.
   */
  workerMaxIosSessions: parseInt(
    process.env.WORKER_MAX_IOS_SESSIONS || '3',
    10,
  ),

  /**
   * Maximum number of concurrent Android emulator sessions this worker accepts.
   * Only used when `nodeMode === 'worker'`.
   * Env: `WORKER_MAX_ANDROID_SESSIONS`.
   */
  workerMaxAndroidSessions: parseInt(
    process.env.WORKER_MAX_ANDROID_SESSIONS || '2',
    10,
  ),

  /**
   * Interval in milliseconds at which this worker sends heartbeats to the master.
   * Only used when `nodeMode === 'worker'`.
   * Env: `WORKER_HEARTBEAT_INTERVAL_MS`.
   */
  workerHeartbeatIntervalMs: parseInt(
    process.env.WORKER_HEARTBEAT_INTERVAL_MS ||
      String(DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS),
    10,
  ),
} as const;
