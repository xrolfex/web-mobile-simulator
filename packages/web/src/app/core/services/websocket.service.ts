import { Injectable, NgZone, OnDestroy, inject } from '@angular/core';
import { Observable, Subject, filter, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  RuntimeDownloadProgressPayload,
  SessionStatusChangedPayload,
  WebSocketMessage,
} from '../types/api.types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of automatic reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 20;

/**
 * Reconnection delay steps in milliseconds.
 * The last value is repeated once the index is exhausted.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Connection state values emitted by {@link WebSocketService.connectionState$}. */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Core WebSocket service for real-time communication with the backend.
 *
 * Manages connection lifecycle (connect / disconnect), exponential-backoff
 * reconnection, and typed message routing via RxJS Subjects.
 *
 * @example
 * ```ts
 * websocketService.connect();
 * websocketService.sessionStatusChanges$.subscribe(msg => { ... });
 * ```
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  // ── Private dependencies ──────────────────────────────────────────────────

  private readonly zone = inject(NgZone);

  // ── Internal state ────────────────────────────────────────────────────────

  /** The live native WebSocket instance, or null when disconnected. */
  private socket: WebSocket | null = null;

  /** Incremented on each reconnection attempt; reset on successful connect. */
  private reconnectAttempts = 0;

  /** Handle returned by setTimeout for the next reconnection attempt. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** When true, reconnection is permanently suppressed (e.g. after disconnect()). */
  private reconnectStopped = false;

  // ── Subjects ──────────────────────────────────────────────────────────────

  /** Broadcasts every parsed WebSocket message received from the server. */
  private readonly messagesSubject$ = new Subject<WebSocketMessage>();

  /** Broadcasts changes to the connection state. */
  private readonly connectionStateSubject$ =
    new Subject<ConnectionState>();

  // ── Public observables ────────────────────────────────────────────────────

  /**
   * Emits every {@link WebSocketMessage} received from the server,
   * regardless of type.
   */
  readonly messages$: Observable<WebSocketMessage> =
    this.messagesSubject$.asObservable();

  /**
   * Emits the current connection state whenever it changes.
   * Values: `'connecting'` | `'connected'` | `'disconnected'` | `'reconnecting'`
   */
  readonly connectionState$: Observable<ConnectionState> =
    this.connectionStateSubject$.asObservable();

  /**
   * Emits only `session_status_changed` messages, typed with their payload.
   */
  readonly sessionStatusChanges$: Observable<
    WebSocketMessage<SessionStatusChangedPayload>
  > = this.messages$.pipe(
    filter((msg) => msg.type === 'session_status_changed'),
    map((msg) => msg as WebSocketMessage<SessionStatusChangedPayload>),
  );

  /**
   * Emits only `runtime_download_progress` messages, typed with their payload.
   */
  readonly runtimeDownloadProgress$: Observable<
    WebSocketMessage<RuntimeDownloadProgressPayload>
  > = this.messages$.pipe(
    filter((msg) => msg.type === 'runtime_download_progress'),
    map((msg) => msg as WebSocketMessage<RuntimeDownloadProgressPayload>),
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Clean up when the service is destroyed (app shutdown). */
  ngOnDestroy(): void {
    this.disconnect();
    this.messagesSubject$.complete();
    this.connectionStateSubject$.complete();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Open a WebSocket connection to the backend events endpoint.
   *
   * If a connection is already open this is a no-op. Reconnection backoff is
   * reset, and the service will automatically attempt to reconnect on
   * unexpected disconnects.
   */
  connect(): void {
    if (this.socket !== null) return;

    this.reconnectStopped = false;
    this.openSocket();
  }

  /**
   * Close the WebSocket connection and permanently suppress reconnection.
   *
   * Call this only when you intentionally want to stop all communication
   * (e.g. the app is logging out). Individual consumers should NOT call this
   * because the service is shared — just unsubscribe from the observables.
   */
  disconnect(): void {
    this.stopReconnecting();
    this.closeSocket(false /* do not schedule reconnect */);
    this.emitConnectionState('disconnected');
  }

  /**
   * Halt any pending or future reconnection attempts without closing an
   * already-open connection.
   */
  stopReconnecting(): void {
    this.reconnectStopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the WebSocket URL. In production `wsUrl` is intentionally empty
   * so we derive the URL from `window.location` to avoid hardcoding origins.
   */
  private resolveWsUrl(): string {
    if (environment.wsUrl) {
      return `${environment.wsUrl}/ws/events`;
    }

    // Production: same-origin, derive protocol from page protocol.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/events`;
  }

  /** Open a fresh native WebSocket and attach all event handlers. */
  private openSocket(): void {
    const url = this.resolveWsUrl();
    console.log(`[WebSocket] Connecting to ${url}`);
    this.emitConnectionState('connecting');

    // Run outside Angular's zone so that the open/close/message callbacks
    // don't trigger unnecessary change-detection cycles on their own. Each
    // callback explicitly re-enters the zone when it needs to update state.
    this.zone.runOutsideAngular(() => {
      const ws = new WebSocket(url);
      this.socket = ws;

      ws.addEventListener('open', () => this.handleOpen());
      ws.addEventListener('message', (event) => this.handleMessage(event));
      ws.addEventListener('close', (event) => this.handleClose(event));
      ws.addEventListener('error', (event) => this.handleError(event));
    });
  }

  /**
   * Close the current socket, optionally triggering reconnection.
   * @param scheduleReconnect When true, exponential-backoff reconnect is queued.
   */
  private closeSocket(scheduleReconnect: boolean): void {
    if (this.socket === null) return;

    const ws = this.socket;
    this.socket = null;

    // Remove listeners before closing to prevent double-handling of the
    // close event that will fire when we call ws.close().
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;

    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }

    if (scheduleReconnect) {
      this.scheduleReconnect();
    }
  }

  /** Handle a successful connection open. */
  private handleOpen(): void {
    this.zone.run(() => {
      console.log('[WebSocket] Connected');
      this.reconnectAttempts = 0;
      this.emitConnectionState('connected');
    });
  }

  /**
   * Handle an incoming message frame.
   * @param event The MessageEvent from the native WebSocket.
   */
  private handleMessage(event: MessageEvent): void {
    this.zone.run(() => {
      try {
        const message = JSON.parse(event.data as string) as WebSocketMessage;
        this.messagesSubject$.next(message);
      } catch {
        console.error(
          '[WebSocket] Failed to parse message:',
          event.data,
        );
      }
    });
  }

  /**
   * Handle a socket close event.
   * @param event The CloseEvent from the native WebSocket.
   */
  private handleClose(event: CloseEvent): void {
    this.zone.run(() => {
      // Code 1000 = normal closure (we called disconnect() ourselves)
      const isClean = event.wasClean && event.code === 1000;
      console.log(
        `[WebSocket] Disconnected (code=${event.code}, clean=${event.wasClean})`,
      );

      this.socket = null;

      if (isClean || this.reconnectStopped) {
        this.emitConnectionState('disconnected');
      } else {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Handle a socket error event.
   * @param event The Event from the native WebSocket.
   */
  private handleError(event: Event): void {
    this.zone.run(() => {
      console.error('[WebSocket] Connection error:', event);
      // The browser always fires a close event right after an error, so we
      // let handleClose() decide whether to reconnect.
    });
  }

  /**
   * Schedule the next reconnection attempt using exponential backoff.
   * Gives up after {@link MAX_RECONNECT_ATTEMPTS} attempts.
   */
  private scheduleReconnect(): void {
    if (this.reconnectStopped) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(
        `[WebSocket] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
      );
      this.emitConnectionState('disconnected');
      return;
    }

    const delayIndex = Math.min(
      this.reconnectAttempts,
      RECONNECT_DELAYS_MS.length - 1,
    );
    const delayMs = RECONNECT_DELAYS_MS[delayIndex];
    this.reconnectAttempts++;

    console.log(
      `[WebSocket] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
    );
    this.emitConnectionState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.reconnectStopped) {
        this.openSocket();
      }
    }, delayMs);
  }

  /**
   * Emit a new connection state to subscribers.
   * @param state The new connection state.
   */
  private emitConnectionState(state: ConnectionState): void {
    this.connectionStateSubject$.next(state);
  }
}
