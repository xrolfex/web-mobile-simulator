import {
  Component,
  OnInit,
  OnDestroy,
  signal,
  inject,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';

import { ApiService } from '../../core/services/api.service';
import { Session, SessionStatus } from '../../core/types/api.types';
import { SimulatorViewerComponent } from './simulator-viewer.component';
import type { ConnectionState } from './simulator-viewer.component';

/** How often (ms) to poll the session endpoint while waiting for it to become active. */
const POLL_INTERVAL_MS = 2_000;

/** Maximum number of poll attempts before giving up. */
const MAX_POLL_ATTEMPTS = 30;

/**
 * SimulatorSessionComponent
 *
 * Session lifecycle wrapper for a single simulator session identified by the
 * `:id` route parameter.
 *
 * - Polls the API until the session is `active` and has a `streamUrl`.
 * - Renders `SimulatorViewerComponent` once the stream URL is known.
 * - Provides a "Stop Session" button that calls the API and navigates away.
 */
@Component({
  selector: 'app-simulator-session',
  standalone: true,
  imports: [SimulatorViewerComponent],
  templateUrl: './simulator-session.component.html',
  styleUrl: './simulator-session.component.scss',
})
export class SimulatorSessionComponent implements OnInit, OnDestroy {
  /** The loaded session, null while loading. */
  protected readonly session = signal<Session | null>(null);

  /** Whether the initial load / polling is in progress. */
  protected readonly loading = signal<boolean>(true);

  /** Human-readable error message, empty when no error. */
  protected readonly errorMessage = signal<string>('');

  /** VNC connection state forwarded from the viewer child. */
  protected readonly vncState = signal<ConnectionState>('connecting');

  /** Whether a stop-session request is in-flight. */
  protected readonly stopping = signal<boolean>(false);

  /** Platform icon derived from the loaded session. */
  protected readonly platformIcon = computed<string>(() => {
    const s = this.session();
    if (!s) return '';
    return s.device.platform === 'ios' ? '🍎' : '🤖';
  });

  /** Whether the session is ready to stream (active + streamUrl present). */
  protected readonly isReady = computed<boolean>(() => {
    const s = this.session();
    return s?.status === 'active' && !!s.streamUrl;
  });

  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private pollSubscription: Subscription | null = null;
  private pollAttempts = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngOnInit(): void {
    const sessionId = this.route.snapshot.paramMap.get('id');
    if (!sessionId) {
      this.errorMessage.set('No session ID provided in the route.');
      this.loading.set(false);
      return;
    }

    this.startPolling(sessionId);
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  // ── Template event handlers ────────────────────────────────────────────────

  /**
   * Terminate the session via the API and navigate back to the dashboard.
   */
  protected async stopSession(): Promise<void> {
    const currentSession = this.session();
    if (!currentSession) return;

    this.stopping.set(true);
    this.api.deleteSession(currentSession.id).subscribe({
      next: () => {
        void this.router.navigate(['/']);
      },
      error: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to stop the session.';
        this.errorMessage.set(message);
        this.stopping.set(false);
      },
    });
  }

  /** Navigate back to dashboard without stopping the session. */
  protected goToDashboard(): void {
    void this.router.navigate(['/']);
  }

  /**
   * Handle VNC connection state changes emitted by SimulatorViewerComponent.
   * @param state The new connection state.
   */
  protected onVncStateChange(state: ConnectionState): void {
    this.vncState.set(state);
  }

  /**
   * Handle user-initiated disconnect from the VNC viewer.
   * Terminates the session and navigates home.
   */
  protected onViewerDisconnect(): void {
    void this.stopSession();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Poll the session endpoint until it is active or the attempt limit is hit.
   * @param sessionId The session UUID to poll.
   */
  private startPolling(sessionId: string): void {
    this.pollAttempts = 0;

    this.pollSubscription = interval(POLL_INTERVAL_MS)
      .pipe(
        switchMap(() => this.api.getSession(sessionId)),
        takeWhile(() => {
          this.pollAttempts++;
          return this.pollAttempts <= MAX_POLL_ATTEMPTS;
        }, true /* inclusive — emit one final value */),
      )
      .subscribe({
        next: (response) => {
          if (!response.success || !response.data) {
            const code = response.error?.message ?? 'Unknown error';
            this.errorMessage.set(`Failed to load session: ${code}`);
            this.loading.set(false);
            this.stopPolling();
            return;
          }

          const loadedSession = response.data;
          this.session.set(loadedSession);

          if (this.isTerminalStatus(loadedSession.status)) {
            this.loading.set(false);
            if (loadedSession.status === 'error') {
              this.errorMessage.set('Session encountered an error.');
            }
            this.stopPolling();
            return;
          }

          if (loadedSession.status === 'active' && loadedSession.streamUrl) {
            this.loading.set(false);
            this.stopPolling();
            return;
          }

          // Still creating — check attempt limit
          if (this.pollAttempts >= MAX_POLL_ATTEMPTS) {
            this.errorMessage.set('Session is taking too long to start.');
            this.loading.set(false);
            this.stopPolling();
          }
        },
        error: (err: unknown) => {
          const message =
            err instanceof Error ? err.message : 'Network error loading session.';
          this.errorMessage.set(message);
          this.loading.set(false);
        },
      });

    // Trigger the first fetch immediately (do not wait for first interval tick)
    this.api.getSession(sessionId).subscribe({
      next: (response) => {
        if (!response.success || !response.data) return;
        this.session.set(response.data);
        if (response.data.status === 'active' && response.data.streamUrl) {
          this.loading.set(false);
          this.stopPolling();
        } else if (this.isTerminalStatus(response.data.status)) {
          this.loading.set(false);
          this.stopPolling();
        }
      },
    });
  }

  /** Cancel the polling subscription. */
  private stopPolling(): void {
    if (this.pollSubscription) {
      this.pollSubscription.unsubscribe();
      this.pollSubscription = null;
    }
  }

  /**
   * Returns true for session states that will never transition to `active`.
   * @param status The session status to check.
   */
  private isTerminalStatus(status: SessionStatus): boolean {
    return status === 'terminated' || status === 'terminating' || status === 'error';
  }
}
