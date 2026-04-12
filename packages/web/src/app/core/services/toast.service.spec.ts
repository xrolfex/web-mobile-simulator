/**
 * Unit tests for ToastService.
 *
 * Tests use Vitest (globals enabled) with jsdom environment.
 * vi.useFakeTimers() controls setTimeout behaviour — no fakeAsync/tick.
 * crypto.randomUUID() is stubbed so IDs are deterministic.
 */
import { TestBed } from '@angular/core/testing';
import { ToastService, type Toast, type ToastType } from './toast.service';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns incremented UUID strings for deterministic ordering in tests. */
function makeUUIDSequence(): () => string {
  let n = 0;
  return () => `uuid-${++n}`;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ToastService', () => {
  let service: ToastService;
  let uuidGen: () => string;

  beforeEach(() => {
    // Set up sequential, predictable IDs.
    uuidGen = makeUUIDSequence();
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => uuidGen()) });

    // Use fake timers so setTimeout calls are under test control.
    vi.useFakeTimers();

    TestBed.configureTestingModule({});
    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  // ── Adding toasts ────────────────────────────────────────────────────────────

  describe('adding toasts', () => {
    it('success() adds a toast with type "success"', () => {
      // Arrange + Act
      service.success('Done!');

      // Assert
      const toasts = service.toasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0].type).toBe('success');
    });

    it('error() adds a toast with type "error"', () => {
      service.error('Oops!');

      expect(service.toasts()[0].type).toBe('error');
    });

    it('info() adds a toast with type "info"', () => {
      service.info('FYI');

      expect(service.toasts()[0].type).toBe('info');
    });

    it('warning() adds a toast with type "warning"', () => {
      service.warning('Heads up');

      expect(service.toasts()[0].type).toBe('warning');
    });

    it('each toast receives the provided message', () => {
      // Arrange
      const msg = 'Hello toast world';

      // Act
      service.success(msg);

      // Assert
      expect(service.toasts()[0].message).toBe(msg);
    });

    it('each toast gets a unique id', () => {
      // Act
      service.success('First');
      service.success('Second');
      service.success('Third');

      // Assert
      const ids = service.toasts().map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });

    it('toast id is sourced from crypto.randomUUID()', () => {
      // Arrange — stub returns predictable value
      service.success('msg');

      // Assert — the first call yields 'uuid-1' from our sequence
      expect(service.toasts()[0].id).toBe('uuid-1');
    });

    it('default durationMs is 5000 when no override is given', () => {
      service.info('No duration override');

      expect(service.toasts()[0].durationMs).toBe(5000);
    });

    it('custom durationMs is stored when provided', () => {
      service.error('Quick error', 2000);

      expect(service.toasts()[0].durationMs).toBe(2000);
    });

    it('multiple toasts accumulate in the toasts signal', () => {
      service.success('A');
      service.error('B');
      service.info('C');

      expect(service.toasts()).toHaveLength(3);
    });
  });

  // ── Dismiss ──────────────────────────────────────────────────────────────────

  describe('dismiss', () => {
    it('dismiss(id) removes the matching toast from the list', () => {
      // Arrange
      service.success('To dismiss');
      const id = service.toasts()[0].id;

      // Act
      service.dismiss(id);

      // Assert
      expect(service.toasts()).toHaveLength(0);
    });

    it('dismiss(id) leaves other toasts intact', () => {
      // Arrange
      service.success('Keep me');
      service.error('Remove me');
      const keepId = service.toasts()[0].id;
      const removeId = service.toasts()[1].id;

      // Act
      service.dismiss(removeId);

      // Assert
      const remaining = service.toasts();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(keepId);
    });

    it('dismiss(id) is a no-op for an unknown id', () => {
      // Arrange
      service.success('Stays');

      // Act — dismissing a non-existent id should not throw
      expect(() => service.dismiss('does-not-exist')).not.toThrow();

      // Assert — original toast still present
      expect(service.toasts()).toHaveLength(1);
    });

    it('dismiss(id) clears the auto-dismiss timer so it does not fire later', () => {
      // Arrange
      service.success('Manual dismiss');
      const id = service.toasts()[0].id;

      // Act — dismiss before timer fires
      service.dismiss(id);

      // Fast-forward past the default 5000ms duration
      vi.advanceTimersByTime(6000);

      // Assert — still empty (no double-removal error, no ghost re-removal)
      expect(service.toasts()).toHaveLength(0);
    });
  });

  // ── Auto-dismiss ─────────────────────────────────────────────────────────────

  describe('auto-dismiss', () => {
    it('toast is auto-dismissed after its default durationMs (5000ms)', () => {
      // Arrange
      service.success('Auto gone');

      // Act — advance time just past the default 5000ms
      vi.advanceTimersByTime(5001);

      // Assert
      expect(service.toasts()).toHaveLength(0);
    });

    it('toast is NOT removed before its durationMs elapses', () => {
      // Arrange
      service.success('Still here');

      // Act — advance time but not enough
      vi.advanceTimersByTime(4999);

      // Assert
      expect(service.toasts()).toHaveLength(1);
    });

    it('custom duration is respected for auto-dismiss', () => {
      // Arrange
      service.warning('Short-lived', 1000);

      // Act
      vi.advanceTimersByTime(1001);

      // Assert
      expect(service.toasts()).toHaveLength(0);
    });

    it('multiple toasts with different durations auto-dismiss independently', () => {
      // Arrange
      service.info('Short', 1000);
      service.info('Long', 8000);

      // Act — advance past short but not long
      vi.advanceTimersByTime(2000);

      // Assert — only the long-duration toast remains
      expect(service.toasts()).toHaveLength(1);
      expect(service.toasts()[0].durationMs).toBe(8000);
    });

    it('all toasts are eventually dismissed after their durations', () => {
      // Arrange
      service.success('A', 1000);
      service.error('B', 2000);
      service.info('C', 3000);

      // Act
      vi.advanceTimersByTime(3001);

      // Assert
      expect(service.toasts()).toHaveLength(0);
    });
  });

  // ── Max queue ────────────────────────────────────────────────────────────────

  describe('max queue (5 simultaneous toasts)', () => {
    it('five toasts can coexist without eviction', () => {
      // Arrange + Act
      service.success('1');
      service.success('2');
      service.success('3');
      service.success('4');
      service.success('5');

      // Assert
      expect(service.toasts()).toHaveLength(5);
    });

    it('adding a 6th toast evicts the oldest', () => {
      // Arrange — fill the queue to capacity
      for (let i = 1; i <= 5; i++) {
        service.success(`Toast ${i}`);
      }
      const secondId = service.toasts()[1].id;

      // Act — add one more
      service.success('Toast 6');

      // Assert — still only 5 toasts; first was evicted
      const current = service.toasts();
      expect(current).toHaveLength(5);
      // The previously second toast is now first
      expect(current[0].id).toBe(secondId);
      // The newest toast is last
      expect(current[4].message).toBe('Toast 6');
    });

    it('adding a 7th toast continues evicting the oldest', () => {
      // Arrange
      for (let i = 1; i <= 5; i++) {
        service.success(`Toast ${i}`);
      }
      const thirdId = service.toasts()[2].id;

      // Act — add two more
      service.success('Toast 6');
      service.success('Toast 7');

      // Assert — still 5; the first two originals were evicted
      const current = service.toasts();
      expect(current).toHaveLength(5);
      expect(current[0].id).toBe(thirdId);
      expect(current[4].message).toBe('Toast 7');
    });

    it('evicted toast timer is cleared when it is displaced', () => {
      // Arrange — fill queue with long-lived toasts
      for (let i = 1; i <= 5; i++) {
        service.success(`Toast ${i}`, 30_000);
      }

      // Capture the id that will be evicted
      const evictedId = service.toasts()[0].id;

      // Act — push a 6th, forcing eviction of evictedId
      service.success('Toast 6', 30_000);

      // Fast-forward 30s — evicted timer should NOT fire and re-remove anything
      vi.advanceTimersByTime(30_001);

      // Assert — queue naturally drains from remaining 5 timers firing
      expect(service.toasts()).toHaveLength(0);
      // No toast with the evicted ID exists
      expect(service.toasts().find((t) => t.id === evictedId)).toBeUndefined();
    });
  });
});
