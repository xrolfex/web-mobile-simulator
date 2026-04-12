import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBusService } from './event-bus.js';
import type { WebSocketMessage, WebSocketMessageType } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Important: Node's EventEmitter treats 'error' as a special event that throws
// if no listener is registered for it. Tests that emit 'error' without a
// per-type listener must either register one or use a different event type.
// We use 'device_state_changed' as a safe generic type in those cases.
// ---------------------------------------------------------------------------

describe('EventBusService', () => {
  let bus: EventBusService;

  beforeEach(() => {
    // Use a fresh instance per test — never share state between tests
    bus = new EventBusService();
  });

  // -------------------------------------------------------------------------
  // emit()
  // -------------------------------------------------------------------------

  describe('emit()', () => {
    it('constructs a WebSocketMessage with the correct type', () => {
      const received: WebSocketMessage[] = [];
      bus.onAny((msg) => received.push(msg));
      // Register per-type listener to prevent unhandled-error throw
      bus.on('session_status_changed', () => {});

      bus.emit('session_status_changed', { sessionId: 'abc', status: 'active' });

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('session_status_changed');
    });

    it('embeds the payload exactly as provided', () => {
      const received: WebSocketMessage[] = [];
      bus.on('session_status_changed', (msg) => received.push(msg));
      bus.onAny(() => {});

      const payload = { sessionId: 'xyz', status: 'creating', previousStatus: 'creating' };
      bus.emit('session_status_changed', payload);

      expect(received[0]!.payload).toEqual(payload);
    });

    it('stamps the message with a valid ISO-8601 timestamp', () => {
      const before = new Date().toISOString();
      const received: WebSocketMessage[] = [];
      // Register per-type listener so the 'error' event doesn't throw
      bus.on('device_state_changed', (msg) => received.push(msg));

      bus.emit('device_state_changed', { message: 'test' });
      const after = new Date().toISOString();

      expect(received[0]!.timestamp).toBeTypeOf('string');
      expect(received[0]!.timestamp >= before).toBe(true);
      expect(received[0]!.timestamp <= after).toBe(true);
    });

    it('notifies both per-type and onAny subscribers in a single emit', () => {
      const perType: WebSocketMessage[] = [];
      const anyEvents: WebSocketMessage[] = [];

      bus.on('device_state_changed', (msg) => perType.push(msg));
      bus.onAny((msg) => anyEvents.push(msg));

      bus.emit('device_state_changed', { code: 'E001' });

      expect(perType).toHaveLength(1);
      expect(anyEvents).toHaveLength(1);
    });

    it('delivers equivalent message to both per-type and onAny subscribers', () => {
      let perTypeMsg: WebSocketMessage | null = null;
      let anyMsg: WebSocketMessage | null = null;

      bus.on('device_state_changed', (msg) => { perTypeMsg = msg; });
      bus.onAny((msg) => { anyMsg = msg; });

      bus.emit('device_state_changed', { state: 'booted' });

      expect(perTypeMsg).not.toBeNull();
      expect(anyMsg).not.toBeNull();
      expect(perTypeMsg!.type).toBe(anyMsg!.type);
      expect(perTypeMsg!.payload).toEqual(anyMsg!.payload);
      expect(perTypeMsg!.timestamp).toBe(anyMsg!.timestamp);
    });
  });

  // -------------------------------------------------------------------------
  // on() / off()
  // -------------------------------------------------------------------------

  describe('on()', () => {
    it('receives events for the exact subscribed type', () => {
      const received: WebSocketMessage[] = [];
      bus.on('runtime_download_progress', (msg) => received.push(msg));

      bus.emit('runtime_download_progress', { progress: 50 });

      expect(received).toHaveLength(1);
      expect((received[0]!.payload as { progress: number }).progress).toBe(50);
    });

    it('does NOT receive events for a different type', () => {
      const received: WebSocketMessage[] = [];
      bus.on('device_state_changed', (msg) => received.push(msg));
      // Also register on session_status_changed and runtime_download_progress
      // so those events don't go unhandled in the emitter (though non-error
      // types don't throw — just being explicit here)

      bus.emit('session_status_changed', { status: 'active' });
      bus.emit('runtime_download_progress', { progress: 25 });

      // The device_state_changed handler should NOT have fired
      expect(received).toHaveLength(0);
    });

    it('allows multiple handlers for the same type', () => {
      const calls: number[] = [];

      bus.on('runtime_download_progress', () => calls.push(1));
      bus.on('runtime_download_progress', () => calls.push(2));
      bus.on('runtime_download_progress', () => calls.push(3));

      bus.emit('runtime_download_progress', {});

      expect(calls).toHaveLength(3);
      expect(calls).toContain(1);
      expect(calls).toContain(2);
      expect(calls).toContain(3);
    });

    it('delivers payload typed correctly to the generic handler', () => {
      interface MyPayload { value: number }
      let received: MyPayload | null = null;

      bus.on<MyPayload>('device_state_changed', (msg) => {
        received = msg.payload;
      });

      bus.emit<MyPayload>('device_state_changed', { value: 42 });

      expect(received).toEqual({ value: 42 });
    });
  });

  describe('off()', () => {
    it('stops receiving events after calling off()', () => {
      const received: WebSocketMessage[] = [];
      const handler = (msg: WebSocketMessage) => received.push(msg);

      bus.on('session_status_changed', handler);
      bus.emit('session_status_changed', { first: true });

      bus.off('session_status_changed', handler);
      // After off(), emitting without any listener is fine for non-error types
      bus.emit('session_status_changed', { second: true });

      expect(received).toHaveLength(1);
      expect((received[0]!.payload as Record<string, unknown>)['first']).toBe(true);
    });

    it('only removes the specific handler, leaving other handlers intact', () => {
      const calls1: number[] = [];
      const calls2: number[] = [];

      const handler1 = () => calls1.push(1);
      const handler2 = () => calls2.push(2);

      bus.on('runtime_download_progress', handler1);
      bus.on('runtime_download_progress', handler2);

      bus.off('runtime_download_progress', handler1);

      bus.emit('runtime_download_progress', {});

      expect(calls1).toHaveLength(0);
      expect(calls2).toHaveLength(1);
    });

    it('is idempotent — calling off() on an unregistered handler does not throw', () => {
      const handler = vi.fn();

      expect(() => bus.off('device_state_changed', handler)).not.toThrow();
    });

    it('does not affect handlers registered for different types', () => {
      const stateCalls: number[] = [];
      const progressCalls: number[] = [];

      const stateHandler = () => stateCalls.push(1);
      const progressHandler = () => progressCalls.push(1);

      bus.on('device_state_changed', stateHandler);
      bus.on('runtime_download_progress', progressHandler);

      // Remove only the state handler
      bus.off('device_state_changed', stateHandler);

      bus.emit('device_state_changed', {});
      bus.emit('runtime_download_progress', {});

      expect(stateCalls).toHaveLength(0);
      expect(progressCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // onAny() / offAny()
  // -------------------------------------------------------------------------

  describe('onAny()', () => {
    it('receives ALL event types', () => {
      const types: WebSocketMessageType[] = [];
      bus.onAny((msg) => types.push(msg.type));

      // Register per-type handlers so non-onAny paths are also handled
      bus.on('session_status_changed', () => {});
      bus.on('runtime_download_progress', () => {});
      bus.on('device_state_changed', () => {});
      bus.on('error', () => {}); // prevent unhandled error throw

      bus.emit('session_status_changed', {});
      bus.emit('runtime_download_progress', {});
      bus.emit('device_state_changed', {});
      bus.emit('error', {});

      expect(types).toEqual([
        'session_status_changed',
        'runtime_download_progress',
        'device_state_changed',
        'error',
      ]);
    });

    it('returns the same handler reference passed to it', () => {
      const handler = vi.fn();

      const returned = bus.onAny(handler);

      expect(returned).toBe(handler);
    });

    it('supports multiple independent onAny subscribers', () => {
      const calls1: number[] = [];
      const calls2: number[] = [];

      bus.onAny(() => calls1.push(1));
      bus.onAny(() => calls2.push(2));

      // Use a safe event type that doesn't require a registered error listener
      bus.on('device_state_changed', () => {});
      bus.on('session_status_changed', () => {});

      bus.emit('device_state_changed', {});
      bus.emit('session_status_changed', {});

      expect(calls1).toHaveLength(2);
      expect(calls2).toHaveLength(2);
    });
  });

  describe('offAny()', () => {
    it('removes the onAny handler so it no longer receives events', () => {
      const received: WebSocketMessage[] = [];
      const handler = (msg: WebSocketMessage) => received.push(msg);

      bus.onAny(handler);
      bus.on('session_status_changed', () => {}); // ensure per-type listener exists

      bus.emit('session_status_changed', { first: true });

      bus.offAny(handler);
      bus.emit('session_status_changed', { second: true });

      expect(received).toHaveLength(1);
      expect((received[0]!.payload as Record<string, unknown>)['first']).toBe(true);
    });

    it('only removes the targeted handler, leaving others intact', () => {
      const calls1: number[] = [];
      const calls2: number[] = [];

      const h1 = () => calls1.push(1);
      const h2 = () => calls2.push(2);

      bus.onAny(h1);
      bus.onAny(h2);
      bus.on('session_status_changed', () => {}); // per-type listener

      bus.offAny(h1);

      bus.emit('session_status_changed', {});

      expect(calls1).toHaveLength(0);
      expect(calls2).toHaveLength(1);
    });

    it('is idempotent — calling offAny() on an unregistered handler does not throw', () => {
      const handler = vi.fn();

      expect(() => bus.offAny(handler)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 'error' event type — special EventEmitter handling
  // -------------------------------------------------------------------------

  describe("'error' event type", () => {
    it('delivers error events to registered per-type handlers without throwing', () => {
      const received: WebSocketMessage[] = [];

      // Register a listener — this prevents the EventEmitter from throwing
      bus.on('error', (msg) => received.push(msg));

      bus.emit('error', { code: 'TEST_ERROR', message: 'something went wrong' });

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('error');
    });

    it('delivers error events to onAny subscribers as well', () => {
      const anyReceived: WebSocketMessage[] = [];
      bus.on('error', () => {}); // per-type listener to prevent throw
      bus.onAny((msg) => anyReceived.push(msg));

      bus.emit('error', { code: 'ANY_ERROR' });

      expect(anyReceived).toHaveLength(1);
      expect(anyReceived[0]!.type).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple simultaneous subscribers
  // -------------------------------------------------------------------------

  describe('simultaneous subscribers', () => {
    it('all per-type and onAny subscribers receive the message in a single emit', () => {
      const log: string[] = [];

      bus.on('device_state_changed', () => log.push('per-type-1'));
      bus.on('device_state_changed', () => log.push('per-type-2'));
      bus.onAny(() => log.push('any-1'));
      bus.onAny(() => log.push('any-2'));

      bus.emit('device_state_changed', {});

      expect(log).toContain('per-type-1');
      expect(log).toContain('per-type-2');
      expect(log).toContain('any-1');
      expect(log).toContain('any-2');
      expect(log).toHaveLength(4);
    });

    it('handles rapid sequential emits without dropping events', () => {
      const received: number[] = [];
      bus.onAny((msg) => received.push((msg.payload as { n: number }).n));
      bus.on('runtime_download_progress', () => {}); // per-type

      for (let i = 0; i < 100; i++) {
        bus.emit('runtime_download_progress', { n: i });
      }

      expect(received).toHaveLength(100);
      expect(received[0]).toBe(0);
      expect(received[99]).toBe(99);
    });
  });
});
