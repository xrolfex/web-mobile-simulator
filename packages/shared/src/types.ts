// === Device & Platform Types ===

export type Platform = 'ios' | 'android';

export type DeviceState = 'shutdown' | 'booting' | 'booted' | 'shutting_down' | 'error';

export type SessionStatus = 'creating' | 'active' | 'terminating' | 'terminated' | 'error';

export type RuntimeStatus = 'available' | 'downloading' | 'installed' | 'error';

export interface DeviceType {
  id: string;
  name: string;
  platform: Platform;
  /** e.g., "iPhone 15 Pro", "Pixel 8" */
  modelName: string;
  /** e.g., "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro" */
  modelIdentifier: string;
}

export interface Runtime {
  id: string;
  platform: Platform;
  /** e.g., "iOS 17.5", "Android 14 (API 34)" */
  version: string;
  /** Platform-specific identifier */
  identifier: string;
  status: RuntimeStatus;
  /** Size in bytes, if known */
  sizeBytes?: number;
}

export interface SimulatorDevice {
  id: string;
  /** Platform-specific device ID (UDID for iOS, AVD name for Android) */
  platformDeviceId: string;
  platform: Platform;
  deviceType: DeviceType;
  runtime: Runtime;
  state: DeviceState;
}

// === Session Types ===

export interface Session {
  id: string;
  device: SimulatorDevice;
  status: SessionStatus;
  /** WebSocket URL for VNC/display connection */
  streamUrl?: string;
  /** Port the VNC proxy is running on */
  proxyPort?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionRequest {
  platform: Platform;
  runtimeId: string;
  deviceTypeId: string;
}

export interface CreateSessionResponse {
  session: Session;
}

// === Runtime Management Types ===

export interface RuntimeListResponse {
  runtimes: Runtime[];
}

export interface RuntimeDownloadRequest {
  platform: Platform;
  identifier: string;
}

export interface RuntimeDownloadProgress {
  platform: Platform;
  identifier: string;
  /** Progress percentage 0-100 */
  progress: number;
  status: 'downloading' | 'installing' | 'completed' | 'error';
  message?: string;
}

// === Device Type Types ===

export interface DeviceTypeListResponse {
  deviceTypes: DeviceType[];
}

// === API Response Wrapper ===

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// === WebSocket Message Types ===

export type WebSocketMessageType =
  | 'session_status_changed'
  | 'runtime_download_progress'
  | 'device_state_changed'
  | 'error';

export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  payload: T;
  timestamp: string;
}
