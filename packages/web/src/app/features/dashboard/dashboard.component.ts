import {
  Component,
  OnInit,
  OnDestroy,
  signal,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from '../../core/services/api.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { ToastService } from '../../core/services/toast.service';
import { LaunchDialogComponent } from './launch-dialog.component';
import type { Platform, Session, SessionCapacityInfo } from '../../core/types/api.types';

/**
 * How often (ms) to auto-refresh the active sessions list via polling.
 * Reduced from 10 s to 30 s because WebSocket events provide near-instant
 * updates for session state changes.
 */
const SESSION_REFRESH_INTERVAL_MS = 30_000;

/** Maps platform to its display configuration. */
interface PlatformCard {
  /** Internal platform identifier. */
  platform: Platform;
  /** Emoji icon for the card. */
  icon: string;
  /** Human-readable title. */
  title: string;
  /** Short description shown under the title. */
  description: string;
}

/**
 * Dashboard / landing page component.
 *
 * Shows iOS and Android simulator launch cards, a launch dialog overlay,
 * and the list of active sessions with auto-refresh.
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [LaunchDialogComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  /** Static platform cards configuration. */
  protected readonly platformCards: PlatformCard[] = [
    {
      platform: 'ios',
      icon: '🍎',
      title: 'iOS Simulator',
      description:
        'Run iPhone and iPad simulators directly in your browser. Supports iOS 16 and above.',
    },
    {
      platform: 'android',
      icon: '🤖',
      title: 'Android Emulator',
      description:
        'Run Android virtual devices in the browser. Supports Android 12 (API 31) and above.',
    },
  ];

  /** Platform for the open launch dialog; null means the dialog is closed. */
  protected readonly dialogPlatform = signal<Platform | null>(null);

  /** Whether the dialog overlay is visible. */
  protected readonly dialogOpen = computed(() => this.dialogPlatform() !== null);

  /** Active simulator sessions fetched from the API. */
  protected readonly activeSessions = signal<Session[]>([]);

  /** Whether the sessions list is loading for the first time. */
  protected readonly sessionsLoading = signal<boolean>(true);

  /** Error message from the sessions API, empty when no error. */
  protected readonly sessionsError = signal<string>('');

  /** IDs of sessions whose stop request is in-flight. */
  protected readonly stoppingSessions = signal<Set<string>>(new Set());

  /** Capacity info from the API. */
  protected readonly capacity = signal<SessionCapacityInfo | null>(null);

  /** Whether to show terminated/error sessions (history). */
  protected readonly showHistory = signal<boolean>(false);

  /** All sessions including terminated ones. */
  protected readonly allSessions = signal<Session[]>([]);

  /** Terminated/error sessions for the history view. */
  protected readonly historySessions = computed(() =>
    this.allSessions().filter(
      (s) => s.status === 'terminated' || s.status === 'error',
    ),
  );

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly websocketService = inject(WebSocketService);
  private readonly toast = inject(ToastService);

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Subscription to WebSocket session-status events; cleaned up on destroy. */
  private wsSessionSub: Subscription | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.loadSessions();
    this.refreshTimer = setInterval(
      () => this.loadSessions(),
      SESSION_REFRESH_INTERVAL_MS,
    );

    // Connect WebSocket for real-time session updates.
    this.websocketService.connect();

    // Refresh the sessions list immediately whenever a session status changes.
    this.wsSessionSub = this.websocketService.sessionStatusChanges$.subscribe(
      (msg) => {
        this.loadSessions();
        const status = msg.payload.status;
        if (status === 'active') {
          this.toast.info('A session is now active.');
        } else if (status === 'error') {
          this.toast.warning('A session encountered an error.');
        } else if (status === 'terminated') {
          this.toast.info('A session has been terminated.');
        }
      },
    );
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
    }
    // Unsubscribe from WebSocket events (do NOT disconnect — other components
    // may still be using the shared service).
    this.wsSessionSub?.unsubscribe();
  }

  // ── Template event handlers ──────────────────────────────────────────────

  /**
   * Open the launch dialog for a given platform.
   * @param platform The target platform.
   */
  protected openDialog(platform: Platform): void {
    this.dialogPlatform.set(platform);
  }

  /** Close the launch dialog. */
  protected closeDialog(): void {
    this.dialogPlatform.set(null);
  }

  /**
   * Navigate to an existing session.
   * @param sessionId The session UUID.
   */
  protected connectToSession(sessionId: string): void {
    void this.router.navigate(['/session', sessionId]);
  }

  /**
   * Stop a session via the API, then refresh the sessions list.
   * @param sessionId The session UUID to terminate.
   */
  protected stopSession(sessionId: string): void {
    const current = new Set(this.stoppingSessions());
    current.add(sessionId);
    this.stoppingSessions.set(current);

    this.api.deleteSession(sessionId).subscribe({
      next: () => {
        const updated = new Set(this.stoppingSessions());
        updated.delete(sessionId);
        this.stoppingSessions.set(updated);
        this.toast.success('Session stopped successfully.');
        this.loadSessions();
      },
      error: () => {
        const updated = new Set(this.stoppingSessions());
        updated.delete(sessionId);
        this.stoppingSessions.set(updated);
        this.toast.error('Failed to stop session. Please try again.');
      },
    });
  }

  /**
   * Returns true if a stop request is in-flight for a given session.
   * @param sessionId The session UUID.
   */
  protected isStopping(sessionId: string): boolean {
    return this.stoppingSessions().has(sessionId);
  }

  /** Toggle the session history panel open/closed. */
  protected toggleHistory(): void {
    this.showHistory.update((v) => !v);
  }

  /**
   * Returns a human-readable duration string for a session.
   * @param createdAt ISO timestamp from the session.
   */
  protected sessionDuration(createdAt: string): string {
    const diffMs = Date.now() - new Date(createdAt).getTime();
    const totalSecs = Math.floor(diffMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

  /**
   * Returns the platform icon emoji for a session.
   * @param platform The session platform.
   */
  protected platformIcon(platform: Platform): string {
    return platform === 'ios' ? '🍎' : '🤖';
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Fetch the current sessions list from the API. */
  private loadSessions(): void {
    this.api.getSessions().subscribe({
      next: (response) => {
        if (response.success && response.data) {
          const { sessions, capacity } = response.data;
          this.allSessions.set(sessions);
          // Show all non-terminated sessions as "active"
          const nonTerminated = sessions.filter(
            (s) => s.status !== 'terminated',
          );
          this.activeSessions.set(nonTerminated);
          this.capacity.set(capacity);
          this.sessionsError.set('');
        } else {
          this.sessionsError.set(
            response.error?.message ?? 'Failed to load sessions.',
          );
        }
        this.sessionsLoading.set(false);
      },
      error: (err: unknown) => {
        this.sessionsLoading.set(false);
        // Only show errors for non-network failures (server returned an error).
        // Network errors (status 0) are silently handled since the backend
        // may not be running yet.
        if (err instanceof HttpErrorResponse && err.status === 0) {
          this.sessionsError.set('');
        } else if (err instanceof HttpErrorResponse) {
          const body = err.error as { error?: { message?: string } } | null;
          this.sessionsError.set(
            body?.error?.message ?? `Server error (${err.status})`,
          );
          this.toast.error(this.sessionsError());
        } else {
          this.sessionsError.set('Failed to load sessions.');
          this.toast.error(this.sessionsError());
        }
      },
    });
  }
}
