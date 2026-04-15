import { Injectable, NgZone, inject, signal } from '@angular/core';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Possible states of the WebCodecs streaming connection.
 */
export type WebCodecsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Singleton service that streams H.264 video from the backend over a binary
 * WebSocket and decodes it using the browser's WebCodecs `VideoDecoder` API,
 * rendering each decoded frame onto a caller-supplied `<canvas>` element.
 *
 * Binary protocol — each WebSocket message layout:
 * ```
 * [1 byte:  flags (bit 0 = isKeyframe)]
 * [8 bytes: timestamp in microseconds, big-endian uint64]
 * [N bytes: raw Annex B NALU data]
 * ```
 *
 * Input events (tap, swipe, key) can be sent by the caller via the
 * `WebSocket` returned from {@link connect}.
 *
 * @example
 * ```ts
 * readonly webCodecs = inject(WebCodecsService);
 *
 * ngAfterViewInit() {
 *   const ws = this.webCodecs.connect(this.sessionId, this.canvasEl);
 *   // send input via ws.send(JSON.stringify({ type: 'tap', x, y }))
 * }
 *
 * ngOnDestroy() {
 *   this.webCodecs.disconnect();
 * }
 * ```
 */
@Injectable({ providedIn: 'root' })
export class WebCodecsService {
  // ── Private dependencies ──────────────────────────────────────────────────

  private readonly ngZone = inject(NgZone);

  // ── Public signals ────────────────────────────────────────────────────────

  /**
   * Current connection + decoder state.
   * Components can bind this directly in templates or computed signals.
   */
  readonly connectionState = signal<WebCodecsConnectionState>('disconnected');

  /**
   * Human-readable error description when {@link connectionState} is `'error'`.
   * Empty string in all other states.
   */
  readonly errorMessage = signal<string>('');

  /** Width of the most recently decoded video frame, in pixels. `0` until the first frame. */
  readonly frameWidth = signal<number>(0);

  /** Height of the most recently decoded video frame, in pixels. `0` until the first frame. */
  readonly frameHeight = signal<number>(0);

  /**
   * Decoded frames per second, updated every second.
   * `0` until at least one FPS measurement completes.
   */
  readonly fps = signal<number>(0);

  // ── Private state ─────────────────────────────────────────────────────────

  /** The active WebSocket, or `null` when disconnected. */
  private socket: WebSocket | null = null;

  /** The active `VideoDecoder`, or `null` when not streaming. */
  private decoder: VideoDecoder | null = null;

  /**
   * Whether the `VideoDecoder` has been configured with a codec string derived
   * from a real SPS NALU.  Remains `false` until the first keyframe arrives.
   */
  private decoderConfigured = false;

  /** The `<canvas>` element to render frames onto, or `null` when not connected. */
  private canvas: HTMLCanvasElement | null = null;

  /**
   * Number of `VideoFrame` objects successfully drawn since the last FPS
   * measurement interval.  Reset each second.
   */
  private frameCount = 0;

