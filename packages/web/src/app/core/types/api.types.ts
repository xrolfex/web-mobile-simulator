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
  /** WebSocket URL for the VNC/display connection. */
  streamUrl?: string;
  /** Port the VNC proxy is running on. */
  proxyPort?: number;
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

// ── List Response Shapes ──────────────────────────────────────────────────────

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
