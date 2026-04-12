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
import { ToastService } from '../../core/services/toast.service';
import {
  DeviceOrientation,
  Session,
  SessionStatus,
  SimulatorButton,
} from '../../core/types/api.types';
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

  /** Whether a file upload is in progress. */
  protected readonly uploading = signal<boolean>(false);

  /** Result message from the last upload attempt. */
  protected readonly uploadMessage = signal<string>('');

  /** Whether the last upload was successful (for styling). */
  protected readonly uploadSuccess = signal<boolean>(false);

  /** Whether a file is being dragged over the drop zone. */
  protected readonly dragOver = signal<boolean>(false);

  /** Whether a device control action is in-flight. */
  protected readonly controlBusy = signal<boolean>(false);

  /** Current device orientation (client-side tracking). */
  protected readonly currentOrientation = signal<DeviceOrientation>('portrait');

  /** File input accept attribute based on platform. */
  protected readonly acceptedFileTypes = computed<string>(() => {
    const s = this.session();
    if (!s) return '';
    return s.device.platform === 'ios' ? '.app,.ipa' : '.apk';
  });

  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
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
        this.toast.error(message);
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

  /**
   * Handle file selection from the file input or drag-and-drop.
   * Uploads the file to the session's simulator/emulator.
   * @param event The file input change event or a direct File.
   */
  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploadFile(file);

    // Reset the input so the same file can be re-selected
    input.value = '';
  }

  /**
   * Handle files dropped onto the drop zone.
   * @param event The drag-and-drop event.
   */
  protected onFileDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOver.set(false);

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    this.uploadFile(file);
  }

  /** Prevent default drag behavior and track drag state. */
  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOver.set(true);
  }

  /** Track drag leave state. */
  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOver.set(false);
  }

  // ── Device Control handlers ──────────────────────────────────────────────────

  /**
   * Press a hardware button on the simulator.
   * @param button The button to press.
   */
  protected onPressButton(button: SimulatorButton): void {
    const currentSession = this.session();
    if (!currentSession) return;

    this.controlBusy.set(true);
    this.api.pressButton(currentSession.id, button).subscribe({
      next: (response) => {
        this.controlBusy.set(false);
        if (!response.success) {
          this.toast.error(response.error?.message ?? `Failed to press ${button}.`);
        }
      },
      error: (err: unknown) => {
        this.controlBusy.set(false);
        const message = err instanceof Error ? err.message : `Failed to press ${button}.`;
        this.toast.error(message);
      },
    });
  }

  /**
   * Set the device orientation.
   * @param orientation Target orientation.
   */
  protected onRotate(orientation: DeviceOrientation): void {
    const currentSession = this.session();
    if (!currentSession) return;

    this.controlBusy.set(true);
    this.api.setOrientation(currentSession.id, orientation).subscribe({
      next: (response) => {
        this.controlBusy.set(false);
        if (response.success) {
          this.currentOrientation.set(orientation);
        } else {
          this.toast.error(response.error?.message ?? 'Failed to rotate device.');
        }
      },
      error: (err: unknown) => {
        this.controlBusy.set(false);
        const message = err instanceof Error ? err.message : 'Failed to rotate device.';
        this.toast.error(message);
      },
    });
  }

  /**
   * Trigger a shake gesture on the device.
   */
  protected onShake(): void {
    const currentSession = this.session();
    if (!currentSession) return;

    this.controlBusy.set(true);
    this.api.shakeDevice(currentSession.id).subscribe({
      next: (response) => {
        this.controlBusy.set(false);
        if (!response.success) {
          this.toast.error(response.error?.message ?? 'Failed to trigger shake.');
        }
      },
      error: (err: unknown) => {
        this.controlBusy.set(false);
        const message = err instanceof Error ? err.message : 'Failed to trigger shake.';
        this.toast.error(message);
      },
    });
  }

  /**
   * Take a screenshot and download it as a PNG file.
   */
  protected onScreenshot(): void {
    const currentSession = this.session();
    if (!currentSession) return;

    this.controlBusy.set(true);
    this.api.takeScreenshot(currentSession.id).subscribe({
      next: (blob: Blob) => {
        this.controlBusy.set(false);
        // Trigger a browser download of the returned PNG blob
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `screenshot-${currentSession.id}-${Date.now()}.png`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
        this.toast.success('Screenshot saved.');
      },
      error: (err: unknown) => {
        this.controlBusy.set(false);
        const message = err instanceof Error ? err.message : 'Failed to take screenshot.';
        this.toast.error(message);
      },
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Upload a file to the session API and handle the response.
   * @param file The file to upload.
   */
  private uploadFile(file: File): void {
    const currentSession = this.session();
    if (!currentSession) return;

    // Quick client-side extension validation
    const platform = currentSession.device.platform;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const allowedExts = platform === 'ios' ? ['app', 'ipa'] : ['apk'];
    if (!allowedExts.includes(ext)) {
      this.uploadMessage.set(`Invalid file type ".${ext}". Allowed: ${allowedExts.map(e => '.' + e).join(', ')}`);
      this.uploadSuccess.set(false);
      return;
    }

    this.uploading.set(true);
    this.uploadMessage.set('');
    this.uploadSuccess.set(false);

    this.api.uploadApp(currentSession.id, file).subscribe({
      next: (response) => {
        this.uploading.set(false);
        if (response.success && response.data) {
          this.uploadMessage.set(response.data.result.message);
          this.uploadSuccess.set(response.data.result.success);
          if (response.data.result.success) {
            this.toast.success(`App installed: ${response.data.result.fileName}`);
          } else {
            this.toast.warning(response.data.result.message);
          }
        } else {
          this.uploadMessage.set(response.error?.message ?? 'Upload failed.');
          this.uploadSuccess.set(false);
          this.toast.error(response.error?.message ?? 'Upload failed.');
        }
      },
      error: (err: unknown) => {
        this.uploading.set(false);
        const message = err instanceof Error ? err.message : 'Upload failed. Please try again.';
        this.uploadMessage.set(message);
        this.toast.error(message);
        this.uploadSuccess.set(false);
      },
    });
  }

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

          const loadedSession = response.data.session;
          this.session.set(loadedSession);

          if (this.isTerminalStatus(loadedSession.status)) {
            this.loading.set(false);
            if (loadedSession.status === 'error') {
              this.errorMessage.set('Session encountered an error.');
              this.toast.error('Session encountered an error and cannot recover.');
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
            this.toast.warning('Session is taking too long to start. Please check the backend.');
            this.loading.set(false);
            this.stopPolling();
          }
        },
        error: (err: unknown) => {
          const message =
            err instanceof Error ? err.message : 'Network error loading session.';
          this.errorMessage.set(message);
          this.toast.error(message);
          this.loading.set(false);
        },
      });

    // Trigger the first fetch immediately (do not wait for first interval tick)
    this.api.getSession(sessionId).subscribe({
      next: (response) => {
        if (!response.success || !response.data) return;
        this.session.set(response.data.session);
        if (response.data.session.status === 'active' && response.data.session.streamUrl) {
          this.loading.set(false);
          this.stopPolling();
        } else if (this.isTerminalStatus(response.data.session.status)) {
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