  /** Handle returned by `setInterval` for the per-second FPS counter. */
  private fpsIntervalHandle: ReturnType<typeof setInterval> | null = null;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start streaming H.264 video to the provided canvas element.
   *
   * Opens a WebSocket to `/ws/stream/:sessionId?format=h264`, waits for the
   * connection to open, then creates and configures a `VideoDecoder`.  Each
   * decoded `VideoFrame` is drawn onto `canvas` via `CanvasRenderingContext2D`.
   *
   * If `connect()` is called while a session is already active, the previous
   * session is torn down first via {@link disconnect}.
   *
   * @param sessionId - The WMS session ID (UUID) to stream from.
   * @param canvas    - The `<canvas>` element to render decoded frames onto.
   * @returns The underlying `WebSocket` so the caller can send JSON input
   *          messages (tap / swipe / key) over the same connection.
   */
  connect(sessionId: string, canvas: HTMLCanvasElement): WebSocket {
    // Guard against re-entrance — tear down any active session first.
    if (this.socket !== null || this.decoder !== null) {
      this.disconnect();
    }

    // Feature detection — WebCodecs is only available in secure contexts and
    // modern browsers (Chrome 94+, Safari 17+, Edge 94+).
    if (typeof VideoDecoder === 'undefined') {
      this.ngZone.run(() => {
        this.connectionState.set('error');
        this.errorMessage.set('WebCodecs not supported in this browser');
      });
      // Return a dummy closed WebSocket so callers always get a WebSocket back.
      const dummy = new WebSocket('ws://localhost');
      dummy.close();
      return dummy;
    }

    this.canvas = canvas;

    const url = this.buildStreamUrl(sessionId);
    console.log(`[WebCodecsService] Opening stream WebSocket: ${url}`);

    this.ngZone.run(() => {
      this.connectionState.set('connecting');
      this.errorMessage.set('');
    });

    // Run all WebSocket I/O outside Angular's zone to avoid triggering
    // change-detection on every binary message or animation frame.
    this.ngZone.runOutsideAngular(() => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.socket = ws;

      ws.onopen = () => this.handleOpen();
      ws.onmessage = (event: MessageEvent) => this.handleMessage(event);
      ws.onclose = () => this.handleClose();
      ws.onerror = () => this.handleError();

      // FPS counter — runs entirely outside the zone; only the signal update
      // re-enters the zone.
      this.fpsIntervalHandle = setInterval(() => {
        const currentFps = this.frameCount;
        this.frameCount = 0;
        this.ngZone.run(() => {
          this.fps.set(currentFps);
        });
      }, 1_000);
    });

