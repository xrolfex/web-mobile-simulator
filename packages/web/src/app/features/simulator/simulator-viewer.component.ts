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

/** Connection state of the streaming session. */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Scale mode for the canvas display. */
export type ScaleMode = 'auto' | '1x' | '0.75x' | '0.5x';

/**
 * SimulatorViewerComponent
 *
 * Renders a live simulator display by receiving JPEG/PNG frames over a
 * WebSocket connection and painting them onto an HTML <canvas>.
 *
 * Touch and click events on the canvas are captured, normalized to 0–1
 * coordinates relative to the device screen dimensions, and sent back
 * through the WebSocket as JSON messages for server-side input injection.
 */
@Component({
  selector: 'app-simulator-viewer',
  standalone: true,
  imports: [TitleCasePipe],
  templateUrl: './simulator-viewer.component.html',
  styleUrl: './simulator-viewer.component.scss',
})
export class SimulatorViewerComponent implements AfterViewInit, OnDestroy {
  /** WebSocket URL to connect to (e.g. /ws/stream/<sessionId>). */
  @Input({ required: true }) wsUrl!: string;

  /** Platform being displayed — affects UI chrome. */
  @Input() platform: 'ios' | 'android' = 'ios';

  /** Emitted whenever the connection state changes. */
  @Output() connectionStateChange = new EventEmitter<ConnectionState>();

  /** Emitted when the user clicks the Disconnect button. */
  @Output() disconnectRequest = new EventEmitter<void>();

  /** @ViewChild reference to the canvas element. */
  @ViewChild('displayCanvas')
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** Current connection state, exposed to the template as a signal. */
  protected readonly connectionState = signal<ConnectionState>('connecting');

  /** Human-readable error message shown when state === 'error'. */
  protected readonly errorMessage = signal<string>('');

  /** Current scale mode selection. */
  protected readonly scaleMode = signal<ScaleMode>('auto');

  /** Current FPS counter (updated every second). */
  protected readonly fps = signal<number>(0);

  /** Native device screen dimensions from the last received frame. */
  protected readonly frameWidth = signal<number>(0);
  protected readonly frameHeight = signal<number>(0);

  private ws: WebSocket | null = null;
  private readonly ngZone = inject(NgZone);

