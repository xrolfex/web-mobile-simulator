/**
 * Unit tests for ApiService.
 *
 * Uses Angular's HttpTestingController to intercept HTTP requests and verify
 * that each service method makes the correct request and forwards the
 * response to the caller.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { ApiService } from './api.service';
import type {
  ApiResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeviceTypeListResponse,
  DownloadRuntimeRequest,
  RuntimeListResponse,
  Session,
} from '../types/api.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';

/** Minimal valid Session fixture. */
const mockSession: Session = {
  id: 'session-1',
  device: {
    id: 'device-1',
    platformDeviceId: 'UDID-abc',
    platform: 'ios',
    deviceType: {
      id: 'dt-1',
      name: 'iPhone 15',
      platform: 'ios',
      modelName: 'iPhone 15',
      modelIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
    },
    runtime: {
      id: 'rt-1',
      platform: 'ios',
      version: 'iOS 17.0',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
      status: 'installed',
    },
    state: 'booted',
  },
  status: 'active',
  createdAt: '2026-04-12T00:00:00.000Z',
  updatedAt: '2026-04-12T00:00:00.000Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ApiService', () => {
  let service: ApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    service = TestBed.inject(ApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Assert no outstanding HTTP requests were left pending.
    httpTesting.verify();
  });

  // ── Health ───────────────────────────────────────────────────────────────

  describe('getHealth()', () => {
    it('should make a GET request to /api/health', () => {
      // Arrange
      const mockResponse = { status: 'ok' };
      let result: { status: string } | undefined;

      // Act
      service.getHealth().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/health`);

      // Assert — method
      expect(req.request.method).toBe('GET');

      // Flush response and assert payload forwarded correctly
      req.flush(mockResponse);
      expect(result).toEqual(mockResponse);
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  describe('getSessions()', () => {
    it('should make a GET request to /api/sessions', () => {
      // Arrange
      const mockResponse: ApiResponse<Session[]> = {
        success: true,
        data: [mockSession],
      };
      let result: ApiResponse<Session[]> | undefined;

      // Act
      service.getSessions().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions`);

      // Assert
      expect(req.request.method).toBe('GET');
      req.flush(mockResponse);
      expect(result).toEqual(mockResponse);
    });

    it('should forward an empty data array when no sessions exist', () => {
      // Arrange
      const mockResponse: ApiResponse<Session[]> = {
        success: true,
        data: [],
      };
      let result: ApiResponse<Session[]> | undefined;

      // Act
      service.getSessions().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions`);
      req.flush(mockResponse);

      // Assert
      expect(result?.data).toEqual([]);
    });

    it('should forward an error response from the server', () => {
      // Arrange
      const errorResponse: ApiResponse<Session[]> = {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      };
      let result: ApiResponse<Session[]> | undefined;

      // Act
      service.getSessions().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions`);
      req.flush(errorResponse);

      // Assert
      expect(result?.success).toBe(false);
      expect(result?.error?.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('getSession(id)', () => {
    it('should make a GET request to /api/sessions/:id', () => {
      // Arrange
      const id = 'session-1';
      const mockResponse: ApiResponse<Session> = {
        success: true,
        data: mockSession,
      };
      let result: ApiResponse<Session> | undefined;

      // Act
      service.getSession(id).subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions/${id}`);

      // Assert
      expect(req.request.method).toBe('GET');
      req.flush(mockResponse);
      expect(result?.data?.id).toBe(id);
    });

    it('should encode the session id in the URL', () => {
      // Arrange
      const id = 'abc-123-xyz';

      // Act
      service.getSession(id).subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/sessions/${id}`);

      // Assert — the ID appears verbatim in the URL
      expect(req.request.url).toContain(id);
      req.flush({ success: true });
    });
  });

  describe('createSession(request)', () => {
    it('should make a POST request to /api/sessions with the correct body', () => {
      // Arrange
      const request: CreateSessionRequest = {
        platform: 'ios',
        runtimeId: 'rt-1',
        deviceTypeId: 'dt-1',
      };
      const mockResponse: ApiResponse<CreateSessionResponse> = {
        success: true,
        data: { session: mockSession },
      };
      let result: ApiResponse<CreateSessionResponse> | undefined;

      // Act
      service.createSession(request).subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions`);

      // Assert — method and body
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(request);

      req.flush(mockResponse);
      expect(result?.data?.session.id).toBe('session-1');
    });

    it('should POST with android platform body', () => {
      // Arrange
      const request: CreateSessionRequest = {
        platform: 'android',
        runtimeId: 'rt-android',
        deviceTypeId: 'dt-pixel',
      };

      // Act
      service.createSession(request).subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/sessions`);

      // Assert
      expect(req.request.body.platform).toBe('android');
      req.flush({ success: true });
    });
  });

  describe('deleteSession(id)', () => {
    it('should make a DELETE request to /api/sessions/:id', () => {
      // Arrange
      const id = 'session-to-delete';
      let result: ApiResponse<void> | undefined;

      // Act
      service.deleteSession(id).subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/sessions/${id}`);

      // Assert
      expect(req.request.method).toBe('DELETE');
      req.flush({ success: true });
      expect(result).toEqual({ success: true });
    });

    it('should include the session id in the DELETE URL', () => {
      // Arrange
      const id = 'unique-session-id';

      // Act
      service.deleteSession(id).subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/sessions/${id}`);

      // Assert
      expect(req.request.url).toContain(id);
      req.flush({ success: true });
    });
  });

  // ── Devices ──────────────────────────────────────────────────────────────

  describe('getDevices()', () => {
    it('should make a GET request to /api/devices when no platform is given', () => {
      // Arrange
      const mockResponse: ApiResponse<DeviceTypeListResponse> = {
        success: true,
        data: { deviceTypes: [] },
      };
      let result: ApiResponse<DeviceTypeListResponse> | undefined;

      // Act
      service.getDevices().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/devices`);

      // Assert
      expect(req.request.method).toBe('GET');
      req.flush(mockResponse);
      expect(result?.data?.deviceTypes).toEqual([]);
    });

    it('should make a GET request to /api/devices/ios when platform is ios', () => {
      // Arrange
      let result: ApiResponse<DeviceTypeListResponse> | undefined;

      // Act
      service.getDevices('ios').subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/devices/ios`);

      // Assert
      expect(req.request.method).toBe('GET');
      req.flush({ success: true, data: { deviceTypes: [] } });
      expect(result?.success).toBe(true);
    });

    it('should make a GET request to /api/devices/android when platform is android', () => {
      // Act
      service.getDevices('android').subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/devices/android`);

      // Assert
      expect(req.request.url).toContain('/api/devices/android');
      req.flush({ success: true, data: { deviceTypes: [] } });
    });
  });

  // ── Runtimes ─────────────────────────────────────────────────────────────

  describe('getRuntimes()', () => {
    it('should make a GET request to /api/runtimes when no platform is given', () => {
      // Arrange
      const mockResponse: ApiResponse<RuntimeListResponse> = {
        success: true,
        data: { runtimes: [] },
      };
      let result: ApiResponse<RuntimeListResponse> | undefined;

      // Act
      service.getRuntimes().subscribe((r) => (result = r));
      const req = httpTesting.expectOne(`${BASE}/api/runtimes`);

      // Assert
      expect(req.request.method).toBe('GET');
      req.flush(mockResponse);
      expect(result?.data?.runtimes).toEqual([]);
    });

    it('should make a GET request to /api/runtimes/ios when platform is ios', () => {
      // Act
      service.getRuntimes('ios').subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/runtimes/ios`);

      // Assert
      expect(req.request.url).toContain('/api/runtimes/ios');
      req.flush({ success: true, data: { runtimes: [] } });
    });

    it('should make a GET request to /api/runtimes/android when platform is android', () => {
      // Act
      service.getRuntimes('android').subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/runtimes/android`);

      // Assert
      expect(req.request.url).toContain('/api/runtimes/android');
      req.flush({ success: true, data: { runtimes: [] } });
    });
  });

  describe('downloadRuntime(request)', () => {
    it('should make a POST request to /api/runtimes/download with the identifier body', () => {
      // Arrange
      const request: DownloadRuntimeRequest = {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      };

      // Act
      service.downloadRuntime(request).subscribe();
      const req = httpTesting.expectOne(`${BASE}/api/runtimes/download`);

      // Assert
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(request);
      req.flush({ success: true });
    });
  });
});
