import { EventEmitter } from 'node:events';
import type { WebSocketMessage, WebSocketMessageType } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[EventBusService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Return an ISO-8601 timestamp for the current moment. */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Internal event name used to broadcast every WebSocketMessage to `onAny`
 * subscribers, regardless of the message's `type` field.
 */
const ANY_EVENT = '__any__';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Handler signature for typed per-event-type subscriptions.
 *
 * @template T - Shape of the event payload.
 */
export type EventHandler<T = unknown> = (message: WebSocketMessage<T>) => void;

/**
 * Handler signature for the `onAny` all-events subscription.
 * Receives the fully-constructed {@link WebSocketMessage}.
 */
export type AnyEventHandler = (message: WebSocketMessage<unknown>) => void;

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * In-process typed event bus.
 *
 * Wraps a Node.js `EventEmitter` to provide:
 * - `emit(type, payload)` — publish a {@link WebSocketMessage} stamped with the
 *   current ISO timestamp.
 * - `on(type, handler)` / `off(type, handler)` — subscribe/unsubscribe to a
 *   specific {@link WebSocketMessageType}.
 * - `onAny(handler)` / `offAny(handler)` — subscribe/unsubscribe to **all**
 *   event types; used by the WebSocket route to broadcast every message to
 *   connected browser clients.
 *
 * Export the singleton `eventBusService` rather than constructing instances.
 */
export class EventBusService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Increase the default listener limit since the WS route may register one
    // `onAny` handler per connected client.
    this.emitter.setMaxListeners(200);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Construct a {@link WebSocketMessage} from `type` and `payload` (stamped
   * with the current timestamp) and publish it to all matching subscribers,
   * as well as all `onAny` subscribers.
   *
   * @param type    - The {@link WebSocketMessageType} discriminant.
   * @param payload - Arbitrary event payload; will be embedded as-is.
   */
  emit<T>(type: WebSocketMessageType, payload: T): void {
    const message: WebSocketMessage<T> = {
      type,
      payload,
      timestamp: now(),
    };

    log(`Emitting event: ${type}`);

    // Notify per-type subscribers.
    this.emitter.emit(type, message);

    // Notify all-event subscribers (used by the WS broadcast route).
    this.emitter.emit(ANY_EVENT, message as WebSocketMessage<unknown>);
  }

  /**
   * Subscribe to events of a specific {@link WebSocketMessageType}.
   *
   * @param type    - The event type to listen for.
   * @param handler - Callback invoked with the full {@link WebSocketMessage}.
   */
  on<T>(type: WebSocketMessageType, handler: EventHandler<T>): void {
    this.emitter.on(type, handler as EventHandler);
  }

  /**
   * Unsubscribe a previously registered per-type handler.
   *
   * @param type    - The event type the handler was registered for.
   * @param handler - The exact handler reference that was passed to `on`.
   */
  off<T>(type: WebSocketMessageType, handler: EventHandler<T>): void {
    this.emitter.off(type, handler as EventHandler);
  }

  /**
   * Subscribe to **all** event types.  The handler is called once for every
   * `emit()` call regardless of the event's `type` field.
   *
   * This is the primary integration point for the WebSocket broadcast route:
   * register one handler per connected client, remove it on disconnect.
   *
   * @param handler - Callback invoked with each {@link WebSocketMessage}.
   * @returns The same `handler` reference, for convenient use with `offAny`.
   */
  onAny(handler: AnyEventHandler): AnyEventHandler {
    this.emitter.on(ANY_EVENT, handler);
    return handler;
  }

  /**
   * Unsubscribe a previously registered `onAny` handler.
   *
   * @param handler - The exact handler reference that was passed to `onAny`.
   */
  offAny(handler: AnyEventHandler): void {
    this.emitter.off(ANY_EVENT, handler);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const eventBusService = new EventBusService();
