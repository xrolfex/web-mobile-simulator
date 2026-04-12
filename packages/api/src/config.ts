import dotenv from 'dotenv';
import {
  DEFAULT_API_PORT,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_MAX_SESSIONS_PER_PLATFORM,
  DEFAULT_SESSION_MEMORY_EVICTION_MS,
} from '@web-mobile-simulator/shared';

dotenv.config();

/** Parsed, validated configuration derived from environment variables. */
export const config = {
  port: parseInt(process.env.API_PORT || String(DEFAULT_API_PORT), 10),
  host: process.env.API_HOST || '0.0.0.0',
  xcodePath: process.env.XCODE_PATH || '/Applications/Xcode.app',
  androidSdkRoot:
    process.env.ANDROID_SDK_ROOT || `${process.env.HOME}/Library/Android/sdk`,
  databaseUrl: process.env.DATABASE_URL || 'file:./data/simulator.db',
  vncProxyPortRange: {
    start: parseInt(process.env.VNC_PROXY_PORT_RANGE_START || '6900', 10),
    end: parseInt(process.env.VNC_PROXY_PORT_RANGE_END || '6999', 10),
  },

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
} as const;
