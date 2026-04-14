import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
  useH264,
} from 'werift';
import type { EventEmitter } from 'node:events';
import type { NaluFrame } from './screen-capture.js';
import { screenCaptureService } from './screen-capture.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WebRTCStreamService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Signaling messages exchanged over the WebSocket with the browser.
 *
 * - `offer`     — SDP offer from the browser.
 * - `answer`    — SDP answer from the server.
 * - `candidate` — ICE candidate (trickle ICE).
 * - `error`     — Error message from the server.
 */
export type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  | { type: 'error'; message: string };

/** Internal state for a single WebRTC peer connection session. */
interface WebRTCSession {
  /** The WMS session ID that owns this WebRTC session. */
  sessionId: string;
  /** The WebRTC peer connection. */
  pc: RTCPeerConnection;
  /** The video track fed with H.264 RTP packets. */
  videoTrack: MediaStreamTrack;
  /** Unsubscribe function for the capture emitter's `'nalu'` event. */
  naluCleanup: (() => void) | null;
  /** RTP sequence number (wraps at 65536). */
  sequenceNumber: number;
  /** RTP timestamp (derived from 90 kHz clock). */
  rtpTimestamp: number;
  /** Whether initial SPS/PPS have been sent (currently informational). */
  parameterSetsSent: boolean;
  /** Tracks the last NALU timestamp fed to the session for gap detection. */
  lastFedTimestampUs?: bigint;
  /** Running count of RTP packets written to the video track (diagnostic). */
  rtpPacketsSent: number;
}

// ---------------------------------------------------------------------------
// Helper — Annex B splitter
// ---------------------------------------------------------------------------

/**
 * Split an Annex B byte stream into individual NAL units (without start
 * codes).
 *
 * Recognises both 4-byte (`0x00000001`) and 3-byte (`0x000001`) start codes.
 *
 * @param data - Buffer containing one or more NALUs in Annex B format.
 * @returns Array of `Buffer` slices, each containing exactly one NALU
 *          (the start code bytes are not included).
 */
