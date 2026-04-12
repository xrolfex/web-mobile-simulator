/**
 * Local type definitions mirroring @web-mobile-simulator/shared.
 *
 * These are defined here because the shared package is not currently linked
 * into the web package's node_modules. They must be kept in sync with
 * packages/shared/src/types.ts.
 */

// ── Platform & Status Unions ──────────────────────────────────────────────────

/** Target mobile platform. */
export type Platform = 'ios' | 'android';

/** Lifecycle state of a simulator/emulator device. */
export type DeviceState =
  | 'shutdown'
  | 'booting'
  | 'booted'
  | 'shutting_down'
  | 'error';

/** Lifecycle status of a streaming session. */
export type SessionStatus =
  | 'creating'
  | 'active'
  | 'terminating'
  | 'terminated'
  | 'error';

/** Installation status of a simulator runtime. */
export type RuntimeStatus =
  | 'available'
  | 'downloading'
  | 'installed'
  | 'error';

// ── Device & Runtime Shapes ───────────────────────────────────────────────────

/** A specific device model (e.g. "iPhone 15 Pro"). */
export interface DeviceType {
  id: string;
  name: string;
  platform: Platform;
  /** e.g. "iPhone 15 Pro", "Pixel 8" */
  modelName: string;
  /** e.g. "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro" */
  modelIdentifier: string;
}

/** A simulator/emulator runtime (OS version). */
export interface Runtime {
  id: string;
  platform: Platform;
  /** e.g. "iOS 17.5", "Android 14 (API 34)" */
  version: string;
  /** Platform-specific runtime identifier. */
  identifier: string;
  status: RuntimeStatus;
  /** Size in bytes, if known. */
  sizeBytes?: number;
}

/** A concrete simulator/emulator device instance. */
export interface SimulatorDevice {
  id: string;
  /** Platform-specific device ID (UDID for iOS, AVD name for Android). */
  platformDeviceId: string;
  platform: Platform;
  deviceType: DeviceType;
  runtime: Runtime;
  state: DeviceState;
}

// ── Session Shapes ────────────────────────────────────────────────────────────

/** An active or recently-terminated streaming session. */
export interface Session {
  id: string;
  device: SimulatorDevice;
  status: SessionStatus;
  /** WebSocket URL for the display stream (e.g. /ws/stream/<sessionId>). */
  streamUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/** Request body for creating a new session. */
export interface CreateSessionRequest {
  platform: Platform;
  runtimeId: string;
  deviceTypeId: string;
}

/** Response body from the create-session endpoint. */
export interface CreateSessionResponse {
  session: Session;
}

/** Capacity information returned alongside session lists. */
export interface SessionCapacityInfo {
  /** Number of currently active (creating + active) sessions. */
  activeSessions: number;
  /** Configured maximum concurrent sessions (0 = unlimited). */
  maxConcurrentSessions: number;
  /** Per-platform active counts and limits. */
  perPlatform: Record<string, { active: number; max: number }>;
}

// ── App Upload/Install Types ──────────────────────────────────────────────────

/** Supported app file extensions by platform. */
export type AppFileExtension = '.app' | '.ipa' | '.apk';

/** Result of uploading and installing an app on a simulator/emulator. */
export interface AppInstallResult {
  /** Whether the installation succeeded. */
  success: boolean;
  /** Original filename of the uploaded app. */
  fileName: string;
  /** Platform the app was installed on. */
  platform: Platform;
  /** Human-readable status message. */
  message: string;
  /** Time taken for the install in milliseconds. */
  installDurationMs?: number;
}

/** Response body from the upload-app endpoint. */
export interface AppUploadResponse {
  result: AppInstallResult;
}

// ── Device Control Types ──────────────────────────────────────────────────────

/** Hardware buttons that can be pressed via simctl. */
export type SimulatorButton = 'home' | 'lock' | 'volumeUp' | 'volumeDown';

/** Device orientation options. */
export type DeviceOrientation =
  | 'portrait'
  | 'landscapeLeft'
  | 'landscapeRight'
  | 'portraitUpsideDown';

/** Request body for the press-button endpoint. */
export interface PressButtonRequest {
  button: SimulatorButton;
}

/** Request body for the set-orientation endpoint. */
export interface SetOrientationRequest {
  orientation: DeviceOrientation;
}

/** Request body for the set-clipboard endpoint. */
export interface SetClipboardRequest {
  /** The text to place on the device clipboard. */
  text: string;
}

/** Response from the get-clipboard endpoint. */
export interface GetClipboardResponse {
  /** The current clipboard text on the device (may be empty). */
  text: string;
}

/** Request body for the open-url endpoint. */
export interface OpenUrlRequest {
  /** The URL or deep-link to open on the device. */
  url: string;
}

/** Request body for the send-text endpoint. */
export interface SendTextRequest {
  /** The text string to type into the currently focused field. */
  text: string;
}

// ── List Response Shapes ──────────────────────────────────────────────────────

/** Response shape from GET /api/sessions */
export interface SessionListResponse {
  sessions: Session[];
  capacity: SessionCapacityInfo;
}

/** Response body from the runtimes list endpoint. */
export interface RuntimeListResponse {
  runtimes: Runtime[];
}

/** Response body from the device-types list endpoint. */
export interface DeviceTypeListResponse {
  deviceTypes: DeviceType[];
}

/** Request body for triggering a runtime download. */
export interface DownloadRuntimeRequest {
  /** Target platform for the runtime. */
  platform: Platform;
  /** Platform-specific runtime identifier (e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5"). */
  identifier: string;
}

// ── API Response Wrapper ──────────────────────────────────────────────────────

/** Standard envelope wrapping all backend responses. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ── WebSocket Message Types ───────────────────────────────────────────────────

/** Discriminator for WebSocket message routing. */
export type WebSocketMessageType =
  | 'connected'
  | 'session_status_changed'
  | 'runtime_download_progress'
  | 'device_state_changed'
  | 'error';

/** Typed envelope for all WebSocket messages from the server. */
export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  payload: T;
  timestamp: string;
}

/** Payload for session_status_changed events. */
export interface SessionStatusChangedPayload {
  sessionId: string;
  status: SessionStatus;
  previousStatus: SessionStatus;
  device?: {
    platform: Platform;
    deviceType: string;
  };
}

/** Payload for runtime_download_progress events. */
export interface RuntimeDownloadProgressPayload {
  platform: Platform;
  identifier: string;
  progress: number;
  status: 'downloading' | 'installing' | 'completed' | 'error';
  message?: string;
}
