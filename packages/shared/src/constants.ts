export const DEFAULT_API_PORT = 3000;
export const DEFAULT_VNC_PROXY_PORT_RANGE = {
  start: 6900,
  end: 6999,
} as const;

export const API_ROUTES = {
  SESSIONS: '/api/sessions',
  DEVICES: '/api/devices',
  RUNTIMES: '/api/runtimes',
  HEALTH: '/api/health',
} as const;

export const WS_ROUTES = {
  EVENTS: '/ws/events',
  VNC_PROXY: '/ws/vnc',
} as const;

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEVICE_BOOT_TIMEOUT_MS = 120 * 1000; // 2 minutes

/** Maximum app upload size in bytes (2 GB). */
export const MAX_APP_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Allowed file extensions per platform. */
export const ALLOWED_APP_EXTENSIONS: Record<'ios' | 'android', string[]> = {
  ios: ['.app', '.ipa'],
  android: ['.apk'],
} as const;
