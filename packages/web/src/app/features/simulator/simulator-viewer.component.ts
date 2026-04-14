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
  afterNextRender,
  Injector,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { WebRtcService } from '../../core/services/webrtc.service';

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
 * - `'webrtc'` – H.264 video via WebRTC (primary path, iOS preferred).
 * - `'mjpeg'` – JPEG frames over WebSocket canvas (fallback, Android / error cases).
 */
export type StreamMode = 'webrtc' | 'mjpeg';

/**
 * SimulatorViewerComponent
 *
 * Renders a live simulator display via one of two modes:
 *
 * **MJPEG mode** (default): receives JPEG/PNG frames over a WebSocket and
 * paints them onto an HTML `<canvas>`.
 *
 * **WebRTC mode**: uses `WebRtcService` to establish an H.264 peer connection
 * and renders the remote `MediaStream` into a `<video>` element.
 *
 * Touch, pointer, and keyboard events on the active display element are
 * captured, normalized to 0–1 coordinates, and sent back over a WebSocket
 * (the MJPEG stream socket in MJPEG mode, a dedicated input socket in WebRTC
 * mode) as JSON messages for server-side input injection.
 */
@Component({
  selector: 'app-simulator-viewer',
  standalone: true,
  imports: [TitleCasePipe],
  templateUrl: './simulator-viewer.component.html',
  styleUrl: './simulator-viewer.component.scss',
})
export class SimulatorViewerComponent implements AfterViewInit, OnDestroy {
  /** WebSocket URL to connect to (e.g. `/ws/stream/<sessionId>`). Required in both modes. */
  @Input({ required: true }) wsUrl!: string;

  /**
   * WMS session UUID used for WebRTC signaling.
   * Must be provided when `streamMode === 'webrtc'`.
   */
  @Input() sessionId: string = '';

  /**
   * Which rendering path to use.
   * - `'webrtc'` – H.264 video via `WebRtcService`; the `<canvas>` is hidden.
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

  /** @ViewChild reference to the canvas element used in MJPEG mode. */
  @ViewChild('displayCanvas')
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** @ViewChild reference to the video element used in WebRTC mode. */
  @ViewChild('displayVideo')
  private readonly videoRef!: ElementRef<HTMLVideoElement>;

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

  /**
   * Mirror of `WebRtcService.remoteStream` for template binding.
   * Set when the WebRTC stream is attached; `null` before connection and after disconnect.
   */
  protected readonly remoteStream = signal<MediaStream | null>(null);

  // ── Private state ─────────────────────────────────────────────────────────

  /**
   * The MJPEG WebSocket.
   * In MJPEG mode this is both the stream source and the input channel.
   * In WebRTC mode this is `null` (a dedicated `inputWs` is used instead).
   */
  private ws: WebSocket | null = null;

  /**
   * The WebSocket used exclusively to send JSON input events (tap, swipe, key).
   *
   * - In **MJPEG mode**: shares the same reference as `ws` (set inside `connect()`).
   * - In **WebRTC mode**: a dedicated WebSocket opened to `wsUrl` so that input
   *   commands can be forwarded even though we are not consuming the binary frame stream.
   */
  private inputWs: WebSocket | null = null;

  private readonly ngZone = inject(NgZone);
  private readonly webRtcService = inject(WebRtcService);
  private readonly injector = inject(Injector);

  // FPS tracking
  private frameCount = 0;
  private fpsInterval: ReturnType<typeof setInterval> | null = null;

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

