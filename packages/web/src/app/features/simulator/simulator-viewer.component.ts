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
  effect,
  input,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { WebCodecsService } from '../../core/services/webcodecs.service';
import { DeviceBezelComponent } from '../../shared/components/device-bezel/device-bezel.component';

/** Connection state of the streaming session. */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Scale mode for the canvas display. */
export type ScaleMode = 'auto' | '1x' | '0.75x' | '0.5x';

/**
 * Stream rendering mode.
 * - `'webcodecs'` – H.264 video via WebCodecs (primary path, iOS preferred).
 * - `'mjpeg'` – JPEG frames over WebSocket canvas (fallback, Android / error cases).
 */
export type StreamMode = 'webcodecs' | 'mjpeg';

/**
 * SimulatorViewerComponent
 *
 * Renders a live simulator display via one of two modes:
 *
 * **MJPEG mode** (default): receives JPEG/PNG frames over a WebSocket and
 * paints them onto an HTML `<canvas>`.
 *
 * **WebCodecs mode**: uses `WebCodecsService` to establish an H.264 stream
 * over WebSocket and renders decoded frames onto an HTML `<canvas>`.
 *
 * Touch, pointer, and keyboard events on the canvas element are captured,
 * normalized to 0–1 coordinates, and sent back over a WebSocket
 * (the MJPEG stream socket in MJPEG mode, the WebSocket returned by
 * `WebCodecsService.connect()` in WebCodecs mode) as JSON messages for
 * server-side input injection.
 */
@Component({
  selector: 'app-simulator-viewer',
  standalone: true,
  imports: [TitleCasePipe, DeviceBezelComponent],
  templateUrl: './simulator-viewer.component.html',
  styleUrl: './simulator-viewer.component.scss',
})
export class SimulatorViewerComponent implements AfterViewInit, OnDestroy {
  /** WebSocket URL to connect to (e.g. `/ws/stream/<sessionId>`). Required in both modes. */
  @Input({ required: true }) wsUrl!: string;

  /**
   * WMS session UUID used for WebCodecs streaming.
   * Must be provided when `streamMode === 'webcodecs'`.
   */
  @Input() sessionId: string = '';

  /**
   * Which rendering path to use.
   * - `'webcodecs'` – H.264 decoded via `WebCodecsService`; frames rendered to `<canvas>`.
   * - `'mjpeg'` – JPEG frames painted to `<canvas>` over WebSocket (default).
   */
  readonly streamMode = input<StreamMode>('mjpeg');

  /** Platform being displayed — affects UI chrome. */
  @Input() platform: 'ios' | 'android' = 'ios';

  /** Emitted whenever the connection state changes. */
  @Output() connectionStateChange = new EventEmitter<ConnectionState>();

  /** Emitted when the user clicks the Disconnect button. */
  @Output() disconnectRequest = new EventEmitter<void>();

  // ── ViewChild references ──────────────────────────────────────────────────

  /** @ViewChild reference to the canvas element used for both MJPEG and WebCodecs modes. */
  @ViewChild('displayCanvas')
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** @ViewChild reference to the bezel stage container used for ResizeObserver-based scaling. */
  @ViewChild('bezelStage')
  private readonly bezelStageRef!: ElementRef<HTMLDivElement>;

  // ── Public signals (template-accessible) ─────────────────────────────────

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

  // ── Private state ─────────────────────────────────────────────────────────

  /**
   * The MJPEG WebSocket.
   * In MJPEG mode this is both the stream source and the input channel.
   * In WebCodecs mode this is `null` (a dedicated `inputWs` is used instead).
   */
  private ws: WebSocket | null = null;

  /**
   * The WebSocket used exclusively to send JSON input events (tap, swipe, key).
   *
   * - In **MJPEG mode**: shares the same reference as `ws` (set inside `connect()`).
   * - In **WebCodecs mode**: the WebSocket returned by `WebCodecsService.connect()`,
   *   used to forward input commands to the server.
   */
  private inputWs: WebSocket | null = null;

  private readonly ngZone = inject(NgZone);
  private readonly webCodecsService = inject(WebCodecsService);

  // FPS tracking
  private frameCount = 0;
  private fpsInterval: ReturnType<typeof setInterval> | null = null;

