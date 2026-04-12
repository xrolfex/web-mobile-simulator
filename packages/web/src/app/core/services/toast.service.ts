import { Injectable, signal } from '@angular/core';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity level of a toast notification. */
export type ToastType = 'success' | 'error' | 'info' | 'warning';

/** A single toast notification entry. */
export interface Toast {
  /** Unique identifier generated via `crypto.randomUUID()`. */
  id: string;
  /** The human-readable message to display. */
  message: string;
  /** Severity level that controls colour and icon. */
  type: ToastType;
  /** How long (ms) the toast stays visible before auto-dismissal. */
  durationMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default duration (ms) a toast is visible before being auto-dismissed. */
const DEFAULT_DURATION_MS = 5_000;

/** Maximum number of toasts displayed simultaneously. */
const MAX_TOASTS = 5;

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Global singleton service that manages the queue of active toast notifications.
 *
 * Consumers call `success()`, `error()`, `info()`, or `warning()` to enqueue
 * toasts. Each toast is automatically dismissed after its `durationMs` elapses.
 * At most {@link MAX_TOASTS} toasts are shown at any time; when the limit is
 * reached the oldest toast is evicted before the new one is added.
 *
 * @example
 * ```ts
 * readonly toast = inject(ToastService);
 *
 * this.toast.success('Session started successfully!');
 * this.toast.error('Failed to connect.', 8_000);
 * ```
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  // ── Internal state ────────────────────────────────────────────────────────

  /** Mutable backing signal for the active toasts list. */
  private readonly _toasts = signal<Toast[]>([]);

  /**
   * Map from toast `id` to the pending `setTimeout` handle.
   * Stored so that the timer can be cancelled when a toast is dismissed early.
   */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Public API ────────────────────────────────────────────────────────────

  /** Read-only signal containing all currently active toasts. */
  readonly toasts = this._toasts.asReadonly();

  /**
   * Add a success toast.
   * @param message The message to display.
   * @param durationMs Override the default display duration in milliseconds.
   */
  success(message: string, durationMs?: number): void {
    this.add(message, 'success', durationMs);
  }

  /**
   * Add an error toast.
   * @param message The message to display.
   * @param durationMs Override the default display duration in milliseconds.
   */
  error(message: string, durationMs?: number): void {
    this.add(message, 'error', durationMs);
  }

  /**
   * Add an info toast.
   * @param message The message to display.
   * @param durationMs Override the default display duration in milliseconds.
   */
  info(message: string, durationMs?: number): void {
    this.add(message, 'info', durationMs);
  }

  /**
   * Add a warning toast.
   * @param message The message to display.
   * @param durationMs Override the default display duration in milliseconds.
   */
  warning(message: string, durationMs?: number): void {
    this.add(message, 'warning', durationMs);
  }

  /**
   * Remove a toast by its ID.
   *
   * Clears the associated auto-dismiss timer to prevent double-removal or
   * timer leaks when a toast is dismissed manually before it expires.
   *
   * @param id The `Toast.id` of the toast to remove.
   */
  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts.update((current) => current.filter((t) => t.id !== id));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Internal method that creates a toast, enforces the max-queue limit,
   * adds the toast to the signal, and schedules its auto-dismissal.
   *
   * @param message The message to display.
   * @param type Severity level of the toast.
   * @param durationMs Optional override for display duration.
   */
  private add(message: string, type: ToastType, durationMs?: number): void {
    const resolvedDuration = durationMs ?? DEFAULT_DURATION_MS;

    const toast: Toast = {
      id: crypto.randomUUID(),
      message,
      type,
      durationMs: resolvedDuration,
    };

    // Evict the oldest toast when the queue is at capacity.
    const current = this._toasts();
    if (current.length >= MAX_TOASTS) {
      this.dismiss(current[0].id);
    }

    this._toasts.update((list) => [...list, toast]);

    // Schedule auto-dismissal.
    const timer = setTimeout(() => this.dismiss(toast.id), resolvedDuration);
    this.timers.set(toast.id, timer);
  }
}
