import { Component, OnInit, signal, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import type { Session, SessionCapacityInfo } from '../../core/types/api.types';

/**
 * Admin page component.
 *
 * Displays ALL sessions (active, creating, error, terminated, terminating)
 * with force-purge capability per session and a bulk "Clear History" action.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent implements OnInit {
  /** All sessions returned by the admin endpoint. */
  protected readonly sessions = signal<Session[]>([]);

  /** Whether the sessions list is loading. */
  protected readonly loading = signal<boolean>(true);

  /** Capacity info from the admin endpoint. */
  protected readonly capacity = signal<SessionCapacityInfo | null>(null);

  /** IDs of sessions whose force-purge request is in-flight. */
  protected readonly purgingIds = signal<Set<string>>(new Set());

  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.loadSessions();
  }

  // ── Template event handlers ──────────────────────────────────────────────

  /** Reload the full sessions list from the admin endpoint. */
  protected refresh(): void {
    this.loadSessions();
  }

  /**
   * Clear terminated/error sessions from history, then refresh.
   */
  protected clearHistory(): void {
    this.api.clearSessionHistory().subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.toast.success(
            `Cleared ${response.data.count} session(s) from history.`,
          );
        } else {
          this.toast.success('Session history cleared.');
        }
        this.loadSessions();
      },
      error: (err: unknown) => {
        const message = this.extractErrorMessage(err, 'Failed to clear history.');
        this.toast.error(message);
      },
    });
  }

  /**
   * Force-purge a single session after user confirmation.
   * @param sessionId The session UUID to purge.
   */
  protected forcePurge(sessionId: string): void {
    const confirmed = window.confirm(
      'Force-purge this session? This will immediately destroy it regardless of its current state.',
    );
    if (!confirmed) return;

    const current = new Set(this.purgingIds());
    current.add(sessionId);
    this.purgingIds.set(current);

    this.api.forcePurgeSession(sessionId).subscribe({
      next: () => {
        const updated = new Set(this.purgingIds());
        updated.delete(sessionId);
        this.purgingIds.set(updated);
        this.toast.success('Session force-purged successfully.');
        this.loadSessions();
      },
      error: (err: unknown) => {
        const updated = new Set(this.purgingIds());
        updated.delete(sessionId);
        this.purgingIds.set(updated);
        const message = this.extractErrorMessage(err, 'Failed to purge session.');
        this.toast.error(message);
      },
    });
  }

  /**
   * Returns true if a force-purge request is in-flight for the given session.
   * @param sessionId The session UUID.
   */
  protected isPurging(sessionId: string): boolean {
    return this.purgingIds().has(sessionId);
  }

  /**
   * Returns the per-platform entries from capacity info as an array.
   */
  protected platformEntries(): Array<{ platform: string; active: number; max: number }> {
    const cap = this.capacity();
    if (!cap) return [];
    return Object.entries(cap.perPlatform).map(([platform, info]) => ({
      platform,
      active: info.active,
      max: info.max,
    }));
  }

  /**
   * Returns a human-readable creation date for a session.
   * @param createdAt ISO timestamp from the session.
   */
  protected formatDate(createdAt: string): string {
    return new Date(createdAt).toLocaleString();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Fetch all sessions from the admin endpoint. */
  private loadSessions(): void {
    this.loading.set(true);
    this.api.getAdminSessions().subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.sessions.set(response.data.sessions);
          this.capacity.set(response.data.capacity);
        } else {
          this.toast.error(response.error?.message ?? 'Failed to load sessions.');
        }
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        const message = this.extractErrorMessage(err, 'Failed to load sessions.');
        if (err instanceof HttpErrorResponse && err.status !== 0) {
          this.toast.error(message);
        }
      },
    });
  }

  /**
   * Extract a human-readable error message from an unknown error.
   * @param err   The caught error value.
   * @param fallback Default message when no specific message is available.
   */
  private extractErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const body = err.error as { error?: { message?: string } } | null;
      return body?.error?.message ?? `Server error (${err.status})`;
    }
    return fallback;
  }
}