function splitAnnexB(data: Buffer): Buffer[] {
  const nalus: Buffer[] = [];
  let i = 0;
  let naluStart = -1;

  while (i < data.length) {
    // 4-byte start code: 0x00 0x00 0x00 0x01
    if (
      i + 3 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      if (naluStart >= 0) {
        nalus.push(data.subarray(naluStart, i));
      }
      i += 4;
      naluStart = i;
    // 3-byte start code: 0x00 0x00 0x01
    } else if (
      i + 2 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1
    ) {
      if (naluStart >= 0) {
        nalus.push(data.subarray(naluStart, i));
      }
      i += 3;
      naluStart = i;
    } else {
      i++;
    }
  }

  if (naluStart >= 0 && naluStart < data.length) {
    nalus.push(data.subarray(naluStart));
  }

  return nalus;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Manages per-session WebRTC peer connections for H.264 video streaming.
 *
 * Each WMS session can have at most one WebRTC session.  The service:
 *  1. Creates an `RTCPeerConnection` configured with the H.264 codec.
 *  2. Accepts the SDP offer/answer handshake and trickle ICE via
 *     {@link handleSignaling}.
 *  3. Subscribes to `'nalu'` events from a {@link ScreenCaptureService}
 *     emitter and packetises the Annex B data into H.264 RTP packets
 *     (single NAL unit or FU-A fragmentation) via {@link feedNalu}.
 *
 * Export the singleton {@link webRTCStreamService} rather than constructing
 * instances directly.
 */
export class WebRTCStreamService {
  /** Active WebRTC sessions keyed by WMS session ID. */
  private readonly sessions = new Map<string, WebRTCSession>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new WebRTC peer connection for the given WMS session and return
   * it.  The caller is responsible for driving the signaling exchange via
   * {@link handleSignaling}.
   *
   * If a WebRTC session already exists for `sessionId` its existing peer
   * connection is returned unchanged.
   *
   * @param sessionId - WMS session ID to create a peer connection for.
   * @returns The newly created (or existing) `RTCPeerConnection`.
   */
  createSession(sessionId: string): RTCPeerConnection {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      log(`WebRTC session already exists for ${sessionId} — returning existing peer connection`);
      return existing.pc;
    }

    const pc = new RTCPeerConnection({
      codecs: {
        video: [useH264()],
      },
    });

    const videoTrack = new MediaStreamTrack({ kind: 'video' });
    pc.addTrack(videoTrack);

    const session: WebRTCSession = {
      sessionId,
      pc,
      videoTrack,
      naluCleanup: null,
      sequenceNumber: Math.floor(Math.random() * 65536),
      rtpTimestamp: Math.floor(Math.random() * 0xFFFFFFFF),
      parameterSetsSent: false,
      rtpPacketsSent: 0,
    };

    this.sessions.set(sessionId, session);
    log(`WebRTC session created for ${sessionId}`);

    return pc;
  }

  /**
   * Subscribe to a capture emitter's `'nalu'` events and feed the H.264 data
   * into the WebRTC video track for the given session.
   *
   * Safe to call multiple times — the previous NALU subscription is cleaned up
   * before the new one is installed.
   *
   * @param sessionId - WMS session ID whose WebRTC track should receive NALUs.
   * @param emitter   - `EventEmitter` that emits `'nalu'` events with
   *                    {@link NaluFrame} payloads.
   */
  connectCapture(sessionId: string, emitter: EventEmitter): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      warn(`connectCapture: no WebRTC session for ${sessionId}`);
      return;
    }

    // Remove any previous NALU listener before installing the new one.
    if (session.naluCleanup) {
      session.naluCleanup();
      session.naluCleanup = null;
    }

    const onNalu = (frame: NaluFrame): void => {
      this.feedNalu(session, frame);
    };

    emitter.on('nalu', onNalu);

    session.naluCleanup = (): void => {
      emitter.off('nalu', onNalu);
    };

    // Subscribe to PLI (Picture Loss Indication) from the browser.
    // When the browser loses decoder state it sends an RTCP PLI requesting
    // a new keyframe.  Forward this to the capture binary.
    const senders = session.pc.getSenders();
    const videoSender = senders.find((s) => s.track === session.videoTrack);
    if (videoSender && typeof (videoSender as any).onPictureLossIndication?.subscribe === 'function') {
      const pliSub = (videoSender as any).onPictureLossIndication.subscribe(() => {
        log(`PLI received for session ${sessionId} — requesting keyframe`);
        screenCaptureService.requestKeyframe(sessionId);
      });
      // Augment the cleanup to also unsubscribe PLI.
      const originalCleanup = session.naluCleanup;
      session.naluCleanup = (): void => {
        originalCleanup?.();
        pliSub.unSubscribe();
      };
    }

    // Reset parameter-set tracking so the first keyframe after connection
    // is properly recognised as carrying the decoder-initialisation data.
    session.parameterSetsSent = false;

    // [DIAG] Verify sender codec and DTLS transport state after wiring up capture.
    const diagSenders = session.pc.getSenders();
    const diagVideoSender = diagSenders.find((s) => s.track === session.videoTrack);
    if (diagVideoSender) {
      log(`[DIAG] Sender state for ${sessionId}: codec=${JSON.stringify((diagVideoSender as any).codec?.mimeType)}, dtlsState=${(diagVideoSender as any).dtlsTransport?.state}, ssrc=${(diagVideoSender as any).ssrc}`);
    } else {
      warn(`[DIAG] No video sender found for ${sessionId}!`);
    }

    log(`Capture emitter connected to WebRTC session ${sessionId}`);
  }

  /**
   * Process a signaling message from the browser and return a response
   * message to send back, or `null` if no response is needed.
   *
   * Supports:
   * - `'offer'`    — Sets remote description and returns an `'answer'`.
   * - `'candidate'` — Adds a trickle ICE candidate; returns `null`.
   *
   * @param sessionId - WMS session ID the message belongs to.
   * @param message   - The signaling message received from the browser.
   * @returns A response {@link SignalingMessage} or `null`.
   */
  async handleSignaling(
    sessionId: string,
    message: SignalingMessage,
  ): Promise<SignalingMessage | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      warn(`handleSignaling: no WebRTC session for ${sessionId}`);
      return { type: 'error', message: `No WebRTC session for session ${sessionId}` };
    }

    const { pc } = session;

    if (message.type === 'offer') {
      log(`Handling SDP offer for session ${sessionId}`);
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });

      // ── Fix #40: Reorder negotiated codecs to prefer Constrained Baseline ──
      // werift's findCodecByMimeType matches only by mimeType, ignoring
      // profile-level-id. This means transceiver.codecs[0] may be the
      // browser's High Profile H.264 (640c1f) while our Swift encoder
      // produces Baseline (42e01f). Reorder so the matching profile is first,
      // then update the sender's codec to match.
      // This runs BEFORE createAnswer() so that the generated SDP answer lists
      // the preferred codec (PT for Constrained Baseline) first in the m= line.
      // Guard: getTransceivers() may be absent on some werift builds / mocks.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transceivers: any[] =
        typeof (pc as any).getTransceivers === 'function'
          ? (pc as any).getTransceivers()
          : [];
      const videoTransceiver = transceivers.find(
        (t: any) => t.kind === 'video' || t.sender?.track?.kind === 'video',
      );
      if (videoTransceiver && videoTransceiver.codecs.length > 1) {
        const TARGET_PROFILE = '42e01f';
        const matchIdx = videoTransceiver.codecs.findIndex((c: any) => {
          const params: string = c.parameters ?? '';
          return (
            params.includes(`profile-level-id=${TARGET_PROFILE}`) &&
            params.includes('packetization-mode=1')
          );
        });
        if (matchIdx > 0) {
          // Move the matching codec to index 0.
          const [matched] = videoTransceiver.codecs.splice(matchIdx, 1);
          videoTransceiver.codecs.unshift(matched);
          // Update sender.codec to use the reordered first codec so that
          // sendRtp() uses the correct payload type.
          (videoTransceiver.sender as any).codec = videoTransceiver.codecs[0];
          const selectedPt: number = (videoTransceiver.codecs[0] as any)?.payloadType ?? -1;
          log(`[Fix #40] Reordered H.264 codecs: preferred profile-level-id=${TARGET_PROFILE} (PT ${selectedPt})`);
          log(`[DIAG] Fix #40 selected codec: profile-level-id=${TARGET_PROFILE}, payloadType=${selectedPt}`);
        } else if (matchIdx === 0) {
          const selectedPt: number = (videoTransceiver.codecs[0] as any)?.payloadType ?? -1;
          log(`[Fix #40] H.264 codec already preferred: profile-level-id=${TARGET_PROFILE} (PT ${selectedPt})`);
          log(`[DIAG] Fix #40 selected codec: profile-level-id=${TARGET_PROFILE}, payloadType=${selectedPt}`);
        } else {
          warn(`[Fix #40] No H.264 codec with profile-level-id=${TARGET_PROFILE} found in negotiated codecs — using default`);
          const fallbackPt: number = (videoTransceiver.codecs[0] as any)?.payloadType ?? -1;
          const fallbackParams: string = (videoTransceiver.codecs[0] as any)?.parameters ?? 'unknown';
          log(`[DIAG] Fix #40 fallback codec: parameters=${fallbackParams}, payloadType=${fallbackPt}`);
        }
      } else if (videoTransceiver && videoTransceiver.codecs.length === 1) {
        const onlyPt: number = (videoTransceiver.codecs[0] as any)?.payloadType ?? -1;
        const onlyParams: string = (videoTransceiver.codecs[0] as any)?.parameters ?? 'unknown';
        log(`[Fix #40] Only one H.264 codec negotiated — no reordering needed (PT ${onlyPt}, parameters=${onlyParams})`);
      } else if (!videoTransceiver) {
        warn(`[Fix #40] No video transceiver found — skipping codec reorder`);
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return { type: 'answer', sdp: answer.sdp };
    }

    if (message.type === 'candidate') {
      await pc.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid,
      });
      return null;
    }

    // Ignore answer/error messages from the browser.
    return null;
  }

  /**
   * Stop and clean up the WebRTC session for the given WMS session ID.
   *
   * Unsubscribes the NALU listener and closes the peer connection.
   * Safe to call even if no session exists for `sessionId`.
   *
   * @param sessionId - WMS session ID to stop.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    log(`Stopping WebRTC session for ${sessionId}`);

    if (session.naluCleanup) {
      session.naluCleanup();
      session.naluCleanup = null;
    }

    try {
      await session.pc.close();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      warn(`Error closing peer connection for session ${sessionId}: ${errMsg}`);
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Stop all active WebRTC sessions.  Called during server shutdown.
   */
  async cleanup(): Promise<void> {
    log(`Stopping all ${this.sessions.size} active WebRTC session(s)…`);
    const stopPromises: Promise<void>[] = [];
    for (const sessionId of this.sessions.keys()) {
      stopPromises.push(this.stopSession(sessionId));
    }
    await Promise.all(stopPromises);
  }

  // -------------------------------------------------------------------------
  // Private — RTP packetisation
  // -------------------------------------------------------------------------

  /**
   * Packetise a raw Annex B H.264 frame into one or more RTP packets and
   * write them to the session's video track.
   *
   * Implements RFC 6184 packetisation:
   * - **Single NAL unit** packets for NALUs ≤ 1201 bytes.
   * - **FU-A fragmentation** for NALUs > 1201 bytes.
   *
   * The RTP timestamp is derived from the capture presentation timestamp
   * using the standard H.264 90 kHz clock rate.
   *
   * @param session - The WebRTC session to feed.
   * @param frame   - The parsed H.264 NALU frame from the capture process.
   */
  private feedNalu(session: WebRTCSession, frame: NaluFrame): void {
    const { videoTrack } = session;

    // [DIAG] On the very first packet, inspect sender codec and DTLS state to
    // catch the most common silent-drop causes in werift.
    if (session.rtpPacketsSent === 0) {
      const senders = session.pc.getSenders();
      const videoSender = senders.find((s) => s.track === session.videoTrack);
      const senderCodec = (videoSender as any)?.codec;
      const dtlsState = (videoSender as any)?.dtlsTransport?.state;
      log(`[DIAG] First feedNalu for ${session.sessionId}: senderCodec=${JSON.stringify(senderCodec?.mimeType ?? null)}, parameters=${senderCodec?.parameters ?? 'none'}, dtlsState=${dtlsState}, payloadType=${senderCodec?.payloadType ?? 'none'}`);
      if (!senderCodec) {
        warn(`[DIAG] CRITICAL: sender.codec is FALSY — all RTP packets will be silently dropped by werift!`);
      }
      if (dtlsState !== 'connected') {
        warn(`[DIAG] CRITICAL: DTLS state is "${dtlsState}" — all RTP packets will be silently dropped by werift!`);
      }
    }

    // Convert presentation timestamp from µs to 90 kHz RTP clock units.
    const rtpTimestamp = Number(((frame.timestampUs * 90n) / 1000n) & 0xFFFFFFFFn);

    // Detect large timestamp gaps (>2 seconds) and proactively request a keyframe
    // so the browser decoder can recover without waiting for a PLI round-trip.
    const GAP_THRESHOLD_US = 2_000_000n; // 2 seconds in microseconds
    if (session.lastFedTimestampUs !== undefined) {
      const gap = frame.timestampUs - session.lastFedTimestampUs;
      if (gap > GAP_THRESHOLD_US) {
        log(`Large timestamp gap for session ${session.sessionId}: ${Number(gap / 1000n)}ms — requesting keyframe`);
        screenCaptureService.requestKeyframe(session.sessionId);
      }
    }
    session.lastFedTimestampUs = frame.timestampUs;

    // Split the Annex B stream into individual NALUs.
    const nalus = splitAnnexB(frame.naluData);
    if (nalus.length === 0) return;

    // [DIAG] Log NALU types on the first packet and every 100th packet thereafter.
    if (session.rtpPacketsSent === 0 || session.rtpPacketsSent % 100 === 0) {
      const naluTypes = nalus.map(n => n.length > 0 ? (n[0]! & 0x1F) : -1);
      log(`[DIAG] feedNalu #${session.rtpPacketsSent} for ${session.sessionId}: naluCount=${nalus.length}, types=[${naluTypes.join(',')}], keyframe=${frame.isKeyframe}, ts=${frame.timestampUs}µs, rtpTs=${rtpTimestamp}`);
    }

    const ssrc = 0; // videoTrack.ssrc is always undefined — the real SSRC is managed by
    // RTCRtpSender which overwrites the header field in sendRtp().
    // Pass 0 as a placeholder; it will be replaced before transmission.

    for (let i = 0; i < nalus.length; i++) {
      const nalu = nalus[i]!;
      const isLastNalu = i === nalus.length - 1;

      if (nalu.length === 0) continue;

      if (nalu.length <= 1201) {
        // ----------------------------------------------------------------
        // Single NAL unit packet (RFC 6184 §5.6)
        // ----------------------------------------------------------------
        const header = new RtpHeader({
          payloadType: 96,
          sequenceNumber: session.sequenceNumber,
          timestamp: rtpTimestamp,
          marker: isLastNalu,
          ssrc,
        });
        const packet = new RtpPacket(header, Buffer.from(nalu));
        videoTrack.writeRtp(packet);
        session.sequenceNumber = (session.sequenceNumber + 1) & 0xFFFF;
        session.rtpPacketsSent++;
      } else {
        // ----------------------------------------------------------------
        // FU-A fragmentation (RFC 6184 §5.8)
        // ----------------------------------------------------------------
        const naluHeader = nalu[0]!;
        const nri = naluHeader & 0x60;        // NRI bits (bits 5–6)
        const naluType = naluHeader & 0x1F;   // NAL unit type (bits 0–4)

        const MAX_FRAGMENT = 1200;
        // Start after the NALU header byte — it's encoded in the FU indicator + FU header.
        let offset = 1;

        while (offset < nalu.length) {
          const isStart = offset === 1;
          const end = Math.min(offset + MAX_FRAGMENT, nalu.length);
          const isEnd = end === nalu.length;

          // FU indicator: F(1) | NRI(2) | Type=28 (FU-A)
          const fuIndicator = (naluHeader & 0x80) | nri | 28;
          // FU header:    S(1) | E(1) | R(1) | Type(5)
          const fuHeader = (isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | naluType;

          const fragmentSize = end - offset;
          const fragment = Buffer.allocUnsafe(2 + fragmentSize);
          fragment[0] = fuIndicator;
          fragment[1] = fuHeader;
          nalu.copy(fragment, 2, offset, end);

          const header = new RtpHeader({
            payloadType: 96,
            sequenceNumber: session.sequenceNumber,
            timestamp: rtpTimestamp,
            // Marker bit only on the very last fragment of the last NALU in the frame.
            marker: isLastNalu && isEnd,
            ssrc,
          });
          const packet = new RtpPacket(header, fragment);
          videoTrack.writeRtp(packet);
          session.sequenceNumber = (session.sequenceNumber + 1) & 0xFFFF;
          session.rtpPacketsSent++;

          offset = end;
        }
      }
    }

    // Mark parameter sets as sent once a keyframe has been processed.
    if (frame.isKeyframe && !session.parameterSetsSent) {
      session.parameterSetsSent = true;
    }

    // [DIAG] Log a summary after the first few keyframes to confirm RTP output.
    if (frame.isKeyframe && session.rtpPacketsSent < 50) {
      log(`[DIAG] Keyframe sent for ${session.sessionId}: totalRtpPackets=${session.rtpPacketsSent}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const webRTCStreamService = new WebRTCStreamService();
