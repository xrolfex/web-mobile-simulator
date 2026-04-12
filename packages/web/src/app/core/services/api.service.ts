import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  ApiResponse,
  AppUploadResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeviceOrientation,
  DeviceTypeListResponse,
  DownloadRuntimeRequest,
  GetClipboardResponse,
  Platform,
  RuntimeListResponse,
  Session,
  SessionListResponse,
  SimulatorButton,
} from '../types/api.types';

/**
 * Core HTTP API service for communicating with the backend.
 * Provides typed request methods for all backend endpoints.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  /**
   * Check backend health status.
   * GET /api/health
   */
  getHealth() {
    return this.http.get<{ status: string }>(`${this.baseUrl}/api/health`);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Retrieve all active and recent sessions, including capacity info.
   * GET /api/sessions
   */
  getSessions() {
    return this.http.get<ApiResponse<SessionListResponse>>(
      `${this.baseUrl}/api/sessions`,
    );
  }

  /**
   * Retrieve a single session by ID.
   * GET /api/sessions/:id
   * @param id The session UUID.
   */
  getSession(id: string) {
    return this.http.get<ApiResponse<{ session: Session }>>(
      `${this.baseUrl}/api/sessions/${id}`,
    );
  }

  /**
   * Create a new simulator session.
   * POST /api/sessions
   * @param request Platform, runtime, and device-type identifiers.
   */
  createSession(request: CreateSessionRequest) {
    return this.http.post<ApiResponse<CreateSessionResponse>>(
      `${this.baseUrl}/api/sessions`,
      request,
    );
  }

  /**
   * Terminate and delete a session.
   * DELETE /api/sessions/:id
   * @param id The session UUID.
   */
  deleteSession(id: string) {
    return this.http.delete<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${id}`,
    );
  }

  /**
   * Upload and install an app file onto a running session's simulator/emulator.
   * POST /api/sessions/:id/apps
   * @param sessionId The session UUID.
   * @param file The app file (.app/.ipa/.apk) to upload and install.
   */
  uploadApp(sessionId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<ApiResponse<AppUploadResponse>>(
      `${this.baseUrl}/api/sessions/${sessionId}/apps`,
      formData,
      // Note: Do NOT set Content-Type header — Angular/browser sets it
      // automatically with the correct multipart boundary
    );
  }

  // ── Device Control ────────────────────────────────────────────────────────

  /**
   * Press a hardware button on the session's simulator.
   * POST /api/sessions/:id/control/button
   * @param sessionId The session UUID.
   * @param button    The button to press.
   */
  pressButton(sessionId: string, button: SimulatorButton) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/button`,
      { button },
    );
  }

  /**
   * Set the device orientation.
   * POST /api/sessions/:id/control/rotate
   * @param sessionId   The session UUID.
   * @param orientation The target orientation.
   */
  setOrientation(sessionId: string, orientation: DeviceOrientation) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/rotate`,
      { orientation },
    );
  }

  /**
   * Trigger a shake gesture on the device.
   * POST /api/sessions/:id/control/shake
   * @param sessionId The session UUID.
   */
  shakeDevice(sessionId: string) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/shake`,
      {},
    );
  }

  /**
   * Take a screenshot and return it as a Blob.
   * GET /api/sessions/:id/control/screenshot
   * @param sessionId The session UUID.
   */
  takeScreenshot(sessionId: string) {
    return this.http.get(
      `${this.baseUrl}/api/sessions/${sessionId}/control/screenshot`,
      { responseType: 'blob' },
    );
  }

  /**
   * Set clipboard text on the device.
   * POST /api/sessions/:id/control/clipboard
   * @param sessionId The session UUID.
   * @param text      The text to place on the clipboard.
   */
  setClipboard(sessionId: string, text: string) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/clipboard`,
      { text },
    );
  }

  /**
   * Get clipboard text from the device.
   * GET /api/sessions/:id/control/clipboard
   * @param sessionId The session UUID.
   */
  getClipboard(sessionId: string) {
    return this.http.get<ApiResponse<GetClipboardResponse>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/clipboard`,
    );
  }

  /**
   * Open a URL or deep-link on the device.
   * POST /api/sessions/:id/control/open-url
   * @param sessionId The session UUID.
   * @param url       The URL to open.
   */
  openUrl(sessionId: string, url: string) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/open-url`,
      { url },
    );
  }

  /**
   * Type text into the currently focused field on the device.
   * POST /api/sessions/:id/control/send-text
   * @param sessionId The session UUID.
   * @param text      The text to type.
   */
  sendText(sessionId: string, text: string) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/sessions/${sessionId}/control/send-text`,
      { text },
    );
  }

  // ── Devices ───────────────────────────────────────────────────────────────

  /**
   * Retrieve available device types, optionally filtered by platform.
   * GET /api/devices or GET /api/devices/:platform
   * @param platform Optional platform filter ('ios' | 'android').
   */
  getDevices(platform?: Platform) {
    const url = platform
      ? `${this.baseUrl}/api/devices/${platform}`
      : `${this.baseUrl}/api/devices`;
    return this.http.get<ApiResponse<DeviceTypeListResponse>>(url);
  }

  // ── Runtimes ──────────────────────────────────────────────────────────────

  /**
   * Retrieve available runtimes, optionally filtered by platform.
   * GET /api/runtimes or GET /api/runtimes/:platform
   * @param platform Optional platform filter ('ios' | 'android').
   */
  getRuntimes(platform?: Platform) {
    const url = platform
      ? `${this.baseUrl}/api/runtimes/${platform}`
      : `${this.baseUrl}/api/runtimes`;
    return this.http.get<ApiResponse<RuntimeListResponse>>(url);
  }

  /**
   * Trigger a runtime download by identifier.
   * POST /api/runtimes/download
   * @param request The runtime identifier to download.
   */
  downloadRuntime(request: DownloadRuntimeRequest) {
    return this.http.post<ApiResponse<void>>(
      `${this.baseUrl}/api/runtimes/download`,
      request,
    );
  }
}
