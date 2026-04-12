import {
  Component,
  OnInit,
  OnDestroy,
  signal,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';

import { ApiService } from '../../core/services/api.service';
import { LaunchDialogComponent } from './launch-dialog.component';
import type { Platform, Session } from '../../core/types/api.types';
/** How often (ms) to auto-refresh the active sessions list. */
const SESSION_REFRESH_INTERVAL_MS = 10_000;

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

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.loadSessions();
    this.refreshTimer = setInterval(
      () => this.loadSessions(),
      SESSION_REFRESH_INTERVAL_MS,
    );
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
    }
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
        this.loadSessions();
      },
      error: () => {
        const updated = new Set(this.stoppingSessions());
        updated.delete(sessionId);
        this.stoppingSessions.set(updated);
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
          // Show all non-terminated sessions
          const nonTerminated = response.data.filter(
            (s) => s.status !== 'terminated',
          );
          this.activeSessions.set(nonTerminated);
          this.sessionsError.set('');
        } else {
          this.sessionsError.set(
            response.error?.message ?? 'Failed to load sessions.',
          );
        }
        this.sessionsLoading.set(false);
      },
      error: () => {
        // Backend not running — silently show empty list after first attempt
        this.sessionsLoading.set(false);
        this.sessionsError.set('');
      },
    });
  }
}