    // `this.socket` is guaranteed non-null at this point (set synchronously above).
    return this.socket!;
  }

  /**
   * Stop streaming and release all resources.
   *
   * Closes the WebSocket and `VideoDecoder`, clears the FPS interval, and
   * resets all public signals to their idle values.  Safe to call multiple
   * times — subsequent calls after the first are no-ops.
   */
  disconnect(): void {
    // ── FPS interval ──────────────────────────────────────────────────────
    if (this.fpsIntervalHandle !== null) {
      clearInterval(this.fpsIntervalHandle);
      this.fpsIntervalHandle = null;
    }

    // ── VideoDecoder ──────────────────────────────────────────────────────
    if (this.decoder !== null) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }

    // ── Decoder configuration flag ────────────────────────────────────────
    this.decoderConfigured = false;

    // ── WebSocket ─────────────────────────────────────────────────────────
    if (this.socket !== null) {
      const ws = this.socket;
      this.socket = null;

      // Detach handlers before closing so stale callbacks don't fire.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;

      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }

    // ── Canvas reference ──────────────────────────────────────────────────
    this.canvas = null;

    // ── Frame counter ─────────────────────────────────────────────────────
    this.frameCount = 0;

    // ── Signals ───────────────────────────────────────────────────────────
    this.ngZone.run(() => {
      this.connectionState.set('disconnected');
      this.frameWidth.set(0);
      this.frameHeight.set(0);
      this.fps.set(0);
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Build the streaming WebSocket URL, deriving `ws:` / `wss:` from the
   * page's own protocol so the service works correctly in both HTTP and HTTPS
   * deployments without any build-time configuration.
   *
   * @param sessionId - The WMS session ID.
   * @returns The fully-qualified WebSocket URL with `?format=h264`.
   */
  private buildStreamUrl(sessionId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/stream/${sessionId}?format=h264`;
  }

  /**
   * Handle the WebSocket `open` event.
   *
   * Creates a `VideoDecoder` instance (but does NOT configure it yet — the
   * codec string is derived dynamically from the SPS NALU of the first
   * keyframe in {@link handleMessage}).  Updates the connection state signal.
   */
  private handleOpen(): void {
    console.log('[WebCodecsService] WebSocket open — creating VideoDecoder');

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this.handleVideoFrame(frame);
      },
      error: (e: DOMException) => {
        console.error('[WebCodecsService] Decoder error:', e);
        this.ngZone.run(() => {
          this.connectionState.set('error');
          this.errorMessage.set(`Decoder error: ${e.message}`);
        });
      },
    });

    this.decoder = decoder;
    this.decoderConfigured = false;

    this.ngZone.run(() => {
      this.connectionState.set('connected');
    });
  }

  /**
   * Handle an incoming WebSocket message.
   *
   * Binary messages are parsed according to the 9-byte header protocol and
   * fed to the `VideoDecoder`.  Text messages are treated as JSON and any
   * `{ type: 'error' }` payloads are logged.
   *
   * @param event - The native `MessageEvent` from the WebSocket.
   */
  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      this.handleTextMessage(event.data);
      return;
    }

    if (this.decoder === null || this.decoder.state === 'closed') {
      return;
    }

    const data = new Uint8Array(event.data as ArrayBuffer);

    // Validate minimum message length: 1 flag byte + 8 timestamp bytes = 9.
    if (data.byteLength < 9) {
      console.warn(
        `[WebCodecsService] Received undersized binary message (${data.byteLength} bytes) — skipping`,
      );
      return;
    }

    // ── Parse the 9-byte header ───────────────────────────────────────────
    const isKeyframe = (data[0]! & 1) !== 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const timestampUs = view.getBigUint64(1); // bytes 1–8, big-endian
    const naluData = data.subarray(9);        // bytes 9+: raw Annex B NALU

    if (naluData.byteLength === 0) {
      console.warn('[WebCodecsService] Empty NALU payload — skipping');
      return;
    }

    // ── Lazy-configure on first keyframe ────────────────────────────────────
    if (!this.decoderConfigured) {
      if (!isKeyframe) {
        // Delta frames before the first keyframe cannot be decoded — drop them.
        return;
      }

      const spsNalu = this.extractNalu(naluData, 7); // SPS
      const ppsNalu = this.extractNalu(naluData, 8); // PPS

      if (spsNalu === null || ppsNalu === null) {
        console.warn(
          '[WebCodecsService] Could not find SPS/PPS in first keyframe — skipping frame',
        );
        return;
      }

      // Build codec string from SPS: profile_idc, constraint_flags, level_idc
      const profileIdc = spsNalu[1]!;
      const constraintFlags = spsNalu[2]!;
      const levelIdc = spsNalu[3]!;
      const derivedCodec =
        'avc1.' +
        profileIdc.toString(16).padStart(2, '0').toUpperCase() +
        constraintFlags.toString(16).padStart(2, '0').toUpperCase() +
        levelIdc.toString(16).padStart(2, '0').toUpperCase();

      // Build AVCDecoderConfigurationRecord for the hardware decoder
      const description = this.buildAvcC(spsNalu, ppsNalu);

      console.log(`[WebCodecsService] Derived codec from SPS: ${derivedCodec}`);
      this.decoder.configure({
        codec: derivedCodec,
        description,
        optimizeForLatency: true,
      });
      this.decoderConfigured = true;
    }

    // ── Convert Annex B to avcC format and submit to decoder ────────────────
    const avcData = this.annexBToAvcC(naluData);
    if (avcData === null) {
      return; // No decodable NALUs (e.g. SPS/PPS-only frame)
    }

    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp: Number(timestampUs),
          data: avcData,
        }),
      );
    } catch (err: unknown) {
      console.error('[WebCodecsService] Failed to decode chunk:', err);
    }
  }

  /**
   * Handle a text WebSocket message from the server.
   *
   * The server may send JSON error payloads over the same connection.  This
   * helper parses and logs them so they are visible in DevTools.
   *
   * @param rawText - The raw text payload from the WebSocket message.
   */
  private handleTextMessage(rawText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.warn('[WebCodecsService] Received non-JSON text message:', rawText);
      return;
    }

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      (parsed as Record<string, unknown>)['type'] === 'error'
    ) {
      console.error('[WebCodecsService] Server error message:', parsed);
    } else {
      console.log('[WebCodecsService] Server text message:', parsed);
    }
  }

  /**
   * Handle the WebSocket `close` event.
   *
   * Performs a full teardown so all resources are released and signals are
   * reset to their idle values.
   */
  private handleClose(): void {
    console.log('[WebCodecsService] WebSocket closed — disconnecting');
    // Null the socket reference first so disconnect() doesn't try to close it
    // again (it's already closed by the browser).
    this.socket = null;
    this.disconnect();
  }

  /**
   * Handle the WebSocket `error` event.
   *
   * The browser always fires a `close` event immediately after `error`, so
   * the close handler will perform the actual teardown.  Here we only update
   * the error signal to give the UI immediate feedback.
   */
  private handleError(): void {
    console.error('[WebCodecsService] WebSocket error');
    this.ngZone.run(() => {
      this.connectionState.set('error');
      this.errorMessage.set('WebSocket connection error');
    });
  }

  /**
   * Render a decoded `VideoFrame` to the canvas and update dimension signals
   * if the frame size changed.
   *
   * Frame rendering is intentionally performed outside Angular's change
   * detection zone — it is a pure canvas painting operation with no impact on
   * component state.  Only dimension-change signal updates re-enter the zone.
   *
   * **IMPORTANT**: `frame.close()` must be called synchronously after drawing
   * to release the GPU-backed memory held by the `VideoFrame`.
   *
   * @param frame - The decoded `VideoFrame` produced by `VideoDecoder`.
   */
  private handleVideoFrame(frame: VideoFrame): void {
    const canvas = this.canvas;

    if (canvas === null) {
      frame.close();
      return;
    }

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      frame.close();
      return;
    }

    // Resize the canvas backing store if the frame dimensions changed.
    if (
      canvas.width !== frame.displayWidth ||
      canvas.height !== frame.displayHeight
    ) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;

      this.ngZone.run(() => {
        this.frameWidth.set(frame.displayWidth);
        this.frameHeight.set(frame.displayHeight);
      });
    }

    ctx.drawImage(frame, 0, 0);

    // CRITICAL: close the frame immediately to avoid GPU memory leaks.
    frame.close();

    this.frameCount++;
  }

  /**
   * Extract the first NALU of a given type from Annex B data.
   * Returns raw NALU bytes (including NALU header byte, excluding start code), or null.
   *
   * @param annexBData - Raw Annex B NALU data to scan.
   * @param naluType   - The NALU type to search for (e.g. 7 = SPS, 8 = PPS).
   * @returns The NALU bytes including the header byte, or `null` if not found.
   */
  private extractNalu(annexBData: Uint8Array, naluType: number): Uint8Array | null {
    for (let i = 0; i <= annexBData.length - 5; i++) {
      if (
        annexBData[i] === 0 && annexBData[i + 1] === 0 &&
        annexBData[i + 2] === 0 && annexBData[i + 3] === 1
      ) {
        const type = annexBData[i + 4]! & 0x1f;
        if (type === naluType) {
          // Find end: next start code or end of buffer
          let end = annexBData.length;
          for (let j = i + 4; j <= annexBData.length - 4; j++) {
            if (
              annexBData[j] === 0 && annexBData[j + 1] === 0 &&
              annexBData[j + 2] === 0 && annexBData[j + 3] === 1
            ) {
              end = j;
              break;
            }
          }
          return annexBData.subarray(i + 4, end);
        }
      }
    }
    return null;
  }

  /**
   * Build an AVCDecoderConfigurationRecord from raw SPS and PPS NALUs.
   * Both inputs include the NALU header byte but NOT the Annex B start code.
   *
   * Layout (ISO 14496-15 §5.3.3.1.2):
   *   [1] configurationVersion = 0x01
   *   [1] AVCProfileIndication = sps[1]  (profile_idc, byte after NALU header)
   *   [1] profile_compatibility = sps[2] (constraint_set_flags)
   *   [1] AVCLevelIndication = sps[3]    (level_idc)
   *   [1] lengthSizeMinusOne = 0xFF      (4-byte NALU length prefix, top 6 bits reserved = 1)
   *   [1] numSPS = 0xE1                  (1 SPS, top 3 bits reserved = 1)
   *   [2] spsLength (big-endian)
   *   [N] sps bytes
   *   [1] numPPS = 0x01
   *   [2] ppsLength (big-endian)
   *   [M] pps bytes
   *
   * @param spsNalu - Raw SPS NALU bytes including the NALU header byte.
   * @param ppsNalu - Raw PPS NALU bytes including the NALU header byte.
   * @returns The serialised AVCDecoderConfigurationRecord as a `Uint8Array`.
   */
  private buildAvcC(spsNalu: Uint8Array, ppsNalu: Uint8Array): Uint8Array {
    const spsLen = spsNalu.byteLength;
    const ppsLen = ppsNalu.byteLength;
    const total = 6 + 2 + spsLen + 1 + 2 + ppsLen;
    const record = new Uint8Array(total);
    const view = new DataView(record.buffer);
    let offset = 0;

    record[offset++] = 0x01;          // configurationVersion
    record[offset++] = spsNalu[1]!;   // AVCProfileIndication (profile_idc)
    record[offset++] = spsNalu[2]!;   // profile_compatibility (constraint_flags)
    record[offset++] = spsNalu[3]!;   // AVCLevelIndication (level_idc)
    record[offset++] = 0xFF;          // lengthSizeMinusOne = 3 → 4-byte prefixes
    record[offset++] = 0xE1;          // numSequenceParameterSets = 1

    view.setUint16(offset, spsLen, false); // big-endian SPS length
    offset += 2;
    record.set(spsNalu, offset);
    offset += spsLen;

    record[offset++] = 0x01;          // numPictureParameterSets = 1

    view.setUint16(offset, ppsLen, false); // big-endian PPS length
    offset += 2;
    record.set(ppsNalu, offset);

    return record;
  }

  /**
   * Convert Annex B formatted data to avcC format (4-byte length-prefixed NALUs).
   * Strips SPS (type 7) and PPS (type 8) since they are in the decoder description.
   * Returns null if no decodable NALUs are found.
   *
   * @param annexBData - Raw Annex B NALU data with `0x00000001` start codes.
   * @returns avcC-formatted buffer, or `null` if there are no decodable NALUs.
   */
  private annexBToAvcC(annexBData: Uint8Array): Uint8Array | null {
    const nalus: Uint8Array[] = [];

    // Find all NALUs by scanning for 0x00000001 start codes
    const startOffsets: number[] = [];
    for (let i = 0; i <= annexBData.length - 4; i++) {
      if (
        annexBData[i] === 0 && annexBData[i + 1] === 0 &&
        annexBData[i + 2] === 0 && annexBData[i + 3] === 1
      ) {
        startOffsets.push(i);
      }
    }

    for (let idx = 0; idx < startOffsets.length; idx++) {
      const naluStart = startOffsets[idx]! + 4; // skip start code
      const naluEnd = idx + 1 < startOffsets.length ? startOffsets[idx + 1]! : annexBData.length;
      const nalu = annexBData.subarray(naluStart, naluEnd);
      if (nalu.byteLength === 0) continue;

      const naluType = nalu[0]! & 0x1f;
      // Skip SPS (7) and PPS (8) — they are in the decoder description
      if (naluType !== 7 && naluType !== 8) {
        nalus.push(nalu);
      }
    }

    if (nalus.length === 0) return null;

    // Build avcC: [4-byte BE length][NALU bytes] for each NALU
    const totalSize = nalus.reduce((sum, n) => sum + 4 + n.byteLength, 0);
    const result = new Uint8Array(totalSize);
    const view = new DataView(result.buffer);
    let offset = 0;

    for (const nalu of nalus) {
      view.setUint32(offset, nalu.byteLength, false); // big-endian length
      offset += 4;
      result.set(nalu, offset);
      offset += nalu.byteLength;
    }

    return result;
  }
}
