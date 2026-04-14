import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock 'werift' BEFORE importing the service.
//
// vi.mock factories are hoisted to the top of the file by Vitest.  All classes
// and state used by the factory MUST be defined inside it (or use vi.hoisted).
// We expose the written-packets array and mock peer connection through a shared
// reference obtained via vi.hoisted so tests can inspect them after import.
// ---------------------------------------------------------------------------

const {
  writtenPackets,
  getMockPc,
  getMockVideoSender,
  MockRtpHeader,
  MockRtpPacket,
  MockMediaStreamTrack,
  MockRTCPeerConnection,
} = vi.hoisted(() => {
  /** Accumulates every RtpPacket written via MockMediaStreamTrack.writeRtp(). */
  const writtenPackets: Array<{ header: InstanceType<typeof MockRtpHeaderCls>; payload: Buffer }> = [];

  class MockRtpHeaderCls {
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    marker: boolean;
    ssrc: number;

    constructor(opts: {
      payloadType: number;
      sequenceNumber: number;
      timestamp: number;
      marker: boolean;
      ssrc: number;
    }) {
      this.payloadType = opts.payloadType;
      this.sequenceNumber = opts.sequenceNumber;
      this.timestamp = opts.timestamp;
      this.marker = opts.marker;
      this.ssrc = opts.ssrc;
    }
  }

  class MockRtpPacketCls {
    header: InstanceType<typeof MockRtpHeaderCls>;
    payload: Buffer;

    constructor(header: InstanceType<typeof MockRtpHeaderCls>, payload: Buffer) {
      this.header = header;
      this.payload = payload;
    }
  }

  class MockMediaStreamTrackCls {
    kind: string;
    ssrc = 12345;

    constructor(opts: { kind: string }) {
      this.kind = opts.kind;
    }

    writeRtp(packet: InstanceType<typeof MockRtpPacketCls>): void {
      // Deep-copy the payload so mutations to the fragment buffer don't corrupt captured data
      writtenPackets.push({
        header: packet.header,
        payload: Buffer.from(packet.payload),
      });
    }
  }

  const mockPliSubscription = { unSubscribe: vi.fn() };
  const mockVideoSender = {
    track: null as InstanceType<typeof MockMediaStreamTrackCls> | null,
    onPictureLossIndication: {
      subscribe: vi.fn(() => mockPliSubscription),
    },
  };

  const mockPc = {
    connectionState: 'new' as string,
    connectionStateChange: { subscribe: vi.fn(() => ({ unSubscribe: vi.fn() })) },
    onIceCandidate: { subscribe: vi.fn(() => ({ unSubscribe: vi.fn() })) },
    addTrack: vi.fn((track: InstanceType<typeof MockMediaStreamTrackCls>) => {
      mockVideoSender.track = track;
    }),
    getSenders: vi.fn(() => [mockVideoSender]),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    createAnswer: vi.fn().mockResolvedValue({ sdp: 'mock-answer-sdp', type: 'answer' }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  /**
   * RTCPeerConnection MUST be a real class (not an arrow function) because the
   * production code calls `new RTCPeerConnection(...)`.  Arrow functions cannot
   * be used as constructors and will throw "is not a constructor".
   *
   * We use Object.assign to copy all vi.fn() references from mockPc onto the
   * instance, so tests can inspect calls via getMockPc() — the method references
   * are identical (same vi.fn() objects).
   */
  class MockRTCPeerConnectionCls {
    connectionState!: string;
    connectionStateChange!: typeof mockPc.connectionStateChange;
    onIceCandidate!: typeof mockPc.onIceCandidate;
    addTrack!: typeof mockPc.addTrack;
    getSenders!: typeof mockPc.getSenders;
    setRemoteDescription!: typeof mockPc.setRemoteDescription;
    createAnswer!: typeof mockPc.createAnswer;
    setLocalDescription!: typeof mockPc.setLocalDescription;
    addIceCandidate!: typeof mockPc.addIceCandidate;
    close!: typeof mockPc.close;

    constructor(_opts?: unknown) {
      // Copy all properties (including vi.fn() references) from mockPc onto this
      // instance so that calls to pc.addTrack etc. ARE the same spy as mockPc.addTrack.
      Object.assign(this, mockPc);
    }
  }

  return {
    writtenPackets,
    getMockPc: () => mockPc,
    getMockVideoSender: () => mockVideoSender,
    MockRtpHeader: MockRtpHeaderCls,
    MockRtpPacket: MockRtpPacketCls,
    MockMediaStreamTrack: MockMediaStreamTrackCls,
    MockRTCPeerConnection: MockRTCPeerConnectionCls,
  };
});

vi.mock('werift', () => ({
  RTCPeerConnection: MockRTCPeerConnection,
  MediaStreamTrack: MockMediaStreamTrack,
  RtpPacket: MockRtpPacket,
  RtpHeader: MockRtpHeader,
  useH264: vi.fn(() => ({ mimeType: 'video/H264' })),
}));

// ---------------------------------------------------------------------------
// Mock screen-capture service — only requestKeyframe is called by the service.
// ---------------------------------------------------------------------------

vi.mock('./screen-capture.js', () => ({
  screenCaptureService: {
    requestKeyframe: vi.fn(),
  },
}));

import { WebRTCStreamService } from './webrtc-stream.js';
import type { NaluFrame } from './screen-capture.js';

// ---------------------------------------------------------------------------
// Helper — build a NaluFrame payload for test use.
// ---------------------------------------------------------------------------

function makeNaluFrame(
  naluData: Buffer,
  isKeyframe = false,
  timestampUs = 0n,
): NaluFrame {
  return { naluData, isKeyframe, timestampUs };
}

/**
 * Build a minimal Annex B buffer containing a single NALU.
 * Prepends a 4-byte start code (0x00 0x00 0x00 0x01) to the given body bytes.
 */
function annexB4(naluBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), naluBody]);
}

