export const DEFAULT_API_PORT = 3000;

export const WS_ROUTES = {
  EVENTS: '/ws/events',
} as const;

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEVICE_BOOT_TIMEOUT_MS = 120 * 1000; // 2 minutes

/**
 * Default maximum number of concurrent active sessions (across all platforms).
 * 0 = unlimited.
 */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 6;

/**
 * Default maximum number of concurrent active sessions per platform.
 * 0 = unlimited (falls back to the global cap only).
 */
export const DEFAULT_MAX_SESSIONS_PER_PLATFORM = 0;

/**
 * How long (in ms) to keep terminated/error sessions in the in-memory Map
 * before evicting them.  The database retains them permanently.
 * Default: 15 minutes.
 */
export const DEFAULT_SESSION_MEMORY_EVICTION_MS = 15 * 60 * 1000;

/**
 * Naming prefixes used for dynamically created simulator/emulator devices.
 * Used during orphan cleanup to identify stale devices left behind by crashes.
 */
export const WMS_IOS_DEVICE_NAME_PREFIX = 'wms-session-';
export const WMS_ANDROID_AVD_NAME_PREFIX = 'wms_session_';

/** Maximum app upload size in bytes (2 GB). */
export const MAX_APP_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Allowed file extensions per platform. */
export const ALLOWED_APP_EXTENSIONS: Record<'ios' | 'android', string[]> = {
  ios: ['.app', '.ipa'],
  android: ['.apk'],
} as const;

/**
 * Default maximum number of warm (booted but idle) iOS Simulators kept in the
 * in-memory pool between sessions.  0 = pool disabled (always teardown).
 * Per (deviceTypeId, runtimeId) combination.
 * Env: `IOS_WARM_POOL_SIZE`.
 */
export const DEFAULT_IOS_WARM_POOL_SIZE = 0;

// === Distributed Master/Worker Constants ===

/**
 * Default interval (ms) at which a worker sends a heartbeat to the master.
 * Env: `WORKER_HEARTBEAT_INTERVAL_MS` (worker-side).
 */
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Time (ms) after the last heartbeat before the master marks a worker as
 * unhealthy.  Set to 3× the heartbeat interval to allow for two missed beats
 * before declaring a worker offline.
 */
export const WORKER_OFFLINE_THRESHOLD_MS = 90_000; // 90 seconds