  /** Reference to the current video resize listener (for cleanup). */
  private videoResizeListener: (() => void) | null = null;

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor() {
    // Reactively mirror the WebRtcService's remoteStream signal.
    // This handles the race between the 'connected' state and the 'track' event —
    // regardless of which fires first, the video element gets the stream.
    effect(() => {
      const stream = this.webRtcService.remoteStream();
      if (stream && this.streamMode() === 'webrtc') {
        // Set the signal first so Angular CD runs and removes display:none from
        // the <video> element (via the display-video--hidden class).
        this.remoteStream.set(stream);
        // Defer attachStreamToVideo until after the next render so that
        // the video element is visible before video.play() is called.
        // Safari rejects play() on hidden elements with NotAllowedError/AbortError.
        afterNextRender(() => { this.attachStreamToVideo(stream); }, { injector: this.injector });
      }
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    if (this.streamMode() === 'webrtc') {
      this.connectWebRTC();
    } else {
      this.connect();
    }
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

  // ── Template event handlers ────────────────────────────────────────────────

  /** Tear down the existing connection and open a fresh one. */
  protected reconnect(): void {
    this.disconnect();
    this.connectionState.set('connecting');
    this.errorMessage.set('');
    if (this.streamMode() === 'webrtc') {
      this.connectWebRTC();
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
   *
   * Works for both `<canvas>` (MJPEG) and `<video>` (WebRTC) elements because
   * coordinates are derived from `event.currentTarget` rather than a hard-coded
   * element reference.
   */
  protected onCanvasPointerDown(event: PointerEvent): void {
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
    if (!this.dragStart) return;

    const start = this.dragStart;
    this.dragStart = null;

    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= this.SWIPE_THRESHOLD_PX) {
      // Treat as a swipe
      const ws = this.getInputWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Don't send swipes until video dimensions are known.
      if (this.frameWidth() === 0 || this.frameHeight() === 0) {
        console.warn('[SimulatorViewer] Swipe dropped: video dimensions not yet known');
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
   * Programmatically focus the active display element so that keyboard events
   * are captured. Focuses the `<video>` element in WebRTC mode and the
   * `<canvas>` element in MJPEG mode.
   */
  public focusCanvas(): void {
    if (this.streamMode() === 'webrtc') {
      this.videoRef?.nativeElement?.focus();
    } else {
      this.canvasRef?.nativeElement?.focus();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Return the open WebSocket to use for sending JSON input events.
   *
   * - **MJPEG mode**: returns `this.ws` (the stream socket, set by `connect()`).
   * - **WebRTC mode**: returns `this.inputWs` (dedicated input socket, set by
   *   `connectWebRTC()`).
   *
   * Returns `null` if no input socket is currently available.
   */
  private getInputWebSocket(): WebSocket | null {
    return this.inputWs;
  }

  /**
   * Send a tap event at the pointer position, normalised to 0–1 coordinates.
   *
   * @param event - The pointer event containing the client position.
   */
  private sendTap(event: MouseEvent | PointerEvent): void {
    const ws = this.getInputWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();

    const displayX = event.clientX - rect.left;
    const displayY = event.clientY - rect.top;

    const x = displayX / rect.width;
    const y = displayY / rect.height;

    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      // Don't send taps until video dimensions are known — otherwise
      // deviceX/Y resolve to 0, sending every tap to the top-left corner.
      if (this.frameWidth() === 0 || this.frameHeight() === 0) {
        console.warn('[SimulatorViewer] Tap dropped: video dimensions not yet known');
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'touch',
          action: 'tap',
          x,
          y,
          deviceX: Math.round(x * this.frameWidth()),
          deviceY: Math.round(y * this.frameHeight()),
        }),
      );
    }
  }

  /**
   * Establish the WebRTC connection.
   *
   * Steps:
   * 1. Calls `WebRtcService.connect()` to set up the RTCPeerConnection and
   *    perform SDP negotiation.
   * 2. On success, sets the connection state to `'connected'` and focuses the
   *    video element for keyboard input.
   * 3. Opens a dedicated input-only WebSocket to `wsUrl` AFTER WebRTC is
   *    connected, so that the H.264 capture is already running and the
   *    `/ws/stream/:sessionId` route finds an active emitter (it closes the
   *    socket with code 1008 if no emitter exists yet).
   */
  private connectWebRTC(): void {
    if (!this.sessionId) {
      this.errorMessage.set('No session ID provided for WebRTC');
      this.setConnectionState('error');
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      this.webRtcService.connect(this.sessionId)
        .then(() => {
          this.ngZone.run(() => {
            this.setConnectionState('connected');

            // Focus the video element for keyboard input
            this.videoRef?.nativeElement?.focus();
          });

          // Open the input-only WebSocket AFTER WebRTC is connected.
          // At this point the H.264 capture is running, so the
          // /ws/stream/:sessionId route will find an active emitter
          // instead of closing the socket with 1008.
          this.ngZone.runOutsideAngular(() => {
            try {
              const inputUrl = this.resolveWsUrl();
              this.inputWs = new WebSocket(inputUrl);
              this.inputWs.binaryType = 'arraybuffer';
              // Handle errors on the input socket so they don't become unhandled rejections.
              this.inputWs.onerror = () => {
                console.warn('[SimulatorViewer] Input WebSocket error (WebRTC mode)');
              };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Failed to open input WebSocket';
              console.warn('[SimulatorViewer] Could not open input WebSocket:', message);
              // Non-fatal — WebRTC video still works; only input will be unavailable.
            }
          });
        })
        .catch((err: unknown) => {
          this.ngZone.run(() => {
            const message = err instanceof Error ? err.message : 'WebRTC connection failed';
            console.warn('[SimulatorViewer] WebRTC connection failed:', message);
            this.errorMessage.set(message);
            this.setConnectionState('error');
          });
        });
    });
  }

  /**
   * Attach a remote `MediaStream` to the `<video>` element and start
   * FPS counting via `requestVideoFrameCallback` if supported.
   *
   * Also listens to the `resize` event on the video element to keep
   * `frameWidth` / `frameHeight` signals up to date.
   *
   * @param stream - The remote `MediaStream` from `WebRtcService`.
   */
  private attachStreamToVideo(stream: MediaStream): void {
    const video = this.videoRef?.nativeElement;
    if (!video) return;

    video.srcObject = stream;

    // Force playback — needed when the element was hidden at srcObject assignment time.
    video.play().catch((err: unknown) => {
      console.warn('[SimulatorViewer] video.play() failed:', err);
    });

    // Fallback: capture dimensions from loadedmetadata in case
    // requestVideoFrameCallback doesn't fire (e.g. frozen stream).
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth > 0 && this.frameWidth() === 0) {
        this.ngZone.run(() => {
          this.frameWidth.set(video.videoWidth);
          this.frameHeight.set(video.videoHeight);
          this.applyScaleMode();
        });
      }
    }, { once: true });

    // Use requestVideoFrameCallback for FPS counting when available.
    // This API is not yet in the TypeScript lib types, so we check at runtime
    // and cast through `any` for the call-site.
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const countFrame = (): void => {
        this.frameCount++;

        // Update resolution from video dimensions on first valid frame.
        if (video.videoWidth > 0 && this.frameWidth() === 0) {
          this.ngZone.run(() => {
            this.frameWidth.set(video.videoWidth);
            this.frameHeight.set(video.videoHeight);
            this.applyScaleMode();
          });
        }

        // Re-register for the next frame.
        (video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void })
          .requestVideoFrameCallback(countFrame);
      };

      (video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void })
        .requestVideoFrameCallback(countFrame);
    }