/**
 * Build an Annex B buffer with a 3-byte start code (0x00 0x00 0x01).
 */
function annexB3(naluBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01]), naluBody]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebRTCStreamService', () => {
  let service: WebRTCStreamService;
  let mockPc: ReturnType<typeof getMockPc>;
  let mockVideoSender: ReturnType<typeof getMockVideoSender>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset written packets before every test
    writtenPackets.length = 0;

    // Grab fresh references to the shared mock objects
    mockPc = getMockPc();
    mockVideoSender = getMockVideoSender();
    // Reset mock sender's track reference
    mockVideoSender.track = null;

    // Re-configure mock methods that get cleared by vi.clearAllMocks()
    mockPc.setRemoteDescription.mockResolvedValue(undefined);
    mockPc.createAnswer.mockResolvedValue({ sdp: 'mock-answer-sdp', type: 'answer' });
    mockPc.setLocalDescription.mockResolvedValue(undefined);
    mockPc.addIceCandidate.mockResolvedValue(undefined);
    mockPc.close.mockResolvedValue(undefined);
    mockPc.getSenders.mockReturnValue([mockVideoSender]);
    mockPc.addTrack.mockImplementation((track: InstanceType<typeof MockMediaStreamTrack>) => {
      mockVideoSender.track = track;
    });
    mockPc.connectionStateChange.subscribe.mockReturnValue({ unSubscribe: vi.fn() });
    mockPc.onIceCandidate.subscribe.mockReturnValue({ unSubscribe: vi.fn() });
    mockVideoSender.onPictureLossIndication.subscribe.mockReturnValue({ unSubscribe: vi.fn() });

    // Suppress log noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    service = new WebRTCStreamService();
  });

  afterEach(async () => {
    await service.cleanup();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // createSession()
  // -------------------------------------------------------------------------

  describe('createSession()', () => {
    it('returns an RTCPeerConnection', () => {
      // Act
      const pc = service.createSession('sess-create');

      // Assert — the returned pc is a mock RTCPeerConnection with the expected interface
      expect(pc).toBeInstanceOf(MockRTCPeerConnection);
      // And it delegates to the shared mock's methods
      expect(pc.addTrack).toBe(mockPc.addTrack);
    });

    it('creates a MediaStreamTrack and adds it to the peer connection', () => {
      // Act
      service.createSession('sess-track');

      // Assert — addTrack was called with a video MediaStreamTrack
      expect(mockPc.addTrack).toHaveBeenCalledTimes(1);
      const addedTrack = mockPc.addTrack.mock.calls[0]![0] as InstanceType<typeof MockMediaStreamTrack>;
      expect(addedTrack).toBeInstanceOf(MockMediaStreamTrack);
      expect(addedTrack.kind).toBe('video');
    });

    it('is idempotent — calling twice for the same sessionId returns the same peer connection', () => {
      // Act
      const first = service.createSession('sess-idem');
      const second = service.createSession('sess-idem');

      // Assert — same object reference returned
      expect(second).toBe(first);
      // And addTrack was only called once (not duplicated)
      expect(mockPc.addTrack).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // stopSession()
  // -------------------------------------------------------------------------

  describe('stopSession()', () => {
    it('closes the peer connection', async () => {
      // Arrange
      service.createSession('sess-stop-close');

      // Act
      await service.stopSession('sess-stop-close');

      // Assert
      expect(mockPc.close).toHaveBeenCalled();
    });

    it('is safe to call for an unknown sessionId', async () => {
      // Act & Assert — must not throw
      await expect(service.stopSession('nonexistent-webrtc-session')).resolves.toBeUndefined();
    });

    it('prevents further nalu events after session is stopped', async () => {
      // Arrange
      service.createSession('sess-stop-nalu');
      const captureEmitter = new EventEmitter();
      service.connectCapture('sess-stop-nalu', captureEmitter);

      // Stop the session
      await service.stopSession('sess-stop-nalu');

      // Act — emit nalu AFTER stopping
      const naluData = annexB4(Buffer.from([0x67, 0x42]));
      captureEmitter.emit('nalu', makeNaluFrame(naluData));

      // Give the event loop a tick
      await new Promise(resolve => setTimeout(resolve, 0));

      // Assert — no RTP packets written after stop (listener was removed)
      expect(writtenPackets.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // handleSignaling()
  // -------------------------------------------------------------------------

  describe('handleSignaling()', () => {
    it("returns an answer for an 'offer' message", async () => {
      // Arrange
      service.createSession('sess-signaling');

      // Act
      const response = await service.handleSignaling('sess-signaling', {
        type: 'offer',
        sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n',
      });

      // Assert
      expect(response).not.toBeNull();
      expect(response!.type).toBe('answer');
      expect((response as { type: string; sdp: string }).sdp).toBe('mock-answer-sdp');
    });

    it('calls setRemoteDescription, createAnswer, setLocalDescription in order', async () => {
      // Arrange
      service.createSession('sess-signaling-order');
      const callOrder: string[] = [];
      mockPc.setRemoteDescription.mockImplementation(async () => { callOrder.push('setRemote'); });
      mockPc.createAnswer.mockImplementation(async () => {
        callOrder.push('createAnswer');
        return { sdp: 'mock-answer-sdp', type: 'answer' };
      });
      mockPc.setLocalDescription.mockImplementation(async () => { callOrder.push('setLocal'); });

      // Act
      await service.handleSignaling('sess-signaling-order', { type: 'offer', sdp: 'test' });

      // Assert — operations executed in the correct order
      expect(callOrder).toEqual(['setRemote', 'createAnswer', 'setLocal']);
    });

    it("returns null for a 'candidate' message", async () => {
      // Arrange
      service.createSession('sess-candidate');

      // Act
      const response = await service.handleSignaling('sess-candidate', {
        type: 'candidate',
        candidate: 'candidate:0 1 UDP 123 192.168.1.1 1234 typ host',
      });

      // Assert
      expect(response).toBeNull();
    });

    it('adds the ICE candidate to the peer connection', async () => {
      // Arrange
      service.createSession('sess-add-ice');
      const candidateStr = 'candidate:0 1 UDP 123 192.168.1.1 1234 typ host';

      // Act
      await service.handleSignaling('sess-add-ice', {
        type: 'candidate',
        candidate: candidateStr,
      });

      // Assert
      expect(mockPc.addIceCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: candidateStr }),
      );
    });

    it('returns an error message for an unknown sessionId', async () => {
      // Act
      const response = await service.handleSignaling('unknown-sess', {
        type: 'offer',
        sdp: 'test',
      });

      // Assert
      expect(response).not.toBeNull();
      expect(response!.type).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // connectCapture() + feedNalu() — RTP packetization
  // -------------------------------------------------------------------------

  describe('connectCapture() + feedNalu()', () => {
    describe('splitAnnexB — tested via feedNalu', () => {
      it('single NALU with 4-byte start code produces exactly one RTP packet', () => {
        // Arrange
        service.createSession('sess-single-nalu');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-single-nalu', captureEmitter);

        // SPS body (no start code) — 6 bytes
        const spsBody = Buffer.from([0x67, 0x42, 0x00, 0x1f, 0xe9, 0x01]);
        const naluData = annexB4(spsBody);

        // Act
        captureEmitter.emit('nalu', makeNaluFrame(naluData, true, 1000000n));

        // Assert — exactly one RTP packet written
        expect(writtenPackets.length).toBe(1);

        // Payload is the raw NALU body WITHOUT the start code
        expect(writtenPackets[0]!.payload.equals(spsBody)).toBe(true);
      });

      it('multiple NALUs in one Annex B frame produce separate RTP packets', () => {
        // Arrange
        service.createSession('sess-multi-nalu-split');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-multi-nalu-split', captureEmitter);

        const spsBody = Buffer.from([0x67, 0x42, 0x00, 0x1f]);
        const ppsBody = Buffer.from([0x68, 0xce, 0x38]);
        const idrBody = Buffer.from([0x65, 0x88, 0x84]);

        // Build: [SC] SPS [SC] PPS [SC] IDR
        const annexBData = Buffer.concat([
          annexB4(spsBody),
          annexB4(ppsBody),
          annexB4(idrBody),
        ]);

        // Act
        captureEmitter.emit('nalu', makeNaluFrame(annexBData, true, 2000000n));

        // Assert — 3 separate RTP packets (one per NALU)
        expect(writtenPackets.length).toBe(3);
        expect(writtenPackets[0]!.payload.equals(spsBody)).toBe(true);
        expect(writtenPackets[1]!.payload.equals(ppsBody)).toBe(true);
        expect(writtenPackets[2]!.payload.equals(idrBody)).toBe(true);
      });

      it('handles 3-byte start codes (0x000001) correctly', () => {
        // Arrange
        service.createSession('sess-3byte-sc');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-3byte-sc', captureEmitter);

        const naluBody = Buffer.from([0x67, 0x42, 0x00, 0x1f, 0xe9]);
        const naluData = annexB3(naluBody);

        // Act
        captureEmitter.emit('nalu', makeNaluFrame(naluData, true, 500000n));

        // Assert — NALU was correctly split (start code stripped)
        expect(writtenPackets.length).toBe(1);
        expect(writtenPackets[0]!.payload.equals(naluBody)).toBe(true);
      });

      it('handles mixed 3-byte and 4-byte start codes in the same frame', () => {
        // Arrange
        service.createSession('sess-mixed-sc');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-mixed-sc', captureEmitter);

        const body1 = Buffer.from([0x67, 0x42]); // SPS
        const body2 = Buffer.from([0x68, 0xce]); // PPS

        // First NALU with 4-byte SC, second with 3-byte SC
        const annexBData = Buffer.concat([
          annexB4(body1),
          annexB3(body2),
        ]);

        // Act
        captureEmitter.emit('nalu', makeNaluFrame(annexBData, true, 300000n));

        // Assert — 2 separate NALUs extracted
        expect(writtenPackets.length).toBe(2);
        expect(writtenPackets[0]!.payload.equals(body1)).toBe(true);
        expect(writtenPackets[1]!.payload.equals(body2)).toBe(true);
      });

      it('produces no RTP packets for empty naluData', () => {
        // Arrange
        service.createSession('sess-empty-nalu');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-empty-nalu', captureEmitter);

        // Act — empty buffer has no start codes → splitAnnexB returns []
        captureEmitter.emit('nalu', makeNaluFrame(Buffer.alloc(0), false, 0n));

        // Assert
        expect(writtenPackets.length).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // Single NAL unit packets (RFC 6184 §5.6)
    // -----------------------------------------------------------------------

    describe('single NAL unit packets (NALU ≤ 1201 bytes)', () => {
      it('packetises a small NALU as a single NAL unit RTP packet', () => {
        // Arrange
        service.createSession('sess-single-nal');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-single-nal', captureEmitter);

        // Build a 100-byte SPS body
        const spsBody = Buffer.alloc(100, 0x42);
        spsBody[0] = 0x67; // SPS NAL unit type

        captureEmitter.emit('nalu', makeNaluFrame(annexB4(spsBody), true, 0n));

        // Assert — exactly one packet, payload = raw NALU body
        expect(writtenPackets.length).toBe(1);
        expect(writtenPackets[0]!.payload.equals(spsBody)).toBe(true);
      });

      it('sets marker=true on the last (and only) NALU in a frame', () => {
        // Arrange
        service.createSession('sess-marker-single');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-marker-single', captureEmitter);

        const body = Buffer.from([0x67, 0x42, 0x00, 0x1f]);
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body)));

        // Assert — marker bit is true
        expect(writtenPackets[0]!.header.marker).toBe(true);
      });

      it('sets marker=false on intermediate NALUs and marker=true only on the last', () => {
        // Arrange — 3 NALUs in one frame
        service.createSession('sess-marker-multi');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-marker-multi', captureEmitter);

        const b1 = Buffer.from([0x67, 0x01]);
        const b2 = Buffer.from([0x68, 0x02]);
        const b3 = Buffer.from([0x65, 0x03]);
        const annexBData = Buffer.concat([annexB4(b1), annexB4(b2), annexB4(b3)]);

        captureEmitter.emit('nalu', makeNaluFrame(annexBData, true, 0n));

        // Assert — first two have marker=false, last has marker=true
        expect(writtenPackets.length).toBe(3);
        expect(writtenPackets[0]!.header.marker).toBe(false);
        expect(writtenPackets[1]!.header.marker).toBe(false);
        expect(writtenPackets[2]!.header.marker).toBe(true);
      });

      it('uses payloadType 96 for all single NAL unit packets', () => {
        // Arrange
        service.createSession('sess-pt-96');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-pt-96', captureEmitter);

        const body = Buffer.from([0x67, 0x42, 0x00, 0x1f]);
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body)));

        // Assert
        expect(writtenPackets[0]!.header.payloadType).toBe(96);
      });

      it('increments sequence number by 1 per NALU packet', () => {
        // Arrange
        service.createSession('sess-seq-incr');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-seq-incr', captureEmitter);

        const b1 = Buffer.from([0x67, 0x01]);
        const b2 = Buffer.from([0x68, 0x02]);
        const b3 = Buffer.from([0x65, 0x03]);
        const annexBData = Buffer.concat([annexB4(b1), annexB4(b2), annexB4(b3)]);

        // Act — emit 3 NALUs in one frame
        captureEmitter.emit('nalu', makeNaluFrame(annexBData, true, 0n));

        // Assert — sequence numbers are consecutive
        const seq0 = writtenPackets[0]!.header.sequenceNumber;
        const seq1 = writtenPackets[1]!.header.sequenceNumber;
        const seq2 = writtenPackets[2]!.header.sequenceNumber;
        expect(seq1).toBe((seq0 + 1) & 0xFFFF);
        expect(seq2).toBe((seq0 + 2) & 0xFFFF);
      });

      it('correctly derives RTP timestamp from microsecond presentation timestamp', () => {
        // Arrange — 1 second = 1,000,000 µs → 90,000 ticks @ 90 kHz
        service.createSession('sess-rtp-ts');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-rtp-ts', captureEmitter);

        const body = Buffer.from([0x65, 0x88]);
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), true, 1000000n));

        // Assert — RTP timestamp = (1000000 * 90) / 1000 = 90000
        expect(writtenPackets[0]!.header.timestamp).toBe(90000);
      });

      it('correctly derives RTP timestamp for 2 seconds', () => {
        // Arrange — 2 seconds = 2,000,000 µs → 180,000 ticks
        service.createSession('sess-rtp-ts-2s');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-rtp-ts-2s', captureEmitter);

        const body = Buffer.from([0x65, 0x88]);
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, 2000000n));

        // Assert
        expect(writtenPackets[0]!.header.timestamp).toBe(180000);
      });

      it('correctly derives RTP timestamp for a fractional value', () => {
        // Arrange — 33333 µs → floor(33333 * 90 / 1000) = floor(2999.97) = 2999
        service.createSession('sess-rtp-ts-frac');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-rtp-ts-frac', captureEmitter);

        const body = Buffer.from([0x65, 0x88]);
        const timestampUs = 33333n;
        const expectedRtpTs = Number((timestampUs * 90n) / 1000n); // BigInt integer division
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, timestampUs));

        // Assert
        expect(writtenPackets[0]!.header.timestamp).toBe(expectedRtpTs);
      });

      it('wraps RTP timestamp at 32 bits when it overflows', () => {
        // Arrange — a very large timestamp that overflows 32 bits
        service.createSession('sess-rtp-ts-wrap');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-rtp-ts-wrap', captureEmitter);

        // Pick a value that causes overflow: just past 0xFFFFFFFF in 90 kHz units
        const timestampUs = (0x1_0000_0000n * 1000n) / 90n + 1n;
        const expectedRtpTs = Number(((timestampUs * 90n) / 1000n) & 0xFFFFFFFFn);

        const body = Buffer.from([0x65, 0x88]);
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, timestampUs));

        // Assert — the 32-bit mask is applied
        expect(writtenPackets[0]!.header.timestamp).toBe(expectedRtpTs);
      });

      it('all NALUs in the same frame share the same RTP timestamp', () => {
        // Arrange — multiple NALUs in one frame (2 seconds → 180000 ticks)
        service.createSession('sess-ts-shared');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-ts-shared', captureEmitter);

        const b1 = Buffer.from([0x67, 0x01]);
        const b2 = Buffer.from([0x68, 0x02]);
        const annexBData = Buffer.concat([annexB4(b1), annexB4(b2)]);

        captureEmitter.emit('nalu', makeNaluFrame(annexBData, true, 2000000n));

        // Assert — both packets share the same timestamp
        expect(writtenPackets[0]!.header.timestamp).toBe(180000);
        expect(writtenPackets[1]!.header.timestamp).toBe(180000);
      });

      it('sequence numbers carry over correctly across multiple frame emissions', () => {
        // Arrange
        service.createSession('sess-seq-across');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-seq-across', captureEmitter);

        const body = Buffer.from([0x65, 0x88]);

        // Emit 3 separate frames, each with a single NALU
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), true, 0n));
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, 1000n));
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, 2000n));

        // Assert — 3 packets with consecutive sequence numbers
        expect(writtenPackets.length).toBe(3);
        const seq0 = writtenPackets[0]!.header.sequenceNumber;
        expect(writtenPackets[1]!.header.sequenceNumber).toBe((seq0 + 1) & 0xFFFF);
        expect(writtenPackets[2]!.header.sequenceNumber).toBe((seq0 + 2) & 0xFFFF);
      });
    });

    // -----------------------------------------------------------------------
    // FU-A fragmentation packets (RFC 6184 §5.8)
    // -----------------------------------------------------------------------

    describe('FU-A fragmentation (NALU > 1201 bytes)', () => {
      it('fragments a 3000-byte NALU into multiple RTP packets', () => {
        // Arrange — NALU body of 3000 bytes (well above the 1201-byte threshold)
        service.createSession('sess-fua-multi');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-multi', captureEmitter);

        const naluHeader = 0x65; // IDR slice, NRI=3
        const naluBody = Buffer.alloc(3000, 0x11);
        naluBody[0] = naluHeader;
        const naluData = annexB4(naluBody);

        // Act
        captureEmitter.emit('nalu', makeNaluFrame(naluData, true, 1000000n));

        // Assert — more than 1 RTP packet was written
        expect(writtenPackets.length).toBeGreaterThan(1);
      });

      it('first FU-A fragment has S bit set and E bit clear in FU header', () => {
        // Arrange — 3000-byte NALU
        service.createSession('sess-fua-start');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-start', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(3000, 0x11);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 1000000n));

        // The first packet is the first FU-A fragment
        // FU-A packet layout: [FU indicator byte][FU header byte][fragment data...]
        const firstFuHeader = writtenPackets[0]!.payload[1]!;

        // Assert — S bit (0x80) is set, E bit (0x40) is clear
        expect(firstFuHeader & 0x80).toBe(0x80); // S bit set
        expect(firstFuHeader & 0x40).toBe(0x00); // E bit clear
      });

      it('last FU-A fragment has E bit set and S bit clear in FU header', () => {
        // Arrange — 3000-byte NALU
        service.createSession('sess-fua-end');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-end', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(3000, 0x11);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 1000000n));

        // The last packet is the final FU-A fragment
        const lastFuHeader = writtenPackets[writtenPackets.length - 1]!.payload[1]!;

        // Assert — E bit (0x40) is set, S bit (0x80) is clear
        expect(lastFuHeader & 0x40).toBe(0x40); // E bit set
        expect(lastFuHeader & 0x80).toBe(0x00); // S bit clear
      });

      it('middle FU-A fragments have neither S nor E bits set', () => {
        // Arrange — 3601-byte NALU body produces 4 fragments (3 × 1200 + 1 × 201)
        service.createSession('sess-fua-middle');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-middle', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(3601, 0x22);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 1000000n));

        // There must be at least 3 packets for this test to be meaningful
        expect(writtenPackets.length).toBeGreaterThanOrEqual(3);

        // Check all middle packets (not first, not last)
        for (let i = 1; i < writtenPackets.length - 1; i++) {
          const fuHeader = writtenPackets[i]!.payload[1]!;
          expect(fuHeader & 0x80).toBe(0x00); // S bit clear
          expect(fuHeader & 0x40).toBe(0x00); // E bit clear
        }
      });

      it('FU indicator byte is correctly derived from the original NALU header', () => {
        // Arrange — IDR slice: F=0, NRI=3, type=5 → header = 0x65
        service.createSession('sess-fua-indicator');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-indicator', captureEmitter);

        const naluHeader = 0x65; // F=0, NRI=3, type=5
        const naluBody = Buffer.alloc(2000, 0x33);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        const fuIndicator = writtenPackets[0]!.payload[0]!;

        // FU indicator = (naluHeader & 0x80) | (naluHeader & 0x60) | 28
        const expectedFuIndicator = (naluHeader & 0x80) | (naluHeader & 0x60) | 28;
        expect(fuIndicator).toBe(expectedFuIndicator);
      });

      it('FU header encodes the original NAL unit type in the low 5 bits', () => {
        // Arrange — NAL type=5 (IDR): 0x65
        service.createSession('sess-fua-type');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-type', captureEmitter);

        const naluHeader = 0x65; // type=5
        const naluBody = Buffer.alloc(2000, 0x44);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // FU header low 5 bits = original NAL type
        const fuHeader = writtenPackets[0]!.payload[1]!;
        expect(fuHeader & 0x1F).toBe(naluHeader & 0x1F); // type = 5
      });

      it('marker bit is true only on the very last FU-A fragment', () => {
        // Arrange
        service.createSession('sess-fua-marker');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-marker', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(2500, 0x55);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 1000000n));

        // All packets except the last have marker=false; last has marker=true
        for (let i = 0; i < writtenPackets.length - 1; i++) {
          expect(writtenPackets[i]!.header.marker).toBe(false);
        }
        expect(writtenPackets[writtenPackets.length - 1]!.header.marker).toBe(true);
      });

      it('FU-A fragments have consecutive sequence numbers', () => {
        // Arrange
        service.createSession('sess-fua-seq');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-seq', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(2500, 0x66);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // Assert — all fragments have consecutive (wrapping) sequence numbers
        expect(writtenPackets.length).toBeGreaterThan(1);
        for (let i = 1; i < writtenPackets.length; i++) {
          const prevSeq = writtenPackets[i - 1]!.header.sequenceNumber;
          const currSeq = writtenPackets[i]!.header.sequenceNumber;
          expect(currSeq).toBe((prevSeq + 1) & 0xFFFF);
        }
      });

      it('all FU-A fragments share the same RTP timestamp', () => {
        // Arrange
        service.createSession('sess-fua-shared-ts');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-shared-ts', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(2500, 0x77);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 1000000n));

        // All fragments should use the same RTP timestamp (90000 for 1 second)
        const expectedTs = 90000;
        for (const pkt of writtenPackets) {
          expect(pkt.header.timestamp).toBe(expectedTs);
        }
      });

      it('a NALU of exactly 1201 bytes is sent as a single NAL unit packet (not FU-A)', () => {
        // Arrange — 1201-byte NALU body (at the threshold, ≤ 1201 → single packet)
        service.createSession('sess-boundary-1201');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-boundary-1201', captureEmitter);

        const naluBody = Buffer.alloc(1201, 0x65);
        naluBody[0] = 0x65; // IDR type
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // Assert — exactly 1 packet, payload = raw NALU body (no 2-byte FU-A overhead)
        expect(writtenPackets.length).toBe(1);
        expect(writtenPackets[0]!.payload.equals(naluBody)).toBe(true);
      });

      it('a NALU of exactly 1202 bytes uses FU-A fragmentation', () => {
        // Arrange — 1202 bytes exceeds the 1201-byte threshold
        service.createSession('sess-boundary-1202');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-boundary-1202', captureEmitter);

        const naluBody = Buffer.alloc(1202, 0x65);
        naluBody[0] = 0x65;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // Assert — more than 1 packet (FU-A fragmentation applied)
        expect(writtenPackets.length).toBeGreaterThan(1);
      });

      it('FU-A fragment payloads reassemble to the original NALU body', () => {
        // Arrange — 3000-byte NALU body
        service.createSession('sess-fua-reassemble');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-reassemble', captureEmitter);

        const naluHeader = 0x65;
        const naluBody = Buffer.alloc(3000, 0x88);
        naluBody[0] = naluHeader;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // Reassemble: skip FU indicator (byte 0) and FU header (byte 1) from each fragment
        const fragments = writtenPackets.map(p => p.payload);
        const reassembledBodyParts = fragments.map(f => f.subarray(2));

        // Restore the original NALU header from FU indicator + FU header type bits
        const firstFuIndicator = fragments[0]![0]!;
        const firstFuHeader = fragments[0]![1]!;
        const restoredNaluHeader = (firstFuIndicator & 0xE0) | (firstFuHeader & 0x1F);

        const reassembled = Buffer.concat([Buffer.from([restoredNaluHeader]), ...reassembledBodyParts]);

        // Assert — reassembled bytes exactly match the original NALU body
        expect(reassembled.equals(naluBody)).toBe(true);
      });

      it('uses payloadType 96 for all FU-A fragment packets', () => {
        // Arrange
        service.createSession('sess-fua-pt');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-fua-pt', captureEmitter);

        const naluBody = Buffer.alloc(2000, 0x65);
        naluBody[0] = 0x65;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(naluBody), true, 0n));

        // Assert — all FU-A packets use PT 96
        for (const pkt of writtenPackets) {
          expect(pkt.header.payloadType).toBe(96);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Sequence number wrapping
    // -----------------------------------------------------------------------

    describe('sequence number wrapping', () => {
      it('sequence number wraps from 65535 to 0', () => {
        // Arrange — discover initial sequence number, then advance to 65535 and check wrap
        service.createSession('sess-seq-wrap');
        const captureEmitter = new EventEmitter();
        service.connectCapture('sess-seq-wrap', captureEmitter);

        const body = Buffer.from([0x67, 0x42]);

        // Emit a single-NALU frame to discover the initial sequence number
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, 0n));
        const initialSeq = writtenPackets[0]!.header.sequenceNumber;
        writtenPackets.length = 0;

        // Emit frames until we reach sequence 65535
        const stepsToMax = (65535 - initialSeq + 65536) % 65536;
        for (let i = 0; i < stepsToMax; i++) {
          captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, BigInt(i)));
        }
        expect(writtenPackets[writtenPackets.length - 1]!.header.sequenceNumber).toBe(65535);

        // Emit one more frame — sequence should wrap to 0
        writtenPackets.length = 0;
        captureEmitter.emit('nalu', makeNaluFrame(annexB4(body), false, BigInt(stepsToMax)));
        expect(writtenPackets[0]!.header.sequenceNumber).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // connectCapture() idempotency / cleanup
    // -----------------------------------------------------------------------

    describe('connectCapture()', () => {
      it('is safe to call for an unknown sessionId — warns and does not throw', () => {
        // Arrange — no session created
        const captureEmitter = new EventEmitter();

        // Act & Assert — must not throw
        expect(() => service.connectCapture('unknown-webrtc-session', captureEmitter)).not.toThrow();
      });

      it('replaces the previous NALU listener when called twice for the same session', () => {
        // Arrange
        service.createSession('sess-replace-listener');
        const emitter1 = new EventEmitter();
        const emitter2 = new EventEmitter();

        service.connectCapture('sess-replace-listener', emitter1);
        service.connectCapture('sess-replace-listener', emitter2);

        const body = Buffer.from([0x65, 0x88]);

        // Emit on emitter1 — old listener should be removed, no packets written
        emitter1.emit('nalu', makeNaluFrame(annexB4(body), false, 0n));
        expect(writtenPackets.length).toBe(0);

        // Emit on emitter2 — new listener should fire
        emitter2.emit('nalu', makeNaluFrame(annexB4(body), false, 1000n));
        expect(writtenPackets.length).toBe(1);
      });
    });
  });
});
