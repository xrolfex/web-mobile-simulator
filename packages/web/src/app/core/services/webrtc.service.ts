import { Injectable, signal } from '@angular/core';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Possible states of the WebRTC peer connection, mapped directly from
 * `RTCPeerConnectionState` plus `'new'` for the pre-connect state.
 */
export type WebRTCConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

/**
 * Discriminated union of all signaling messages exchanged over the WebSocket
 * between the browser client and the `werift` WebRTC server.
 */
type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  | { type: 'error'; message: string };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * How long (ms) to wait for the WebRTC connection to reach `'connected'`
 * before rejecting the `connect()` promise.
 */
const CONNECT_TIMEOUT_MS = 15_000;

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Singleton service that manages a browser-side `RTCPeerConnection` for
 * receiving H.264 video from the backend's `werift` WebRTC server.
 *
 * Responsibilities:
 * - Open a signaling WebSocket at `/ws/webrtc/:sessionId`
 * - Perform SDP offer/answer negotiation
 * - Exchange ICE candidates (trickle ICE)
 * - Expose the remote {@link MediaStream} via the {@link remoteStream} signal
 * - Expose the connection state via the {@link connectionState} signal
 * - Clean teardown via {@link disconnect}
 *
 * @example
 * ```ts
 * readonly webRtc = inject(WebRtcService);
 *
 * async startStream(sessionId: string) {
 *   await this.webRtc.connect(sessionId);
 *   // remoteStream() is now set — bind it to a <video> element
 * }
 * ```
 */
@Injectable({ providedIn: 'root' })
export class WebRtcService {
  // ── Public signals ────────────────────────────────────────────────────────

  /**
   * Current WebRTC peer connection state.
   * Components can read this signal directly in templates or computed signals.
   */
  readonly connectionState = signal<WebRTCConnectionState>('new');

  /**
   * The remote {@link MediaStream} delivered by the peer connection.
   * Set when the first `track` event fires; `null` before connection and after
   * disconnect.
   */
  readonly remoteStream = signal<MediaStream | null>(null);

  // ── Private state ─────────────────────────────────────────────────────────

  /** The active RTCPeerConnection, or null when not connected. */
  private peerConnection: RTCPeerConnection | null = null;