  // FPS tracking
  private frameCount = 0;
  private fpsInterval: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    this.connect();
    // Start FPS counter
    this.fpsInterval = setInterval(() => {
      this.ngZone.run(() => {
        this.fps.set(this.frameCount);
      });
      this.frameCount = 0;
    }, 1000);
  }

  ngOnDestroy(): void {
    this.disconnect();
    if (this.fpsInterval) {
      clearInterval(this.fpsInterval);
      this.fpsInterval = null;
    }
  }

  // ── Template event handlers ────────────────────────────────────────────

  /** Tear down the existing connection and open a fresh one. */
  protected reconnect(): void {
    this.disconnect();
    this.connectionState.set('connecting');
    this.errorMessage.set('');
    this.connect();
  }

  /** Disconnect and emit the disconnect request event. */
  protected onDisconnect(): void {
    this.disconnect();
    this.disconnectRequest.emit();
  }

  /** Handle scale-mode selection from the toolbar <select>. */
  protected onScaleModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const mode = select.value as ScaleMode;
    this.scaleMode.set(mode);
    this.applyScaleMode();
  }

  /**
   * Handle click/tap on the canvas — forward as a touch event to the server.
   * Normalizes coordinates to 0–1 range relative to the device screen.
   */
  protected onCanvasClick(event: MouseEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();

    // Calculate position relative to canvas display area
    const displayX = event.clientX - rect.left;
    const displayY = event.clientY - rect.top;

    // Normalize to 0–1 based on the canvas display size
    const x = displayX / rect.width;
    const y = displayY / rect.height;

    // Only send if within bounds
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      this.ws.send(
        JSON.stringify({
          type: 'touch',
          action: 'tap',
          x,
          y,
          // Include raw device pixel coordinates for backends that need them
          deviceX: Math.round(x * this.frameWidth()),
          deviceY: Math.round(y * this.frameHeight()),
        }),
      );
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Create a WebSocket connection and wire up binary frame handling.
   */
  private connect(): void {
    const url = this.resolveWsUrl();

    this.ngZone.runOutsideAngular(() => {
      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.ngZone.run(() => {
            this.setConnectionState('connected');
          });
        };

        this.ws.onmessage = (event: MessageEvent) => {
          // Binary messages are frames (JPEG/PNG)
          if (event.data instanceof ArrayBuffer) {
            this.renderFrame(event.data);
          }
          // Text messages could be control responses (ignore for now)
        };

        this.ws.onclose = (event: CloseEvent) => {
          this.ngZone.run(() => {
            if (event.wasClean) {
              this.setConnectionState('disconnected');
            } else {
              this.errorMessage.set(event.reason || 'Connection lost');
              this.setConnectionState('error');
            }
          });
        };

        this.ws.onerror = () => {
          this.ngZone.run(() => {
            this.errorMessage.set('WebSocket connection failed');
            this.setConnectionState('error');
          });
        };
      } catch (err: unknown) {
        this.ngZone.run(() => {
          const message =
            err instanceof Error ? err.message : 'Failed to connect';
          this.errorMessage.set(message);
          this.setConnectionState('error');
        });
      }
    });
  }

  /**
   * Render a binary frame (JPEG/PNG) onto the canvas.
   * Uses createImageBitmap for efficient off-main-thread decoding.
   */
  private renderFrame(data: ArrayBuffer): void {
    const blob = new Blob([data]); // browser auto-detects JPEG vs PNG

    createImageBitmap(blob)
      .then((bitmap) => {
        const canvas = this.canvasRef?.nativeElement;
        if (!canvas) return;

        // Update canvas size to match frame if changed
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          this.ngZone.run(() => {
            this.frameWidth.set(bitmap.width);
            this.frameHeight.set(bitmap.height);
            this.applyScaleMode();
          });
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close(); // free memory
        }

        this.frameCount++;
      })
      .catch(() => {
        // Ignore decode errors for individual frames — next frame will come soon
      });
  }

  /**
   * Resolve wsUrl to a fully-qualified WebSocket URL.
   *
   * If wsUrl is already an absolute WebSocket URL (ws:// or wss://) it is
   * returned unchanged. Otherwise it is treated as a path relative to the
   * current page origin and expanded using the appropriate protocol:
   * - https: pages → wss:
   * - http:  pages → ws:
   */
  private resolveWsUrl(): string {
    if (this.wsUrl.startsWith('ws://') || this.wsUrl.startsWith('wss://')) {
      return this.wsUrl;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.wsUrl}`;
  }

  /**
   * Close the WebSocket connection.
   * Safe to call multiple times.
   */
  private disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore errors during cleanup
      }
      this.ws = null;
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
   * Apply the current scale mode to the canvas container.
   * In 'auto' mode, the canvas CSS is set to fill the container while
   * maintaining aspect ratio via max-width/max-height (controlled in SCSS).
   * In fixed modes (1x, 0.75x, 0.5x), a CSS transform is applied.
   */
  private applyScaleMode(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const mode = this.scaleMode();

    if (mode === 'auto') {
      // CSS handles scaling via max-width/max-height on the canvas
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
      canvas.style.width = '';
      canvas.style.height = '';
    } else {
      const scaleFactors: Record<ScaleMode, number> = {
        auto: 1,
        '1x': 1,
        '0.75x': 0.75,
        '0.5x': 0.5,
      };
      const scale = scaleFactors[mode];
      canvas.style.transformOrigin = 'top left';
      canvas.style.transform = `scale(${scale})`;
    }
  }
}