  /** ResizeObserver that re-applies scale when the bezel stage container resizes. */
  private resizeObserver: ResizeObserver | null = null;

  /**
   * Minimum pointer displacement (in CSS pixels) required to classify
   * a pointer-down/up sequence as a swipe rather than a tap.
   */
  private readonly SWIPE_THRESHOLD_PX = 10;

  /** Recorded position at the start of a pointer-down event. */
  private dragStart: {
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null = null;

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor() {
    // Mirror WebCodecs service connection state to component state when in webcodecs mode.
    effect(() => {
      if (this.streamMode() !== 'webcodecs') return;

      const state = this.webCodecsService.connectionState();
      switch (state) {
        case 'connected':
          this.setConnectionState('connected');
          this.canvasRef?.nativeElement?.focus();
          break;
        case 'connecting':
          this.setConnectionState('connecting');
          break;
        case 'disconnected':
          this.setConnectionState('disconnected');
          break;
        case 'error':
          this.errorMessage.set(this.webCodecsService.errorMessage());
          this.setConnectionState('error');
          break;
      }
    });

    // Mirror frame dimensions from WebCodecs service when in webcodecs mode.
    effect(() => {
      if (this.streamMode() !== 'webcodecs') return;
      const w = this.webCodecsService.frameWidth();
      const h = this.webCodecsService.frameHeight();
      if (w > 0 && h > 0) {
        this.frameWidth.set(w);
        this.frameHeight.set(h);
        this.applyScaleMode();
      }
    });

    // Mirror FPS from WebCodecs service when in webcodecs mode.
    effect(() => {
      if (this.streamMode() !== 'webcodecs') return;
      this.fps.set(this.webCodecsService.fps());
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    if (this.streamMode() === 'webcodecs') {
      this.connectWebCodecs();
    } else {
      this.connect();
    }

    // Only start the FPS counter interval for MJPEG mode.
    // In WebCodecs mode, FPS comes from the WebCodecsService via effect.
    if (this.streamMode() !== 'webcodecs') {
      this.fpsInterval = setInterval(() => {
        this.ngZone.run(() => {
          this.fps.set(this.frameCount);
        });
        this.frameCount = 0;
      }, 1000);
    }

    // Set up ResizeObserver to re-apply scale when the stage container resizes
    const stageEl = this.bezelStageRef?.nativeElement;
    if (stageEl && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.ngZone.run(() => this.applyScaleMode());
      });
      this.resizeObserver.observe(stageEl);
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
    if (this.fpsInterval) {
      clearInterval(this.fpsInterval);
      this.fpsInterval = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // ── Template event handlers ────────────────────────────────────────────────

  /** Tear down the existing connection and open a fresh one. */
  protected reconnect(): void {
    this.disconnect();
    this.connectionState.set('connecting');
    this.errorMessage.set('');
    if (this.streamMode() === 'webcodecs') {
      this.connectWebCodecs();
    } else {
      this.connect();
    }
  }

  /** Disconnect and emit the disconnect request event. */
  protected onDisconnect(): void {
    this.disconnect();
    this.disconnectRequest.emit();
  }

  /** Handle scale-mode selection from the toolbar `<select>`. */
  protected onScaleModeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const mode = select.value as ScaleMode;
    this.scaleMode.set(mode);
    this.applyScaleMode();
  }

  /**
   * Handle pointer-down on the display element.
   *
   * Records the drag start position and captures the pointer so that
   * subsequent `pointermove`/`pointerup` events fire even if the pointer
   * leaves the element boundary.
   */
  protected onCanvasPointerDown(event: PointerEvent): void {
    console.log('[TAP-DEBUG] onCanvasPointerDown fired — clientX:', event.clientX, 'clientY:', event.clientY, 'pointerId:', event.pointerId);
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();

    const displayX = event.clientX - rect.left;
    const displayY = event.clientY - rect.top;

    const x = displayX / rect.width;
    const y = displayY / rect.height;

    this.dragStart = { x, y, clientX: event.clientX, clientY: event.clientY };

    // Capture pointer so pointermove/pointerup fire even if pointer leaves element.
    el.setPointerCapture(event.pointerId);
  }

  /**
   * Handle pointer-up on the display element.
   *
   * - If total displacement ≥ {@link SWIPE_THRESHOLD_PX}, sends a `swipe` message.
   * - Otherwise delegates to the tap handler.
   */
  protected onCanvasPointerUp(event: PointerEvent): void {
    console.log('[TAP-DEBUG] onCanvasPointerUp fired — dragStart exists:', !!this.dragStart, 'clientX:', event.clientX, 'clientY:', event.clientY);
    if (!this.dragStart) return;

    const start = this.dragStart;
    this.dragStart = null;

    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    console.log('[TAP-DEBUG] onCanvasPointerUp — dx:', dx, 'dy:', dy, 'distance:', distance, 'SWIPE_THRESHOLD_PX:', this.SWIPE_THRESHOLD_PX);

    if (distance >= this.SWIPE_THRESHOLD_PX) {
      // Treat as a swipe
      const ws = this.getInputWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Don't send swipes until frame dimensions are known.
      if (this.frameWidth() === 0 || this.frameHeight() === 0) {
        console.warn('[SimulatorViewer] Swipe dropped: frame dimensions not yet known');
        return;
      }

      const el = event.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();

      const endDisplayX = event.clientX - rect.left;
      const endDisplayY = event.clientY - rect.top;

      const endX = endDisplayX / rect.width;
      const endY = endDisplayY / rect.height;

      ws.send(
        JSON.stringify({
          type: 'touch',
          action: 'swipe',
          startX: start.x,
          startY: start.y,
          endX,
          endY,
          deviceStartX: Math.round(start.x * this.frameWidth()),
          deviceStartY: Math.round(start.y * this.frameHeight()),
          deviceEndX: Math.round(endX * this.frameWidth()),
          deviceEndY: Math.round(endY * this.frameHeight()),
        }),
      );
    } else {
      // Treat as a tap
      this.sendTap(event);
    }
  }

  /**
   * Handle pointer-move on the display element.
   * Prevents default browser behaviour (text selection, scroll, zoom)
   * during a drag gesture.
   */
  protected onCanvasPointerMove(event: PointerEvent): void {
    if (this.dragStart) {
      event.preventDefault();
    }
  }

  /**
   * Handle keydown events on the display element — forwards a key event to
   * the server. Prevents default browser behaviour for keys that would
   * interfere (arrows, space, tab, etc.) while the element is focused.
   */
  protected onCanvasKeyDown(event: KeyboardEvent): void {
    const ws = this.getInputWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Don't capture modifier-only presses (Shift, Ctrl, Alt, Meta alone)
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;

    // Prevent default browser behavior for keys that would scroll/navigate
    // while the simulator display element is focused.
    const preventDefaultKeys = [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Space', ' ', 'Tab', 'Backspace', 'Enter', 'Escape',
    ];
    if (preventDefaultKeys.includes(event.key)) {
      event.preventDefault();
    }

    ws.send(
      JSON.stringify({
        type: 'key',
        action: 'down',
        key: event.key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      }),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Programmatically focus the canvas element so that keyboard events are
   * captured. Both MJPEG and WebCodecs modes use the same `<canvas>` element.
   */
  public focusCanvas(): void {
    this.canvasRef?.nativeElement?.focus();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Return the open WebSocket to use for sending JSON input events.
   *
   * - **MJPEG mode**: returns `this.ws` (the stream socket, set by `connect()`).
   * - **WebCodecs mode**: returns `this.inputWs` (the WebSocket returned by
   *   `WebCodecsService.connect()`).
   *
   * Returns `null` if no input socket is currently available.
   */
  private getInputWebSocket(): WebSocket | null {
    console.log('[TAP-DEBUG] getInputWebSocket — inputWs is null:', this.inputWs === null, 'readyState:', this.inputWs?.readyState ?? 'N/A', '(OPEN=1)');
    return this.inputWs;
  }

  /**
   * Send a tap event at the pointer position, normalised to 0–1 coordinates.
   *
   * @param event - The pointer event containing the client position.
   */
  private sendTap(event: MouseEvent | PointerEvent): void {
    const ws = this.getInputWebSocket();
    console.log('[TAP-DEBUG] sendTap — ws is null:', ws === null, 'readyState:', ws?.readyState ?? 'N/A', '(OPEN=1)', 'frameWidth:', this.frameWidth(), 'frameHeight:', this.frameHeight());
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();

    const displayX = event.clientX - rect.left;
    const displayY = event.clientY - rect.top;

    const x = displayX / rect.width;
    const y = displayY / rect.height;

    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      // Don't send taps until frame dimensions are known — otherwise
      // deviceX/Y resolve to 0, sending every tap to the top-left corner.
      if (this.frameWidth() === 0 || this.frameHeight() === 0) {
        console.warn('[SimulatorViewer] Tap dropped: frame dimensions not yet known');
        return;
      }
      const payload = JSON.stringify({
        type: 'touch',
        action: 'tap',
        x,
        y,
        deviceX: Math.round(x * this.frameWidth()),
        deviceY: Math.round(y * this.frameHeight()),
      });
      console.log('[TAP-DEBUG] sendTap — sending payload:', payload);
      ws.send(payload);
    }
  }

  /**
   * Establish the WebCodecs connection.
   *
   * Calls `WebCodecsService.connect()` which opens a WebSocket to
   * `/ws/stream/:sessionId?format=h264`, begins decoding H.264 frames, and
   * renders them onto the provided canvas. The returned WebSocket is stored
   * as `inputWs` and used for sending input messages.
   *
   * Connection state, frame dimensions, and FPS are mirrored from the service
   * via reactive effects registered in the constructor.
   */
  private connectWebCodecs(): void {
    if (!this.sessionId) {
      this.errorMessage.set('No session ID provided for WebCodecs');
      this.setConnectionState('error');
      return;
    }

    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) {
      this.errorMessage.set('Canvas element not available');
      this.setConnectionState('error');
      return;
    }

    try {
      // connect() returns the WebSocket for input messages.
      // The service handles its own state management via connectionState signal.
      this.inputWs = this.webCodecsService.connect(this.sessionId, canvas);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'WebCodecs connection failed';
      this.errorMessage.set(message);
      this.setConnectionState('error');
    }
  }

  /**
   * Create a WebSocket connection for MJPEG streaming and wire up binary
   * frame handling and input routing.
   */
  private connect(): void {
    const url = this.resolveWsUrl();

    this.ngZone.runOutsideAngular(() => {
      try {
        this.ws = new WebSocket(url);
        // In MJPEG mode the stream socket doubles as the input socket.
        this.inputWs = this.ws;
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.ngZone.run(() => {
            this.setConnectionState('connected');
            // Auto-focus the canvas so keyboard events are captured immediately.
            this.canvasRef?.nativeElement?.focus();
          });
        };

        this.ws.onmessage = (event: MessageEvent) => {
          // Binary messages are frames (JPEG/PNG)
          if (event.data instanceof ArrayBuffer) {
            this.renderFrame(event.data);
          }
          // Text messages are control responses (e.g. error feedback)
          if (typeof event.data === 'string') {
            try {
              const msg = JSON.parse(event.data) as { type?: string; message?: string };
              if (msg.type === 'error' && msg.message) {
                console.warn('[SimulatorViewer] Backend error:', msg.message);
              }
            } catch {
              // Ignore non-JSON text messages
            }
          }
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
   * Uses `createImageBitmap` for efficient off-main-thread decoding.
   *
   * @param data - Raw binary frame data from the WebSocket.
   */
  private renderFrame(data: ArrayBuffer): void {
    const blob = new Blob([data]); // browser auto-detects JPEG vs PNG

    createImageBitmap(blob)
      .then((bitmap) => {
        const canvas = this.canvasRef?.nativeElement;
        if (!canvas) return;

        // Update canvas size to match frame if changed.
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
        // Ignore decode errors for individual frames — next frame will come soon.
      });
  }

  /**
   * Resolve `wsUrl` to a fully-qualified WebSocket URL.
   *
   * If `wsUrl` is already an absolute WebSocket URL (`ws://` or `wss://`) it
   * is returned unchanged. Otherwise it is treated as a path relative to the
   * current page origin and expanded using the appropriate protocol:
   * - `https:` pages → `wss:`
   * - `http:`  pages → `ws:`
   */
  private resolveWsUrl(): string {
    if (this.wsUrl.startsWith('ws://') || this.wsUrl.startsWith('wss://')) {
      return this.wsUrl;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.wsUrl}`;
  }

  /**
   * Close all open connections (MJPEG WebSocket, input WebSocket, WebCodecs).
   * Safe to call multiple times.
   */
  private disconnect(): void {
    // Save the ws reference before nulling so that the inputWs comparison below
    // works correctly in MJPEG mode (where inputWs === ws before disconnect).
    const wsRef = this.ws;

    // Close the MJPEG stream WebSocket.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore errors during cleanup.
      }
      this.ws = null;
    }

    // Close the input-only WebSocket if it is a separate reference (WebCodecs mode).
    // Compare against wsRef (the pre-null value) to avoid a false-positive when
    // this.ws is already null after the block above.
    if (this.inputWs && this.inputWs !== wsRef) {
      try {
        this.inputWs.close();
      } catch {
        // Ignore errors during cleanup.
      }
    }
    this.inputWs = null;

    // Disconnect the WebCodecs service if in webcodecs mode.
    if (this.streamMode() === 'webcodecs') {
      this.webCodecsService.disconnect();
    }
  }

  /**
   * Update the connection-state signal and emit the change output.
   * @param state - New connection state.
   */
  private setConnectionState(state: ConnectionState): void {
    this.connectionState.set(state);
    this.connectionStateChange.emit(state);
  }

  /**
   * Apply the current scale mode to the canvas display element.
   *
   * In `'auto'` mode, computes the largest scale at which the canvas fits
   * entirely within the bezel stage (maintaining aspect ratio) and sets
   * the canvas CSS width/height explicitly. The bezel (inline-flex, content-sized)
   * automatically wraps around the scaled canvas.
   *
   * In fixed modes (`1x`, `0.75x`, `0.5x`), scales relative to the auto-fit
   * size so the canvas always starts from a "fits in viewport" baseline.
   */
  private applyScaleMode(): void {
    const el = this.canvasRef?.nativeElement;
    if (!el) return;

    const frameW = this.frameWidth();
    const frameH = this.frameHeight();

    // Nothing to scale until we have frame dimensions
    if (frameW <= 0 || frameH <= 0) {
      el.style.width = '';
      el.style.height = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
      return;
    }

    const stageEl = this.bezelStageRef?.nativeElement;
    if (!stageEl) return;

    // Available canvas area = stage content area minus:
    //   - stage padding: 24px top + 24px bottom = 48px, 16px left + 16px right = 32px
    //   - bezel chrome: only the physical bezel padding, since DI / camera-hole /
    //     home-indicator are rendered by the simulator stream (not CSS elements).
    //     iOS:     top 12px + bottom 12px + 1.5px border×2 ≈ 27px  → 32px with safety margin
    //     Android: top 14px + bottom 8px  + 1.5px border×2 ≈ 25px  → 32px with safety margin
    //     Horizontal (iOS): left 8px + right 8px + border×2 ≈ 19px → 22px with safety margin
    const STAGE_PADDING_H = 32;  // horizontal
    const STAGE_PADDING_V = 48;  // vertical
    const BEZEL_CHROME_H  = 32;  // fixed bezel chrome height (bezel padding only, no DI/home-bar)
    const BEZEL_CHROME_W  = 22;  // fixed bezel chrome width  (left + right bezel padding)

    const availW = stageEl.clientWidth  - STAGE_PADDING_H - BEZEL_CHROME_W;
    const availH = stageEl.clientHeight - STAGE_PADDING_V - BEZEL_CHROME_H;

    if (availW <= 0 || availH <= 0) return;

    // Scale to fit: the largest multiplier where the canvas fits in both dimensions
    const fitScale = Math.min(availW / frameW, availH / frameH, 1.0);

    const mode = this.scaleMode();

    const scaleFactors: Record<ScaleMode, number> = {
      auto:   1.0,
      '1x':   1.0,
      '0.75x': 0.75,
      '0.5x':  0.5,
    };

    // In auto mode use fitScale directly; in fixed modes multiply against fitScale
    // so the user gets a predictable fraction of the "fits in viewport" size.
    const finalScale = mode === 'auto'
      ? fitScale
      : fitScale * scaleFactors[mode];

    // Set explicit CSS dimensions — this drives the bezel to auto-size around it.
    // Clear any leftover CSS transform from previous calls.
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.width  = `${Math.round(frameW * finalScale)}px`;
    el.style.height = `${Math.round(frameH * finalScale)}px`;
  }
}