  /** The active signaling WebSocket, or null when not connected. */
  private signalingSocket: WebSocket | null = null;

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start a WebRTC session for the given session ID.
   *
   * Opens the signaling WebSocket, creates an `RTCPeerConnection`, and
   * performs SDP offer/answer negotiation with the backend. ICE candidates
   * are exchanged via trickle ICE throughout the process.
   *
   * The returned Promise resolves when `connectionState` reaches `'connected'`
   * and rejects if:
   * - The signaling WebSocket closes before negotiation completes
   * - The server sends a `{ type: 'error' }` signaling message
   * - No connection is established within {@link CONNECT_TIMEOUT_MS} ms
   *
   * @param sessionId - The WMS session ID (UUID) to connect to.
   * @returns Promise that resolves when the WebRTC connection is established.
   */
  async connect(sessionId: string): Promise<void> {
    // Clean up any previous session before starting a new one.
    this.disconnect();

    this.connectionState.set('connecting');

    return new Promise<void>((resolve, reject) => {
      const url = this.buildSignalingUrl(sessionId);
      console.log(`[WebRtcService] Opening signaling WebSocket: ${url}`);

      const ws = new WebSocket(url);
      this.signalingSocket = ws;

      /** Whether the connect() promise has already been settled. */
      let settled = false;

      /** Timer handle for the connection timeout. */
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      /** Settle the promise exactly once. */
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;

        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      // ── Timeout guard ────────────────────────────────────────────────────
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        console.warn(`[WebRtcService] Connection timed out after ${CONNECT_TIMEOUT_MS}ms`);
        this.connectionState.set('failed');
        settle(new Error(`WebRTC connection timed out after ${CONNECT_TIMEOUT_MS}ms`));
        this.disconnect();
      }, CONNECT_TIMEOUT_MS);

      // ── WebSocket open ───────────────────────────────────────────────────
      ws.addEventListener('open', () => {
        console.log('[WebRtcService] Signaling WebSocket open — creating RTCPeerConnection');

        const pc = new RTCPeerConnection({ iceServers: [] });
        this.peerConnection = pc;

        // ── Track handler — expose the remote MediaStream ─────────────────
        pc.addEventListener('track', (event: RTCTrackEvent) => {
          const stream =
            event.streams.length > 0
              ? event.streams[0]
              : (() => {
                  const ms = new MediaStream();
                  ms.addTrack(event.track);
                  return ms;
                })();

          console.log('[WebRtcService] Remote track received');
          this.remoteStream.set(stream);
        });

        // ── ICE candidate — forward to server ────────────────────────────
        pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
          if (event.candidate === null) return; // end-of-candidates marker

          const message: SignalingMessage = {
            type: 'candidate',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? undefined,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
          };

          this.sendSignalingMessage(message);
        });

        // ── Connection state changes ──────────────────────────────────────
        pc.addEventListener('connectionstatechange', () => {
          const state = pc.connectionState;
          console.log(`[WebRtcService] RTCPeerConnection state: ${state}`);

          switch (state) {
            case 'connecting':
              this.connectionState.set('connecting');
              break;
            case 'connected':
              this.connectionState.set('connected');
              settle(); // resolve the connect() promise
              break;
            case 'disconnected':
              this.connectionState.set('disconnected');
              break;
            case 'failed':
              this.connectionState.set('failed');
              settle(new Error('RTCPeerConnection entered failed state'));
              break;
            case 'closed':
              this.connectionState.set('disconnected');
              break;
            // 'new' — no state update needed
          }
        });

        // ── SDP negotiation ───────────────────────────────────────────────
        void this.negotiate(pc).catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          console.warn('[WebRtcService] SDP negotiation failed:', error.message);
          this.connectionState.set('failed');
          settle(error);
          this.disconnect();
        });
      });

      // ── WebSocket message ────────────────────────────────────────────────
      ws.addEventListener('message', (event: MessageEvent) => {
        let msg: SignalingMessage;

        try {
          msg = JSON.parse(event.data as string) as SignalingMessage;
        } catch {
          console.warn('[WebRtcService] Failed to parse signaling message:', event.data);
          return;
        }

        this.handleSignalingMessage(msg, settle);
      });

      // ── WebSocket close ──────────────────────────────────────────────────
      ws.addEventListener('close', (event: CloseEvent) => {
        console.log(
          `[WebRtcService] Signaling WebSocket closed (code=${event.code}, clean=${event.wasClean})`,
        );

        // Only treat as an error if we haven't already connected successfully.
        if (this.connectionState() !== 'connected') {
          this.connectionState.set('failed');
          settle(
            new Error(
              `Signaling WebSocket closed unexpectedly (code=${event.code}) before connection was established`,
            ),
          );
        }
      });

      // ── WebSocket error ──────────────────────────────────────────────────
      ws.addEventListener('error', (event: Event) => {
        console.warn('[WebRtcService] Signaling WebSocket error:', event);
        // The browser always fires a close event after an error; let the close
        // handler reject the promise to avoid double-settling.
      });
    });
  }

  /**
   * Tear down the WebRTC session.
   *
   * Closes the `RTCPeerConnection` and the signaling WebSocket, resets both
   * signals, and nulls all internal references. Safe to call multiple times.
   */
  disconnect(): void {
    if (this.peerConnection !== null) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.signalingSocket !== null) {
      // Remove event listeners before closing so stale handlers don't fire.
      const ws = this.signalingSocket;
      this.signalingSocket = null;

      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }

    this.connectionState.set('disconnected');
    this.remoteStream.set(null);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Build the signaling WebSocket URL from `window.location`, deriving the
   * correct protocol (`ws:` / `wss:`) to match the page's protocol.
   *
   * @param sessionId - The WMS session ID.
   * @returns The fully-qualified WebSocket URL.
   */
  private buildSignalingUrl(sessionId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/webrtc/${sessionId}`;
  }

  /**
   * Perform the SDP offer/answer negotiation sequence:
   * 1. Add a receive-only video transceiver.
   * 2. Create and set the local SDP offer.
   * 3. Send the offer to the server.
   * 4. Await the server's SDP answer and set it as the remote description.
   *
   * ICE candidate messages are handled independently in the WebSocket message
   * listener (they arrive interleaved with the answer).
   *
   * @param pc - The `RTCPeerConnection` to negotiate on.
   */
  private async negotiate(pc: RTCPeerConnection): Promise<void> {
    // Signal to the remote side that we only want to receive video.
    pc.addTransceiver('video', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log('[WebRtcService] Sending SDP offer');
    this.sendSignalingMessage({ type: 'offer', sdp: offer.sdp ?? '' });

    // The answer arrives via the WebSocket message handler. We wait for it
    // by observing the peerConnection's remoteDescription. Instead, we hand
    // this off: the WS message handler calls pc.setRemoteDescription() when
    // it receives the answer. Nothing more to await here synchronously.
  }

  /**
   * Dispatch an incoming signaling message to the appropriate handler.
   *
   * @param msg - The parsed signaling message from the server.
   * @param settle - Callback to resolve or reject the pending `connect()` promise.
   */
  private handleSignalingMessage(
    msg: SignalingMessage,
    settle: (error?: Error) => void,
  ): void {
    const pc = this.peerConnection;

    switch (msg.type) {
      case 'answer':
        if (pc === null) {
          console.warn('[WebRtcService] Received answer but no RTCPeerConnection exists');
          return;
        }
        console.log('[WebRtcService] Received SDP answer — setting remote description');
        pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            console.warn('[WebRtcService] Failed to set remote description:', error.message);
            this.connectionState.set('failed');
            settle(error);
            this.disconnect();
          },
        );
        break;

      case 'candidate':
        if (pc === null) {
          console.warn('[WebRtcService] Received ICE candidate but no RTCPeerConnection exists');
          return;
        }
        pc.addIceCandidate({
          candidate: msg.candidate,
          sdpMid: msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex,
        }).catch((err: unknown) => {
          // Non-fatal: log and continue — stale candidates are common.
          console.warn('[WebRtcService] Failed to add ICE candidate:', err);
        });
        break;

      case 'error':
        console.warn('[WebRtcService] Server signaling error:', msg.message);
        this.connectionState.set('failed');
        settle(new Error(`Server signaling error: ${msg.message}`));
        this.disconnect();
        break;

      case 'offer':
        // We initiate the offer — receiving one from the server is unexpected.
        console.warn('[WebRtcService] Unexpected offer message received from server');
        break;
    }
  }

  /**
   * Serialize and send a signaling message over the WebSocket.
   * No-ops silently if the socket is not open.
   *
   * @param message - The signaling message to send.
   */
  private sendSignalingMessage(message: SignalingMessage): void {
    if (
      this.signalingSocket === null ||
      this.signalingSocket.readyState !== WebSocket.OPEN
    ) {
      console.warn('[WebRtcService] Cannot send message — WebSocket is not open');
      return;
    }

    this.signalingSocket.send(JSON.stringify(message));
  }
}
