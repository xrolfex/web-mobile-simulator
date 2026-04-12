import {
  Component,
  Input,
  Output,
  EventEmitter,
  ElementRef,
  ViewChild,
  OnDestroy,
  AfterViewInit,
  signal,
  inject,
  NgZone,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import RFB from '@novnc/novnc';
import type { RFBDisconnectEvent } from '@novnc/novnc';

/** Connection state of the VNC session. */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Scale mode for the VNC canvas display. */
export type ScaleMode = 'auto' | '1x' | '0.75x' | '0.5x';

/**
 * SimulatorViewerComponent
 *
 * Wraps the noVNC `RFB` library to display an interactive VNC stream inside
 * a resizable container. Handles connection lifecycle, scaling, and exposes
 * outputs for state changes and user-initiated disconnect.
 */
@Component({
  selector: 'app-simulator-viewer',
  standalone: true,
  imports: [TitleCasePipe],
  templateUrl: './simulator-viewer.component.html',
  styleUrl: './simulator-viewer.component.scss',
})
export class SimulatorViewerComponent implements AfterViewInit, OnDestroy {
  /** WebSocket URL to connect to (e.g. /ws/vnc/<sessionId> or ws://localhost:6900). */
  @Input({ required: true }) wsUrl!: string;

  /** Platform being displayed — affects UI chrome (device frame styles). */
  @Input() platform: 'ios' | 'android' = 'ios';

  /** Emitted whenever the connection state changes. */
  @Output() connectionStateChange = new EventEmitter<ConnectionState>();

  /** Emitted when the user clicks the Disconnect button. */
  @Output() disconnectRequest = new EventEmitter<void>();

  /** @ViewChild reference to the element noVNC renders into. */
  @ViewChild('vncContainer')
  private readonly vncContainerRef!: ElementRef<HTMLDivElement>;

  /** Current connection state, exposed to the template as a signal. */
  protected readonly connectionState = signal<ConnectionState>('connecting');

  /** Human-readable error message shown when state === 'error'. */
  protected readonly errorMessage = signal<string>('');

  /** Current scale mode selection. */
  protected readonly scaleMode = signal<ScaleMode>('auto');

  /** Desktop name reported by the VNC server. */
  protected readonly desktopName = signal<string>('');

  private rfb: RFB | null = null;
  private readonly ngZone = inject(NgZone);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    this.connect();
  }

  ngOnDestroy(): void {
    this.destroyRfb();
  }

  // ── Template event handlers ────────────────────────────────────────────────

  /** Tear down the existing connection and open a fresh one. */
  protected reconnect(): void {
    this.destroyRfb();
    this.connectionState.set('connecting');
    this.errorMessage.set('');
    this.connect();
  }

  /** Disconnect and emit the disconnect request event. */
  protected onDisconnect(): void {
    this.destroyRfb();
    this.disconnectRequest.emit();
  }

  /** Handle scale-mode selection from the toolbar <select>. */
  protected onScaleModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const mode = select.value as ScaleMode;
    this.scaleMode.set(mode);
    this.applyScaleMode(mode);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Create an RFB instance and wire up its event listeners.
   *
   * Runs the RFB constructor outside Angular's zone to avoid triggering
   * unnecessary change-detection cycles from noVNC's high-frequency internal
   * events.
   */
  private connect(): void {
    const container = this.vncContainerRef.nativeElement;

    this.ngZone.runOutsideAngular(() => {
      try {
        this.rfb = new RFB(container, this.resolveWsUrl(), {
          scaleViewport: this.scaleMode() === 'auto',
          resizeSession: false,
          credentials: { password: '' },
        });

        this.rfb.addEventListener('connect', () => {
          this.ngZone.run(() => {
            this.setConnectionState('connected');
            this.applyScaleMode(this.scaleMode());
          });
        });

        this.rfb.addEventListener('disconnect', (ev: RFBDisconnectEvent) => {
          this.ngZone.run(() => {
            if (ev.detail.clean) {
              this.setConnectionState('disconnected');
            } else {
              const reason = ev.detail.reason ?? 'Unexpected disconnection';
              this.errorMessage.set(reason);
              this.setConnectionState('error');
            }
          });
        });

        this.rfb.addEventListener('desktopname', (ev) => {
          this.ngZone.run(() => {
            this.desktopName.set(ev.detail.name);
          });
        });

        this.rfb.addEventListener('securityfailure', (ev) => {
          this.ngZone.run(() => {
            const reason =
              ev.detail.reason ??
              `Security failure (status ${ev.detail.status})`;
            this.errorMessage.set(reason);
            this.setConnectionState('error');
          });
        });
      } catch (err: unknown) {
        this.ngZone.run(() => {
          const message =
            err instanceof Error ? err.message : 'Failed to initialise VNC';
          this.errorMessage.set(message);
          this.setConnectionState('error');
        });
      }
    });
  }

  /**
   * Resolve `wsUrl` to a fully-qualified WebSocket URL.
   *
   * If `wsUrl` is already an absolute WebSocket URL (`ws://` or `wss://`) it
   * is returned unchanged.  Otherwise it is treated as a path relative to the
   * current page origin and expanded using the appropriate protocol:
   * - `https:` pages → `wss:`
   * - `http:` pages  → `ws:`
   *
   * This allows the server to return a compact path like `/ws/vnc/<sessionId>`
   * that the browser resolves against its own origin, so the connection is
   * automatically routed through the same nginx proxy that serves the app.
   */
  private resolveWsUrl(): string {
    if (this.wsUrl.startsWith('ws://') || this.wsUrl.startsWith('wss://')) {
      return this.wsUrl;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.wsUrl}`;
  }

  /**
   * Disconnect and nullify the RFB instance without emitting an event.
   * Safe to call multiple times.
   */
  private destroyRfb(): void {
    if (this.rfb) {
      try {
        this.rfb.disconnect();
      } catch {
        // Ignore errors during cleanup — the connection may already be gone.
      }
      this.rfb = null;
    }
  }

  /**
   * Update the connection-state signal and emit the change output.
   * @param state New connection state.
   */
  private setConnectionState(state: ConnectionState): void {
    this.connectionState.set(state);
    this.connectionStateChange.emit(state);
  }

  /**
   * Apply a scale mode to the active RFB session.
   * @param mode The selected scale mode.
   */
  private applyScaleMode(mode: ScaleMode): void {
    if (!this.rfb) return;

    if (mode === 'auto') {
      this.rfb.scaleViewport = true;
      this.rfb.clipViewport = false;
    } else {
      this.rfb.scaleViewport = false;
      this.rfb.clipViewport = false;

      const container = this.vncContainerRef?.nativeElement;
      if (!container) return;

      const scaleFactors: Record<ScaleMode, number> = {
        auto: 1,
        '1x': 1,
        '0.75x': 0.75,
        '0.5x': 0.5,
      };
      const scale = scaleFactors[mode];

      // Apply CSS transform to the noVNC canvas wrapper (first child element).
      const child = container.firstElementChild as HTMLElement | null;
      if (child) {
        child.style.transformOrigin = 'top left';
        child.style.transform = `scale(${scale})`;
        child.style.width = `${100 / scale}%`;
        child.style.height = `${100 / scale}%`;
      }
    }
  }
}
