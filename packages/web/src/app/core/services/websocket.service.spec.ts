/**
 * Unit tests for WebSocketService.
 *
 * The service wraps the native WebSocket API and NgZone.  We mock both so
 * that tests are fully isolated from real network connections and Angular's
 * change-detection machinery.
 *
 * Note: Vitest 4 does not support the done() callback pattern — all async
 * assertions use firstValueFrom / Promise-based patterns instead.
 * fakeAsync from @angular/core/testing requires Angular's ProxyZone which
 * Vitest does not set up; timer-based tests use vi.useFakeTimers() instead.
 */
import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { firstValueFrom, take, toArray } from 'rxjs';

import { WebSocketService } from './websocket.service';

// ── Mock WebSocket ────────────────────────────────────────────────────────────

/**
 * Minimal WebSocket mock that lets tests drive the connection lifecycle
 * (open, message, close, error) programmatically.
 */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;

  // Event handler slots (mirroring the native WebSocket API)
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  /** Tracks all instances created during a test for inspection. */
  static instances: MockWebSocket[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  /** Simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Simulate the server sending a message. */
  simulateMessage(data: unknown): void {
    const event = new MessageEvent('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
    this.onmessage?.(event);
  }

  /** Simulate the connection closing (e.g. server-side close). */
  simulateClose(code = 1006, reason = '', wasClean = false): void {
    this.readyState = MockWebSocket.CLOSED;
    const event = new CloseEvent('close', { code, reason, wasClean });
    this.onclose?.(event);
  }

  /** Simulate a socket error. */
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  /** addEventListener stub — delegates to the matching on* property. */
  addEventListener(
    type: string,
    handler: EventListenerOrEventListenerObject,
  ): void {
    const fn =
      typeof handler === 'function'
        ? handler
        : (e: Event) => handler.handleEvent(e);

    if (type === 'open') this.onopen = fn as (ev: Event) => void;
    else if (type === 'message')
      this.onmessage = fn as (ev: MessageEvent) => void;
    else if (type === 'close') this.onclose = fn as (ev: CloseEvent) => void;
    else if (type === 'error') this.onerror = fn as (ev: Event) => void;
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  send(_data: unknown): void {
    /* no-op */
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run a callback inside Angular's NgZone so emitted values propagate. */
function runInZone(fn: () => void): void {
  TestBed.inject(NgZone).run(fn);
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('WebSocketService', () => {
  let service: WebSocketService;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    // Replace the global WebSocket constructor with our mock.
    originalWebSocket = globalThis.WebSocket;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = MockWebSocket;
    MockWebSocket.instances = [];

    TestBed.configureTestingModule({
      providers: [WebSocketService],
    });

    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  // ── connectionState$ ──────────────────────────────────────────────────────

  describe('connectionState$', () => {
    it('should emit "connecting" immediately after connect() is called', async () => {
      // Arrange
      const statePromise = firstValueFrom(service.connectionState$.pipe(take(1)));

      // Act
      service.connect();

      // Assert
      expect(await statePromise).toBe('connecting');
    });

    it('should emit "connected" once the underlying socket fires the open event', async () => {
      // Arrange — collect the first two states
      const statesPromise = firstValueFrom(
        service.connectionState$.pipe(take(2), toArray()),
      );

      // Act
      service.connect();
      runInZone(() => MockWebSocket.instances[0].simulateOpen());

      // Assert
      const states = await statesPromise;
      expect(states).toEqual(['connecting', 'connected']);
    });

    it('should emit "disconnected" after disconnect() is called', async () => {
      // Arrange — wait for two state emissions: 'connecting' + 'disconnected'
      const statesPromise = firstValueFrom(
        service.connectionState$.pipe(take(2), toArray()),
      );

      // Act
      service.connect();   // → 'connecting'
      service.disconnect(); // → 'disconnected'

      // Assert
      const states = await statesPromise;
      expect(states).toContain('disconnected');
    });

    it('should emit "reconnecting" when the socket closes unexpectedly', async () => {
      // Arrange — use fake timers so the reconnect setTimeout fires synchronously
      vi.useFakeTimers();
      const statesPromise = firstValueFrom(
        service.connectionState$.pipe(take(3), toArray()),
      );

      // Act — connect, then simulate unclean close
      service.connect();
      runInZone(() =>
        MockWebSocket.instances[0].simulateClose(1006, 'Gone away', false),
      );

      // Advance clock past the first reconnect delay (1 000 ms)
      vi.advanceTimersByTime(1001);
      // Stop further reconnections to prevent the test from hanging.
      service.stopReconnecting();

      // Assert
      const states = await statesPromise;
      expect(states).toContain('reconnecting');
    });
  });

  // ── connect() ─────────────────────────────────────────────────────────────

  describe('connect()', () => {
    it('should create a WebSocket pointing to the configured wsUrl', () => {
      // Act
      service.connect();

      // Assert
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe(
        'ws://localhost:3000/ws/events',
      );
    });

    it('should be a no-op when already connected (prevents duplicate sockets)', () => {
      // Act
      service.connect();
      service.connect(); // second call should be ignored

      // Assert
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('should allow a new connection after disconnect() clears the socket', () => {
      // Act
      service.connect();
      service.disconnect();
      service.connect();

      // Assert — two separate socket instances
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });

  // ── disconnect() ──────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('should be safe to call when not connected (no-op, no throw)', () => {
      expect(() => service.disconnect()).not.toThrow();
    });

    it('should close the underlying socket', () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      // Act
      service.disconnect();

      // Assert
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('should emit "disconnected" even when called before the socket opens', async () => {
      // Arrange — collect 'connecting' + 'disconnected'
      const statesPromise = firstValueFrom(
        service.connectionState$.pipe(take(2), toArray()),
      );

      // Act
      service.connect();    // → 'connecting'
      service.disconnect(); // → 'disconnected'

      // Assert
      const states = await statesPromise;
      expect(states[states.length - 1]).toBe('disconnected');
    });
  });

  // ── stopReconnecting() ────────────────────────────────────────────────────

  describe('stopReconnecting()', () => {
    it('should prevent reconnection after an unclean close', () => {
      // Arrange
      vi.useFakeTimers();
      service.connect();
      service.stopReconnecting();

      runInZone(() =>
        MockWebSocket.instances[0].simulateClose(1006, '', false),
      );

      // Act — advance the clock past the first reconnect delay
      vi.advanceTimersByTime(2000);

      // Assert — no new socket should have been created
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('should be safe to call when no reconnect timer is pending', () => {
      expect(() => service.stopReconnecting()).not.toThrow();
    });

    it('should cancel a pending reconnect timer', () => {
      // Arrange
      vi.useFakeTimers();
      service.connect();

      // Trigger reconnect scheduling
      runInZone(() =>
        MockWebSocket.instances[0].simulateClose(1006, '', false),
      );

      // Act — stop reconnecting before the timer fires
      service.stopReconnecting();
      vi.advanceTimersByTime(5000);

      // Assert — only the original socket, no reconnect
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  // ── messages$ / typed streams ─────────────────────────────────────────────

  describe('messages$', () => {
    it('should emit parsed WebSocketMessage objects', async () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      const msgPromise = firstValueFrom(service.messages$.pipe(take(1)));

      // Act
      runInZone(() =>
        ws.simulateMessage({
          type: 'connected',
          payload: { message: 'Hello' },
          timestamp: new Date().toISOString(),
        }),
      );

      // Assert
      const msg = await msgPromise;
      expect(msg.type).toBe('connected');
      expect(msg.payload).toEqual({ message: 'Hello' });
    });

    it('should not throw when the server sends malformed JSON', () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      // Act + Assert — the service should swallow parse errors
      expect(() => {
        runInZone(() => ws.simulateMessage('not-valid-json{{'));
      }).not.toThrow();
    });

    it('should not emit anything for malformed JSON messages', async () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      let emitted = false;
      const sub = service.messages$.subscribe(() => (emitted = true));

      // Act
      runInZone(() => ws.simulateMessage('{{invalid json'));

      // Assert — no message should have been emitted
      expect(emitted).toBe(false);
      sub.unsubscribe();
    });
  });

  describe('sessionStatusChanges$', () => {
    it('should emit only session_status_changed messages', async () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      const msgPromise = firstValueFrom(
        service.sessionStatusChanges$.pipe(take(1)),
      );

      // Act — emit an unrelated message first, then the relevant one
      runInZone(() => {
        ws.simulateMessage({
          type: 'connected',
          payload: {},
          timestamp: new Date().toISOString(),
        });
        ws.simulateMessage({
          type: 'session_status_changed',
          payload: {
            sessionId: 's1',
            status: 'active',
            previousStatus: 'creating',
          },
          timestamp: new Date().toISOString(),
        });
      });

      // Assert
      const msg = await msgPromise;
      expect(msg.type).toBe('session_status_changed');
    });
  });

  describe('runtimeDownloadProgress$', () => {
    it('should emit only runtime_download_progress messages', async () => {
      // Arrange
      service.connect();
      const ws = MockWebSocket.instances[0];

      const msgPromise = firstValueFrom(
        service.runtimeDownloadProgress$.pipe(take(1)),
      );

      // Act
      runInZone(() =>
        ws.simulateMessage({
          type: 'runtime_download_progress',
          payload: {
            platform: 'ios',
            identifier: 'rt-1',
            progress: 50,
            status: 'downloading',
          },
          timestamp: new Date().toISOString(),
        }),
      );

      // Assert
      const msg = await msgPromise;
      expect(msg.type).toBe('runtime_download_progress');
    });
  });

  // ── ngOnDestroy ───────────────────────────────────────────────────────────

  describe('ngOnDestroy()', () => {
    it('should complete the messages$ observable', async () => {
      // Arrange
      let completed = false;
      service.messages$.subscribe({ complete: () => (completed = true) });

      // Act
      service.ngOnDestroy();

      // Assert
      expect(completed).toBe(true);
    });

    it('should complete the connectionState$ observable', async () => {
      // Arrange
      let completed = false;
      service.connectionState$.subscribe({
        complete: () => (completed = true),
      });

      // Act
      service.ngOnDestroy();

      // Assert
      expect(completed).toBe(true);
    });

    it('should be safe to call multiple times', () => {
      expect(() => {
        service.ngOnDestroy();
        service.ngOnDestroy();
      }).not.toThrow();
    });
  });
});
