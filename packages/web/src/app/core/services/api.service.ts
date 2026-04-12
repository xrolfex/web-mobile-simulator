import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  ApiResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeviceTypeListResponse,
  DownloadRuntimeRequest,
  Platform,
  RuntimeListResponse,
  Session,
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
   * Retrieve all active and recent sessions.
   * GET /api/sessions
   */
  getSessions() {
    return this.http.get<ApiResponse<Session[]>>(
      `${this.baseUrl}/api/sessions`,
    );
  }

  /**
   * Retrieve a single session by ID.
   * GET /api/sessions/:id
   * @param id The session UUID.
   */
  getSession(id: string) {
    return this.http.get<ApiResponse<Session>>(
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