    // Remove any previous resize listener to avoid accumulation on reconnect.
    if (this.videoResizeListener) {
      video.removeEventListener('resize', this.videoResizeListener);
    }

    // Keep resolution signals updated whenever the video track size changes.
    this.videoResizeListener = (): void => {
      this.ngZone.run(() => {
        if (video.videoWidth > 0) {
          this.frameWidth.set(video.videoWidth);
          this.frameHeight.set(video.videoHeight);
          this.applyScaleMode();
        }
      });
    };
    video.addEventListener('resize', this.videoResizeListener);
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
   * Close all open connections (MJPEG WebSocket, input WebSocket, WebRTC peer).
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

    // Close the input-only WebSocket if it is a separate reference (WebRTC mode).
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

    // Disconnect the WebRTC peer connection if active.
    if (this.streamMode() === 'webrtc') {
      this.webRtcService.disconnect();
      this.remoteStream.set(null);
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
   * Apply the current scale mode to the active display element (`<canvas>` or
   * `<video>` depending on `streamMode`).
   *
   * In `'auto'` mode, CSS handles scaling via `max-width`/`max-height`.
   * In fixed modes (`1x`, `0.75x`, `0.5x`), a CSS `transform: scale()` is applied.
   */
  private applyScaleMode(): void {
    const el = this.streamMode() === 'webrtc'
      ? this.videoRef?.nativeElement
      : this.canvasRef?.nativeElement;
    if (!el) return;

    const mode = this.scaleMode();

    if (mode === 'auto') {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.width = '';
      el.style.height = '';
    } else {
      const scaleFactors: Record<ScaleMode, number> = {
        auto: 1,
        '1x': 1,
        '0.75x': 0.75,
        '0.5x': 0.5,
      };
      const scale = scaleFactors[mode];
      el.style.transformOrigin = 'top left';
      el.style.transform = `scale(${scale})`;
    }
  }
}
