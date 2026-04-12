import { Injectable, OnDestroy } from '@angular/core';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Core WebSocket service for real-time communication with the backend.
 * Manages connection lifecycle and message routing.
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  /** Emits when the service is destroyed — used to complete observables. */
  private readonly destroy$ = new Subject<void>();

  /** Underlying WebSocket subject — lazily initialized on first connect. */
  private socket$: WebSocketSubject<unknown> | null = null;

  // TODO: Implement connection management
  // TODO: Implement message routing by WebSocketMessageType
  // TODO: Add reconnection logic with exponential backoff

  /** Tear down the WebSocket connection when the service is destroyed. */
  ngOnDestroy(): void {
    this.disconnect();
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Establish a WebSocket connection to the backend events endpoint.
   * No-op if already connected.
   */
  connect(): void {
    if (this.socket$) return;
    const wsUrl = `${environment.wsUrl}/ws/events`;
    this.socket$ = webSocket(wsUrl);
  }

  /** Close the WebSocket connection and clean up. */
  disconnect(): void {
    this.socket$?.complete();
    this.socket$ = null;
  }
}
