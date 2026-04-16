import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { readFile, unlink, writeFile, access, constants as fsConstants } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Promisified execFile variants
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed H.264 NALU frame from the capture process.
 */
export interface NaluFrame {
  /** Raw H.264 data in Annex B format (with 0x00000001 start codes). */
  naluData: Buffer;
  /** Whether this frame contains a keyframe (IDR). */
  isKeyframe: boolean;
  /** Presentation timestamp in microseconds. */
  timestampUs: bigint;
}

/**
 * Public metadata for a single active screen-capture session.
 * Does not include the internal emitter or abort controller.
 */
export interface CaptureSession {
  /** The session ID this capture belongs to. */
  sessionId: string;
  /** Platform being captured. */
  platform: 'ios' | 'android';
  /** iOS UDID or Android serial (e.g. `'emulator-5554'`). */
  deviceId: string;
  /** Target frames-per-second. Actual FPS may be lower if capture latency exceeds the frame budget. */
  targetFps: number;
  /** Whether the capture loop is actively running. */
  active: boolean;
  /** Output format for iOS capture: 'jpeg' for MJPEG streaming, 'h264' for WebRTC. */
  captureFormat: 'jpeg' | 'h264';
}

/** Internal record that adds runtime state to CaptureSession. */
interface InternalCaptureSession extends CaptureSession {
  emitter: EventEmitter;
  /** Used by Android polling loop to signal stop. */
  abortController: AbortController;
  /** iOS only: the persistent capture child process. */
  captureProcess?: ChildProcess;
  /** iOS only: accumulates partial frame data read from the capture process stdout. */
  frameBuffer: Buffer;
  /** H.264 frame counter for observability logging. */
  h264FrameCount?: number;
  /** Timestamp of the last H.264 observability log. */
  lastH264LogTime?: number;
  /** The iOS device UDID (used for captureDeviceId). */
  captureDeviceId?: string;
  /**
   * iOS only: `true` when the SimDeviceIO binary is being used for capture,
   * `false` when the SCK (ScreenCaptureKit) binary is being used.
   * `undefined` before the binary selection has been resolved.
   */
  useSimDeviceIO?: boolean;
  /** Android scrcpy: the TCP socket connected to scrcpy-server. */
  scrcpySocket?: Socket;
  /** Android scrcpy: the `adb shell` process running scrcpy-server on-device. */
  scrcpyServerProcess?: ChildProcess;
  /** Android scrcpy: the local TCP port allocated by `adb forward tcp:0 …`. */
  scrcpyForwardPort?: number;
  /** Android scrcpy: buffered SPS/PPS config data to prepend to the next media packet. */
  scrcpyConfigBuffer?: Buffer;
  /** Cached last keyframe NaluFrame for replay on new WebSocket connections. */
  lastKeyframe?: NaluFrame;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[ScreenCaptureService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default frames-per-second target if none is specified. */
const DEFAULT_TARGET_FPS = 30;

/** Maximum consecutive capture failures before the loop is stopped. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Milliseconds to wait after a capture failure before retrying. */
const FAILURE_RETRY_DELAY_MS = 500;

/**
 * Environment overrides for all `xcrun` calls.
 * Sets `DEVELOPER_DIR` so `xcrun` resolves tools (like `simctl`) from the
 * full Xcode.app bundle, even when `xcode-select -p` points to the
 * standalone Command Line Tools.
 */
const XCRUN_EXEC_OPTIONS: import('node:child_process').ExecFileOptions = {
  env: {
    ...process.env,
    DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
  },
};

/** Fully-qualified path to the `adb` binary derived from config. */
const ADB = `${config.androidSdkRoot}/platform-tools/adb`;

/** Path where the compiled iOS capture binary is cached across server restarts. */
const CAPTURE_BINARY_PATH = join(tmpdir(), 'wms-ios-capture-stream');

/** Temp path used to write the Swift source before compilation. */
const CAPTURE_SWIFT_TMP_PATH = join(tmpdir(), 'wms-ios-capture-stream.swift');

/** Maximum number of times the iOS capture process is restarted before giving up. */
const MAX_IOS_CAPTURE_RESTARTS = 5;

/** Version tag for the compiled iOS capture binary. Increment to force recompilation. */
const CAPTURE_BINARY_VERSION = '18';

/** Sidecar file that stores the version of the currently-cached binary. */
const CAPTURE_BINARY_VERSION_PATH = join(tmpdir(), 'wms-ios-capture-stream.ver');

/** Path where the compiled SimDeviceIO capture binary is cached across server restarts. */
const SIMDEVICE_CAPTURE_BINARY_PATH = join(tmpdir(), 'wms-simdevice-capture');

/** Temp path used to write the SimDeviceIO Swift source before compilation. */
const SIMDEVICE_CAPTURE_SWIFT_TMP_PATH = join(tmpdir(), 'wms-simdevice-capture.swift');

/** Version tag for the compiled SimDeviceIO capture binary. Increment to force recompilation. */
const SIMDEVICE_CAPTURE_BINARY_VERSION = '2';

/** Sidecar file that stores the version of the currently-cached SimDeviceIO binary. */
const SIMDEVICE_CAPTURE_BINARY_VERSION_PATH = join(tmpdir(), 'wms-simdevice-capture.ver');

/** Path to the scrcpy-server jar bundled with scrcpy. */
const SCRCPY_SERVER_JAR = '/opt/homebrew/share/scrcpy/scrcpy-server';

/** scrcpy-server version string — must match the installed scrcpy version. */
const SCRCPY_SERVER_VERSION = '3.3.4';

/** Maximum number of times the Android scrcpy capture is restarted before giving up. */
const MAX_ANDROID_SCRCPY_RESTARTS = 5;

// ---------------------------------------------------------------------------
// Embedded Swift source
// ---------------------------------------------------------------------------

/**
 * Swift source for the persistent iOS screen capture process.
 * Uses ScreenCaptureKit SCStream (macOS 14+) to capture the
 * Simulator window by device name.
 *
 * Supports two output modes selected via `--format`:
 * - `jpeg` (default): writes 4-byte big-endian length-prefixed JPEG frames to stdout.
 * - `h264`: uses VideoToolbox VTCompressionSession for hardware H.264 encoding and
 *   writes frames in the format: [4B BE length][1B flags][8B BE timestamp_us][Annex-B NALU data].
 */
const IOS_CAPTURE_SWIFT_SOURCE = `
import ScreenCaptureKit
import CoreGraphics
import CoreMedia
import CoreImage
import Foundation
import AppKit
import UniformTypeIdentifiers
import VideoToolbox

var deviceName: String = ""
var targetFps: Int = 15
var captureFormat: String = "jpeg"
var argIdx = 1
while argIdx < CommandLine.arguments.count {
    switch CommandLine.arguments[argIdx] {
    case "--device-name":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { deviceName = CommandLine.arguments[argIdx] }
    case "--fps":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { targetFps = Int(CommandLine.arguments[argIdx]) ?? 15 }
    case "--format":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { captureFormat = CommandLine.arguments[argIdx] }
    default: break
    }
    argIdx += 1
}
guard !deviceName.isEmpty else {
    fputs("Usage: ios-capture-stream --device-name <name> [--fps <fps>] [--format jpeg|h264]\\n", stderr)
    exit(1)
}

// Establish the WindowServer (CGS) connection that ScreenCaptureKit and AppKit
// require.  Without this, SCShareableContent calls abort with CGS_REQUIRE_INIT.
NSApplication.shared.setActivationPolicy(.prohibited)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT)  { _ in exit(0) }

var globalFrameHandler: FrameHandler? = nil

let stdoutHandle = FileHandle.standardOutput

// ---------------------------------------------------------------------------
// JPEG output helpers
// ---------------------------------------------------------------------------

/// Write a JPEG frame to stdout as: [4-byte BE uint32 length][JPEG bytes].
func writeFrame(_ jpegData: Data) {
    var length = UInt32(jpegData.count).bigEndian
    let lengthData = withUnsafeBytes(of: &length) { Data($0) }
    stdoutHandle.write(lengthData)
    stdoutHandle.write(jpegData)
}

// ---------------------------------------------------------------------------
// H.264 output helpers
// ---------------------------------------------------------------------------

/// Write an H.264 Annex-B packet to stdout.
///
/// Protocol: [4-byte BE uint32 total-payload-length][1-byte flags][8-byte BE uint64 timestamp_us][NALU bytes]
///
/// - Parameters:
///   - naluData: Raw Annex-B NALU bytes (already converted from AVCC).
///   - isKeyframe: Whether this packet contains a keyframe.
///   - timestampUs: Presentation timestamp in microseconds.
func writeH264Frame(_ naluData: Data, isKeyframe: Bool, timestampUs: UInt64) {
    // payload = 1 (flags) + 8 (timestamp) + naluData.count
    let payloadLength = UInt32(1 + 8 + naluData.count)
    var beLength = payloadLength.bigEndian
    var beTimestamp = timestampUs.bigEndian
    let flags: UInt8 = isKeyframe ? 0x01 : 0x00

    var packet = Data()
    packet.append(contentsOf: withUnsafeBytes(of: &beLength) { Array($0) })
    packet.append(flags)
    packet.append(contentsOf: withUnsafeBytes(of: &beTimestamp) { Array($0) })
    packet.append(naluData)
    stdoutHandle.write(packet)
}

// ---------------------------------------------------------------------------
// H.264 encoder (VideoToolbox)
// ---------------------------------------------------------------------------

@available(macOS 14.0, *)
class H264Encoder {
    private var session: VTCompressionSession?
    private let encoderDeviceName: String
    private let fps: Int
    var forceNextKeyframe = false
    private var lastEncodeTime: CMTime? = nil
    private var keyframeLock = NSLock()

    init(width: Int, height: Int, fps: Int, deviceName: String) {
        self.fps = fps
        self.encoderDeviceName = deviceName

        // The compression callback must be a C-compatible function pointer.
        // We pass \`self\` as the refcon and bridge it back inside the closure.
        let refcon = Unmanaged.passRetained(self).toOpaque()

        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard let refcon = refcon else { return }
            let encoder = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.handleEncodedFrame(status: status, sampleBuffer: sampleBuffer)
        }

        let err = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: refcon,
            compressionSessionOut: &session
        )
        guard err == noErr, let session = session else {
            fputs("[\\(deviceName)] Failed to create VTCompressionSession: \\(err)\\n", stderr)
            exit(1)
        }

        // Configure encoder properties.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime,               value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering,   value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,            value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,     value: 5 as CFTypeRef)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,       value: fps as CFTypeRef)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,          value: (width * height * 2) as CFTypeRef)

        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session = session {
            VTCompressionSessionInvalidate(session)
        }
    }

    /// Submit a pixel buffer from SCStream for H.264 encoding.
    /// Detects gaps longer than 2 seconds and forces an IDR (keyframe) on the
    /// first frame after the gap so decoders can recover cleanly.
    func encode(sampleBuffer: CMSampleBuffer) {
        guard let session = session else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            fputs("[\\(encoderDeviceName)] H264Encoder: failed to get pixel buffer\\n", stderr)
            return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        // Force IDR after a gap longer than 2 seconds (no frames submitted).
        if let last = lastEncodeTime, pts.seconds - last.seconds > 2.0 {
            keyframeLock.lock()
            forceNextKeyframe = true
            keyframeLock.unlock()
            fputs("[\\(encoderDeviceName)] Gap detected (\\(String(format: "%.1f", pts.seconds - last.seconds))s) — forcing IDR\\n", stderr)
        }
        lastEncodeTime = pts

        keyframeLock.lock()
        let shouldForceKeyframe = forceNextKeyframe
        if shouldForceKeyframe { forceNextKeyframe = false }
        keyframeLock.unlock()

        var frameProperties: CFDictionary? = nil
        if shouldForceKeyframe {
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: CMTime.invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    /// Submit a raw pixel buffer for H.264 encoding with an explicit timestamp.
    /// Used by the idle-refresh timer when re-encoding cached frames.
    func encodePixelBuffer(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
        guard let session = session else { return }
        lastEncodeTime = presentationTime

        keyframeLock.lock()
        let shouldForceKeyframe = forceNextKeyframe
        if shouldForceKeyframe { forceNextKeyframe = false }
        keyframeLock.unlock()

        if shouldForceKeyframe {
            fputs("[\\(encoderDeviceName)] encodePixelBuffer: forcing keyframe\\n", stderr)
        }

        var frameProperties: CFDictionary? = nil
        if shouldForceKeyframe {
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: CMTime.invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    /// Request that the next frame be encoded as a keyframe.
    /// Thread-safe: may be called from any queue.
    func requestKeyframe() {
        keyframeLock.lock()
        forceNextKeyframe = true
        keyframeLock.unlock()
    }

    // MARK: - Private callback handler

    private func handleEncodedFrame(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        guard status == noErr else {
            fputs("[\\(encoderDeviceName)] H264Encoder: encode error \\(status)\\n", stderr)
            return
        }
        guard let sampleBuffer = sampleBuffer else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        // Determine whether this is a keyframe.
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        var isKeyframe = true
        if let attachments = attachments, CFArrayGetCount(attachments) > 0,
           let attachment = CFArrayGetValueAtIndex(attachments, 0) {
            let dict = Unmanaged<CFDictionary>.fromOpaque(attachment).takeUnretainedValue()
            if let notSync = CFDictionaryGetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()) {
                let notSyncBool = Unmanaged<CFBoolean>.fromOpaque(notSync).takeUnretainedValue()
                isKeyframe = !CFBooleanGetValue(notSyncBool)
            }
        }

        // Get presentation timestamp in microseconds.
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestampUs = UInt64(max(0, Int64(pts.seconds * 1_000_000)))

        var annexBData = Data()

        // On keyframes, prepend SPS and PPS parameter sets from the format description.
        if isKeyframe, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var paramCount = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc, parameterSetIndex: 0, parameterSetPointerOut: nil,
                parameterSetSizeOut: nil, parameterSetCountOut: &paramCount, nalUnitHeaderLengthOut: nil
            )
            for i in 0..<paramCount {
                var paramPtr: UnsafePointer<UInt8>? = nil
                var paramSize: Int = 0
                let pErr = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDesc, parameterSetIndex: i,
                    parameterSetPointerOut: &paramPtr,
                    parameterSetSizeOut: &paramSize,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil
                )
                if pErr == noErr, let paramPtr = paramPtr {
                    // Annex B start code: 0x00 0x00 0x00 0x01
                    annexBData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                    annexBData.append(Data(bytes: paramPtr, count: paramSize))
                }
            }
        }

        // Extract and convert AVCC-format encoded data to Annex B.
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>? = nil
        let blockErr = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard blockErr == noErr, let dataPointer = dataPointer else { return }

        // Walk the AVCC bytestream: [4-byte BE NALU length][NALU bytes]...
        var offset = 0
        while offset + 4 <= totalLength {
            // Read the 4-byte big-endian NALU length byte-by-byte to avoid
            // alignment faults on arm64 (UInt32 load requires 4-byte alignment).
            let rawPtr = UnsafeRawPointer(dataPointer) + offset
            let naluLength = Int(rawPtr.load(fromByteOffset: 0, as: UInt8.self)) << 24
                           | Int(rawPtr.load(fromByteOffset: 1, as: UInt8.self)) << 16
                           | Int(rawPtr.load(fromByteOffset: 2, as: UInt8.self)) << 8
                           | Int(rawPtr.load(fromByteOffset: 3, as: UInt8.self))
            offset += 4
            guard offset + naluLength <= totalLength else { break }

            // Append Annex B start code + NALU bytes.
            annexBData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            annexBData.append(Data(bytes: dataPointer.advanced(by: offset), count: naluLength))
            offset += naluLength
        }

        if !annexBData.isEmpty {
            writeH264Frame(annexBData, isKeyframe: isKeyframe, timestampUs: timestampUs)
        }
    }
}

// ---------------------------------------------------------------------------
// SCStream frame handler
// ---------------------------------------------------------------------------

@available(macOS 14.0, *)
class FrameHandler: NSObject, SCStreamOutput, SCStreamDelegate {
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let capturedDeviceName: String
    private let format: String
    private var h264Encoder: H264Encoder?
    private var receivedFirstFrame: Bool = false
    private var startupWatchdogTimer: DispatchSourceTimer?
    private var lastPixelBuffer: CVPixelBuffer? = nil
    private var lastFrameTime: Date = Date()
    private var idleRefreshTimer: DispatchSourceTimer? = nil
    private var idleRefreshLogged: Bool = false
    private var idleKeyframeNeeded: Bool = true

    init(deviceName: String, format: String, width: Int, height: Int, fps: Int) {
        self.capturedDeviceName = deviceName
        self.format = format
        if format == "h264" {
            self.h264Encoder = H264Encoder(width: width, height: height, fps: fps, deviceName: deviceName)
        }
        super.init()
        // Startup-only watchdog: fires once after 10 seconds.
        // If no frame has arrived by then, SCStream failed to deliver any output — exit for restart.
        // Once the first frame arrives the timer is cancelled permanently; content silence is normal.
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 10, repeating: .never)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            if !self.receivedFirstFrame {
                fputs("[\\(self.capturedDeviceName)] Startup watchdog: no frames received within 10 seconds — exiting for restart\\n", stderr)
                exit(1)
            }
        }
        timer.resume()
        self.startupWatchdogTimer = timer

        // Idle refresh timer (both modes): re-feeds the last captured pixel buffer
        // when SCStream stops delivering frames (static screen content).
        // In H.264 mode, fires at the target FPS to maintain consistent frame
        // delivery for the video decoder. In JPEG mode, fires once per second
        // since JPEG re-encoding at high FPS would be wasteful.
        let idleInterval = format == "h264" ? 1.0 / Double(fps) : 1.0
        let idleThreshold = format == "h264" ? 2.0 / Double(fps) : 1.0
        let idleTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        idleTimer.schedule(deadline: .now() + 2, repeating: idleInterval)
        idleTimer.setEventHandler { [weak self] in
            guard let self = self else { return }
            guard Date().timeIntervalSince(self.lastFrameTime) > idleThreshold,
                  let pixelBuffer = self.lastPixelBuffer else { return }
            if self.format == "h264" {
                guard let encoder = self.h264Encoder else { return }
                if !self.idleRefreshLogged {
                    self.idleRefreshLogged = true
                    fputs("[\\(self.capturedDeviceName)] Content idle — refreshing H.264 at \\(fps)fps\\n", stderr)
                }
                if self.idleKeyframeNeeded {
                    self.idleKeyframeNeeded = false
                    encoder.requestKeyframe()
                }
                let freshPTS = CMClockGetTime(CMClockGetHostTimeClock())
                encoder.encodePixelBuffer(pixelBuffer, presentationTime: freshPTS)
            } else {
                if !self.idleRefreshLogged {
                    self.idleRefreshLogged = true
                    fputs("[\\(self.capturedDeviceName)] Content idle — refreshing JPEG frame\\n", stderr)
                }
                let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
                guard let cgImage = self.ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }
                let mutableData = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(
                    mutableData, UTType.jpeg.identifier as CFString, 1, nil
                ) else { return }
                let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
                CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { return }
                writeFrame(mutableData as Data)
            }
        }
        idleTimer.resume()
        self.idleRefreshTimer = idleTimer
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Cancel the startup watchdog on the very first frame and never check again.
        if !self.receivedFirstFrame {
            self.receivedFirstFrame = true
            self.startupWatchdogTimer?.cancel()
            self.startupWatchdogTimer = nil
            fputs("[\\(self.capturedDeviceName)] First frame received — startup watchdog cancelled\\n", stderr)
        }

        guard type == .screen else { return }

        // Check frame status BEFORE updating lastFrameTime.
        // Idle-status frames must NOT reset the idle timer — doing so prevents
        // the idle refresh timer from ever firing when SCStream delivers
        // continuous idle-status callbacks for static screen content.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let statusValue = attachments.first?[.status] as? Int,
           statusValue != SCFrameStatus.complete.rawValue && statusValue != SCFrameStatus.started.rawValue {
            return  // Idle, blank, suspended, or stopped — no valid pixel data
        }

        // Only reset the idle timer when a real, encodable frame arrives.
        self.lastFrameTime = Date()
        // Reset idle log flag so the next idle period logs once.
        self.idleRefreshLogged = false
        // Signal that the next idle period must begin with a keyframe.
        self.idleKeyframeNeeded = true

        // Store the latest pixel buffer for idle frame refresh (both modes).
        if let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
            self.lastPixelBuffer = pb
        }

        if format == "h264" {
            h264Encoder?.encode(sampleBuffer: sampleBuffer)
            return
        }

        // JPEG mode (default).
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            fputs("[\\(capturedDeviceName)] Failed to get pixel buffer from sample buffer\\n", stderr)
            return
        }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
            fputs("[\\(capturedDeviceName)] Failed to create CGImage from CIImage\\n", stderr)
            return
        }

        let mutableData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            mutableData, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            fputs("[\\(capturedDeviceName)] Failed to create CGImageDestination\\n", stderr)
            return
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
        CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            fputs("[\\(capturedDeviceName)] Failed to finalize JPEG destination\\n", stderr)
            return
        }

        writeFrame(mutableData as Data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[\\(capturedDeviceName)] SCStream stopped with error: \\(error)\\n", stderr)
        exit(1)
    }

    func requestKeyframe() {
        h264Encoder?.requestKeyframe()
    }
}

@available(macOS 14.0, *)
func startCapture() async {
    let maxRetries = 30
    var retryCount = 0
    var window: SCWindow? = nil

    // Discover the Simulator window once at startup, retrying until found.
    while retryCount < maxRetries {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let simulatorWindows = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator"
            }
            if let found = simulatorWindows.first(where: { ($0.title ?? "").contains(deviceName) })
                ?? simulatorWindows.first {
                window = found
                break
            }
        } catch {
            fputs("[\\(deviceName)] Error querying shareable content: \\(error)\\n", stderr)
        }
        retryCount += 1
        fputs("[\\(deviceName)] No Simulator window found (\\(retryCount)/\\(maxRetries))\\n", stderr)
        try? await Task.sleep(nanoseconds: 500_000_000)
    }

    guard let capturedWindow = window else {
        fputs("[\\(deviceName)] Simulator window not found after \\(maxRetries) retries — exiting\\n", stderr)
        exit(1)
    }

    let filter = SCContentFilter(desktopIndependentWindow: capturedWindow)
    let streamConfig = SCStreamConfiguration()
    streamConfig.showsCursor = false
    let scale = NSScreen.main?.backingScaleFactor ?? 2.0
    let captureWidth  = max(1, Int(capturedWindow.frame.width  * scale))
    let captureHeight = max(1, Int(capturedWindow.frame.height * scale))
    streamConfig.width  = captureWidth
    streamConfig.height = captureHeight
    streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(targetFps))
    streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
    streamConfig.queueDepth = 3

    let handler = FrameHandler(deviceName: deviceName, format: captureFormat, width: captureWidth, height: captureHeight, fps: targetFps)
    globalFrameHandler = handler
    let stream = SCStream(filter: filter, configuration: streamConfig, delegate: handler)
    let queue = DispatchQueue(label: "com.wms.capture.output", qos: .userInteractive)

    do {
        try stream.addStreamOutput(handler, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        fputs("[\\(deviceName)] SCStream capture started (format=\\(captureFormat))\\n", stderr)
    } catch {
        fputs("[\\(deviceName)] Failed to start SCStream: \\(error)\\n", stderr)
        exit(1)
    }
}

if #available(macOS 14.0, *) {
    Task { await startCapture() }
    // Monitor stdin for keyframe requests ("K\\n").
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine() {
            if line == "K" {
                fputs("[\\(deviceName)] Stdin: received keyframe request\\n", stderr)
                globalFrameHandler?.requestKeyframe()
            }
        }
    }
    RunLoop.main.run()
} else {
    fputs("ERROR: iOS persistent capture requires macOS 14.0 or later\\n", stderr)
    exit(1)
}
`;

/**
 * Swift source for the SimDeviceIO-based iOS Simulator screen capture process.
 *
 * Uses CoreSimulator's private `SimDeviceIOClient` API (accessed exclusively
 * via the ObjC runtime / dlopen to avoid linker restrictions) to register
 * per-frame and per-surface callbacks directly on the simulator framebuffer.
 *
 * Output: H.264 frames written to stdout in the same binary protocol as
 * {@link IOS_CAPTURE_SWIFT_SOURCE}:
 *   [4B BE uint32 payload-length][1B flags][8B BE uint64 timestamp_us][Annex-B NALU data]
 *
 * CLI arguments:
 *   --udid <UDID>     Required. Simulator device UDID.
 *   --fps <N>         Optional. Target FPS (default 30).
 *   --format <fmt>    Optional. "h264" (default). "jpeg" exits with an error.
 */
const SIMDEVICE_IO_CAPTURE_SWIFT_SOURCE = `
import Foundation
import CoreGraphics
import CoreMedia
import VideoToolbox
import IOSurface

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

var udid: String = ""
var targetFps: Int = 30
var captureFormat: String = "h264"
var argIdx = 1
while argIdx < CommandLine.arguments.count {
    switch CommandLine.arguments[argIdx] {
    case "--udid":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { udid = CommandLine.arguments[argIdx] }
    case "--fps":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { targetFps = Int(CommandLine.arguments[argIdx]) ?? 30 }
    case "--format":
        argIdx += 1
        if argIdx < CommandLine.arguments.count { captureFormat = CommandLine.arguments[argIdx] }
    default: break
    }
    argIdx += 1
}
guard !udid.isEmpty else {
    fputs("Usage: simdevice-capture --udid <UDID> [--fps <fps>] [--format h264]\\n", stderr)
    exit(1)
}
if captureFormat == "jpeg" {
    fputs("JPEG format is not supported by simdevice-capture; use h264\\n", stderr)
    exit(1)
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

signal(SIGTERM) { _ in
    let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
    for reg in gRegistrations {
        guard reg.target.responds(to: unregSel) else { continue }
        guard let imp = class_getMethodImplementation(type(of: reg.target), unregSel) else { continue }
        typealias UnregFn = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        unsafeBitCast(imp, to: UnregFn.self)(reg.target, unregSel, reg.uuid as AnyObject)
    }
    exit(0)
}
signal(SIGINT) { _ in
    let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
    for reg in gRegistrations {
        guard reg.target.responds(to: unregSel) else { continue }
        guard let imp = class_getMethodImplementation(type(of: reg.target), unregSel) else { continue }
        typealias UnregFn = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        unsafeBitCast(imp, to: UnregFn.self)(reg.target, unregSel, reg.uuid as AnyObject)
    }
    exit(0)
}

// ---------------------------------------------------------------------------
// Framework loading (dlopen — cannot link CoreSimDeviceIO at compile time)
// ---------------------------------------------------------------------------

let kCoreSimPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
let kCoreSimDeviceIOPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Frameworks/CoreSimDeviceIO.framework/CoreSimDeviceIO"

guard dlopen(kCoreSimPath, RTLD_NOW | RTLD_GLOBAL) != nil else {
    fputs("simdevice-capture: Failed to load CoreSimulator\\n", stderr); exit(1)
}
guard dlopen(kCoreSimDeviceIOPath, RTLD_NOW | RTLD_GLOBAL) != nil else {
    fputs("simdevice-capture: Failed to load CoreSimDeviceIO\\n", stderr); exit(1)
}

// ---------------------------------------------------------------------------
// Stdout handle
// ---------------------------------------------------------------------------

let stdoutHandle = FileHandle.standardOutput

// ---------------------------------------------------------------------------
// H.264 output helpers
// ---------------------------------------------------------------------------

/// Write an H.264 Annex-B packet to stdout.
///
/// Protocol: [4-byte BE uint32 total-payload-length][1-byte flags][8-byte BE uint64 timestamp_us][NALU bytes]
func writeH264Frame(_ naluData: Data, isKeyframe: Bool, timestampUs: UInt64) {
    let payloadLength = UInt32(1 + 8 + naluData.count)
    var beLength = payloadLength.bigEndian
    var beTimestamp = timestampUs.bigEndian
    let flags: UInt8 = isKeyframe ? 0x01 : 0x00

    var packet = Data()
    packet.append(contentsOf: withUnsafeBytes(of: &beLength) { Array($0) })
    packet.append(flags)
    packet.append(contentsOf: withUnsafeBytes(of: &beTimestamp) { Array($0) })
    packet.append(naluData)
    stdoutHandle.write(packet)
}

// ---------------------------------------------------------------------------
// ObjC runtime InvocationHelper
// ---------------------------------------------------------------------------

class InvocationHelper {
    static func invoke(_ target: NSObject, selector: Selector, args: [Any] = []) -> Any? {
        let methodSigSel = NSSelectorFromString("methodSignatureForSelector:")
        guard let sigIMP = class_getMethodImplementation(type(of: target), methodSigSel) else { return nil }
        typealias SigFn = @convention(c) (AnyObject, Selector, Selector) -> AnyObject?
        let sigFn = unsafeBitCast(sigIMP, to: SigFn.self)
        guard let sig = sigFn(target, methodSigSel, selector) else { return nil }

        let invClass = NSClassFromString("NSInvocation") as! NSObject.Type
        let invSel = NSSelectorFromString("invocationWithMethodSignature:")
        guard let invIMP = class_getMethodImplementation(object_getClass(invClass), invSel) else { return nil }
        typealias InvFn = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        let invFn = unsafeBitCast(invIMP, to: InvFn.self)
        guard let inv = invFn(invClass, invSel, sig) as? NSObject else { return nil }

        let setSel = NSSelectorFromString("setSelector:")
        if let imp = class_getMethodImplementation(type(of: inv), setSel) {
            typealias F = @convention(c) (AnyObject, Selector, Selector) -> Void
            unsafeBitCast(imp, to: F.self)(inv, setSel, selector)
        }

        let setTarget = NSSelectorFromString("setTarget:")
        if let imp = class_getMethodImplementation(type(of: inv), setTarget) {
            typealias F = @convention(c) (AnyObject, Selector, AnyObject) -> Void
            unsafeBitCast(imp, to: F.self)(inv, setTarget, target)
        }

        let setArg = NSSelectorFromString("setArgument:atIndex:")
        if let imp = class_getMethodImplementation(type(of: inv), setArg) {
            typealias F = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Int) -> Void
            let fn = unsafeBitCast(imp, to: F.self)
            for (i, var arg) in args.enumerated() {
                withUnsafeMutablePointer(to: &arg) { ptr in
                    fn(inv, setArg, ptr, i + 2)
                }
            }
        }

        let retainArgs = NSSelectorFromString("retainArguments")
        if let imp = class_getMethodImplementation(type(of: inv), retainArgs) {
            typealias F = @convention(c) (AnyObject, Selector) -> Void
            unsafeBitCast(imp, to: F.self)(inv, retainArgs)
        }

        let invokeSel = NSSelectorFromString("invoke")
        if let imp = class_getMethodImplementation(type(of: inv), invokeSel) {
            typealias F = @convention(c) (AnyObject, Selector) -> Void
            unsafeBitCast(imp, to: F.self)(inv, invokeSel)
        }

        let getRetVal = NSSelectorFromString("getReturnValue:")
        if let imp = class_getMethodImplementation(type(of: inv), getRetVal) {
            typealias F = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer) -> Void
            let fn = unsafeBitCast(imp, to: F.self)
            var result: AnyObject? = nil
            withUnsafeMutablePointer(to: &result) { ptr in
                fn(inv, getRetVal, ptr)
            }
            return result
        }
        return nil
    }

    static func invokeVoid(_ target: NSObject, selector: Selector, args: [Any] = []) {
        _ = invoke(target, selector: selector, args: args)
    }
}

// ---------------------------------------------------------------------------
// H.264 encoder (VideoToolbox)
// ---------------------------------------------------------------------------

class H264Encoder {
    private var session: VTCompressionSession?
    private let encoderLabel: String
    private let fps: Int
    var forceNextKeyframe = false
    private var lastEncodeTime: CMTime? = nil
    private var keyframeLock = NSLock()

    init(width: Int, height: Int, fps: Int, label: String) {
        self.fps = fps
        self.encoderLabel = label

        let refcon = Unmanaged.passRetained(self).toOpaque()
        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard let refcon = refcon else { return }
            let encoder = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.handleEncodedFrame(status: status, sampleBuffer: sampleBuffer)
        }

        let err = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: refcon,
            compressionSessionOut: &session
        )
        guard err == noErr, let session = session else {
            fputs("[simdevice-capture] Failed to create VTCompressionSession: \\(err)\\n", stderr)
            exit(1)
        }

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime,             value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,          value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,   value: 5 as CFTypeRef)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,     value: fps as CFTypeRef)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,        value: (width * height * 2) as CFTypeRef)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session = session {
            VTCompressionSessionInvalidate(session)
        }
    }

    /// Submit a raw pixel buffer for H.264 encoding with an explicit timestamp.
    func encodePixelBuffer(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
        guard let session = session else { return }

        // Force IDR after a gap longer than 2 seconds.
        if let last = lastEncodeTime, presentationTime.seconds - last.seconds > 2.0 {
            keyframeLock.lock()
            forceNextKeyframe = true
            keyframeLock.unlock()
            let gapSecs = String(format: "%.1f", presentationTime.seconds - last.seconds)
            fputs("[simdevice-capture] Gap detected (\\(gapSecs)s) — forcing IDR\\n", stderr)
        }
        lastEncodeTime = presentationTime

        keyframeLock.lock()
        let shouldForceKeyframe = forceNextKeyframe
        if shouldForceKeyframe { forceNextKeyframe = false }
        keyframeLock.unlock()

        var frameProperties: CFDictionary? = nil
        if shouldForceKeyframe {
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: CMTime.invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    /// Request that the next frame be encoded as a keyframe. Thread-safe.
    func requestKeyframe() {
        keyframeLock.lock()
        forceNextKeyframe = true
        keyframeLock.unlock()
    }

    // MARK: - Private

    private func handleEncodedFrame(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        guard status == noErr else {
            fputs("[simdevice-capture] H264Encoder: encode error \\(status)\\n", stderr)
            return
        }
        guard let sampleBuffer = sampleBuffer else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        var isKeyframe = true
        if let attachments = attachments, CFArrayGetCount(attachments) > 0,
           let attachment = CFArrayGetValueAtIndex(attachments, 0) {
            let dict = Unmanaged<CFDictionary>.fromOpaque(attachment).takeUnretainedValue()
            if let notSync = CFDictionaryGetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()) {
                let notSyncBool = Unmanaged<CFBoolean>.fromOpaque(notSync).takeUnretainedValue()
                isKeyframe = !CFBooleanGetValue(notSyncBool)
            }
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestampUs = UInt64(max(0, Int64(pts.seconds * 1_000_000)))

        var annexBData = Data()

        if isKeyframe, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var paramCount = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc, parameterSetIndex: 0, parameterSetPointerOut: nil,
                parameterSetSizeOut: nil, parameterSetCountOut: &paramCount, nalUnitHeaderLengthOut: nil
            )
            for i in 0..<paramCount {
                var paramPtr: UnsafePointer<UInt8>? = nil
                var paramSize: Int = 0
                let pErr = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDesc, parameterSetIndex: i,
                    parameterSetPointerOut: &paramPtr,
                    parameterSetSizeOut: &paramSize,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil
                )
                if pErr == noErr, let paramPtr = paramPtr {
                    annexBData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                    annexBData.append(Data(bytes: paramPtr, count: paramSize))
                }
            }
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>? = nil
        let blockErr = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard blockErr == noErr, let dataPointer = dataPointer else { return }

        var offset = 0
        while offset + 4 <= totalLength {
            let rawPtr = UnsafeRawPointer(dataPointer) + offset
            let naluLength = Int(rawPtr.load(fromByteOffset: 0, as: UInt8.self)) << 24
                           | Int(rawPtr.load(fromByteOffset: 1, as: UInt8.self)) << 16
                           | Int(rawPtr.load(fromByteOffset: 2, as: UInt8.self)) << 8
                           | Int(rawPtr.load(fromByteOffset: 3, as: UInt8.self))
            offset += 4
            guard offset + naluLength <= totalLength else { break }
            annexBData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            annexBData.append(Data(bytes: dataPointer.advanced(by: offset), count: naluLength))
            offset += naluLength
        }

        if !annexBData.isEmpty {
            writeH264Frame(annexBData, isKeyframe: isKeyframe, timestampUs: timestampUs)
        }
    }
}

// ---------------------------------------------------------------------------
// Global capture state
// ---------------------------------------------------------------------------

var encoder: H264Encoder? = nil
var currentSurface: IOSurface? = nil
var surfaceLock = NSLock()
var lastFrameTime: Date = Date()
var lastPixelBuffer: CVPixelBuffer? = nil
var pixelBufferLock = NSLock()
var idleRefreshLogged: Bool = false
var idleKeyframeNeeded: Bool = true

// XPC proxy object retention — these MUST outlive the entire program.
// Releasing them tears down SimDeviceIO registrations.
var gServiceContext: NSObject?    = nil
var gDevSetObj: NSObject?         = nil
var gDevice: NSObject?            = nil
var gIOClient: NSObject?          = nil
var gPorts: [NSObject]            = []
var gScreenAdapterDesc: NSObject? = nil
var gScreens: [NSObject]          = []
var gRegistrations: [(target: NSObject, uuid: NSUUID, label: String)] = []

// ---------------------------------------------------------------------------
// Frame encode helper
// ---------------------------------------------------------------------------

func handleFrameReady() {
    surfaceLock.lock()
    let surface = currentSurface
    surfaceLock.unlock()

    guard let surface = surface else {
        return  // No surface yet — wait for surfacesChanged callback or seeding
    }

    IOSurfaceLock(surface, .readOnly, nil)

    var pixelBuffer: Unmanaged<CVPixelBuffer>?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:] as NSDictionary] as NSDictionary
    let cvErr = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, attrs, &pixelBuffer)

    IOSurfaceUnlock(surface, .readOnly, nil)

    guard cvErr == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else {
        fputs("[simdevice-capture] CVPixelBufferCreateWithIOSurface failed: \\(cvErr)\\n", stderr)
        return
    }

    let now = CMClockGetTime(CMClockGetHostTimeClock())

    pixelBufferLock.lock()
    lastPixelBuffer = pb
    pixelBufferLock.unlock()

    lastFrameTime = Date()
    idleRefreshLogged = false
    idleKeyframeNeeded = true

    encoder?.encodePixelBuffer(pb, presentationTime: now)
}

// ---------------------------------------------------------------------------
// Idle refresh timer
// ---------------------------------------------------------------------------

func startIdleRefreshTimer(fps: Int) {
    let interval = 1.0 / Double(fps)
    let threshold = 2.0 / Double(fps)
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 2, repeating: interval)
    timer.setEventHandler {
        guard Date().timeIntervalSince(lastFrameTime) > threshold else { return }
        pixelBufferLock.lock()
        let pb = lastPixelBuffer
        pixelBufferLock.unlock()
        guard let pb = pb else { return }
        guard let enc = encoder else { return }
        if !idleRefreshLogged {
            idleRefreshLogged = true
            fputs("[simdevice-capture] Content idle — refreshing H.264 at \\(fps)fps\\n", stderr)
        }
        if idleKeyframeNeeded {
            idleKeyframeNeeded = false
            enc.requestKeyframe()
        }
        let freshPTS = CMClockGetTime(CMClockGetHostTimeClock())
        enc.encodePixelBuffer(pb, presentationTime: freshPTS)
    }
    timer.resume()
}

// ---------------------------------------------------------------------------
// Stdin keyframe reader (POSIX read — avoids macOS 26 FileHandle bug)
// ---------------------------------------------------------------------------

DispatchQueue.global(qos: .utility).async {
    var buf = [UInt8](repeating: 0, count: 4096)
    var lineBuf = ""
    while true {
        let n = read(0, &buf, buf.count)
        if n <= 0 { break }
        let str = String(bytes: buf[0..<n], encoding: .utf8) ?? ""
        lineBuf += str
        while let range = lineBuf.range(of: "\\n") {
            let line = String(lineBuf[lineBuf.startIndex..<range.lowerBound])
            lineBuf = String(lineBuf[range.upperBound...])
            if line == "K" {
                encoder?.requestKeyframe()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SimDeviceIO connection
// ---------------------------------------------------------------------------

func connectAndCapture(udid: String, fps: Int) {
    // 1. Get SimServiceContext via sharedServiceContextForDeveloperDir:error: (class method).
    guard let simSvcCtxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
        fputs("[simdevice-capture] NSClassFromString(SimServiceContext) returned nil\\n", stderr); exit(1)
    }
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"

    let sharedCtxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard let sharedCtxMethod = class_getClassMethod(simSvcCtxClass, sharedCtxSel) else {
        fputs("[simdevice-capture] SimServiceContext.sharedServiceContextForDeveloperDir:error: not found\\n", stderr); exit(1)
    }
    typealias SharedCtxFn = @convention(c) (
        AnyClass, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let sharedCtxImpl = unsafeBitCast(method_getImplementation(sharedCtxMethod), to: SharedCtxFn.self)
    var ctxErr: NSError? = nil
    guard let serviceContext = sharedCtxImpl(
        simSvcCtxClass, sharedCtxSel, developerDir as NSString, &ctxErr
    ) as? NSObject else {
        let errMsg = ctxErr?.localizedDescription ?? "no error"
        fputs("[simdevice-capture] sharedServiceContextForDeveloperDir returned nil: \\(errMsg)\\n", stderr); exit(1)
    }
    gServiceContext = serviceContext

    // 2. Get defaultDeviceSetWithError: via instance-method lookup.
    let devSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
    guard let devSetMethod = class_getInstanceMethod(type(of: serviceContext), devSetSel) else {
        fputs("[simdevice-capture] defaultDeviceSetWithError: not found\\n", stderr); exit(1)
    }
    typealias DevSetFn = @convention(c) (
        AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let devSetImpl = unsafeBitCast(method_getImplementation(devSetMethod), to: DevSetFn.self)
    var devSetErr: NSError? = nil
    guard let devSetObj = devSetImpl(serviceContext, devSetSel, &devSetErr) as? NSObject else {
        let errMsg = devSetErr?.localizedDescription ?? "no error"
        fputs("[simdevice-capture] defaultDeviceSetWithError returned nil: \\(errMsg)\\n", stderr); exit(1)
    }
    gDevSetObj = devSetObj

    // 3. Find the device by UDID.
    guard let devices = devSetObj.value(forKey: "availableDevices") as? [NSObject] else {
        fputs("[simdevice-capture] availableDevices returned nil or wrong type\\n", stderr); exit(1)
    }
    guard let device = devices.first(where: {
        ($0.value(forKey: "UDID") as? NSUUID)?.uuidString.uppercased() == udid.uppercased()
    }) else {
        fputs("[simdevice-capture] Device with UDID \\(udid) not found in availableDevices\\n", stderr); exit(1)
    }
    gDevice = device

    // 4. Get SimDeviceIOClient.
    guard let ioClient = device.value(forKey: "io") as? NSObject else {
        fputs("[simdevice-capture] device.value(forKey: io) returned nil\\n", stderr); exit(1)
    }
    gIOClient = ioClient

    // Refresh IO ports before reading ioPorts (ensures remote proxies are populated).
    let updateIOPortsSel = NSSelectorFromString("updateIOPorts")
    if ioClient.responds(to: updateIOPortsSel) {
        ioClient.perform(updateIOPortsSel)
        fputs("[simdevice-capture] Called updateIOPorts\\n", stderr)
    }

    // 5. Get ioPorts.
    guard let ports = ioClient.value(forKey: "ioPorts") as? [NSObject] else {
        fputs("[simdevice-capture] ioClient.value(forKey: ioPorts) returned nil\\n", stderr); exit(1)
    }
    gPorts = ports
    fputs("[simdevice-capture] Found \\(ports.count) ioPorts\\n", stderr)

    // 6. Determine execution queue for serialising XPC descriptor calls.
    let execQ: DispatchQueue
    if let q = ioClient.value(forKey: "executionQueue") as? DispatchQueue {
        execQ = q
    } else {
        execQ = DispatchQueue(label: "com.wms.descriptor-fetch")
        fputs("[simdevice-capture] executionQueue unavailable — using fallback serial queue\\n", stderr)
    }

    // 7. Scan all ports on the execution queue to find the SimScreenAdapter descriptor.
    //    KVC value(forKey:) fails on ROCKRemoteProxy objects — use InvocationHelper instead.
    let enumSel = NSSelectorFromString("enumerateScreensWithCompletionQueue:completionHandler:")
    var adapterDesc: NSObject? = nil
    let portScanSema = DispatchSemaphore(value: 0)
    execQ.async {
        let descriptorSel   = NSSelectorFromString("descriptor")
        let altDescriptorSel = NSSelectorFromString("ioPortDescriptor")
        // Prefer port 3 first (SimScreenAdapter by convention), then scan the rest.
        let portsToCheck: [Int] = [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        for idx in portsToCheck {
            guard idx < ports.count else { continue }
            let port = ports[idx]
            let desc = (InvocationHelper.invoke(port, selector: descriptorSel) as? NSObject)
                    ?? (InvocationHelper.invoke(port, selector: altDescriptorSel) as? NSObject)
            guard let d = desc else { continue }
            if d.responds(to: enumSel) {
                let cls = NSStringFromClass(type(of: d))
                fputs("[simdevice-capture] Port \\(idx) (\\(cls)) has enumerateScreens — using as screen adapter\\n", stderr)
                adapterDesc = d
                break
            }
        }
        portScanSema.signal()
    }
    let scanResult = portScanSema.wait(timeout: .now() + 10.0)
    if scanResult == .timedOut {
        fputs("[simdevice-capture] FATAL: Port scan timed out\\n", stderr); exit(1)
    }
    guard let screenAdapterDesc = adapterDesc else {
        fputs("[simdevice-capture] FATAL: No port with enumerateScreensWithCompletionQueue: found\\n", stderr); exit(1)
    }
    gScreenAdapterDesc = screenAdapterDesc

    // 8. Enumerate screens via the discovered SimScreenAdapter.
    //    IMPORTANT: direct IMP dispatch is required for block-argument calls on XPC proxies —
    //    NSInvocation blocks indefinitely waiting for the XPC reply.
    //    Use a dedicated callback queue (not DispatchQueue.main) and a 8s timeout.
    guard let enumIMP = class_getMethodImplementation(type(of: screenAdapterDesc), enumSel) else {
        fputs("[simdevice-capture] enumerateScreensWithCompletionQueue: IMP not found\\n", stderr); exit(1)
    }
    typealias EnumFn = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> Void
    let enumFn = unsafeBitCast(enumIMP, to: EnumFn.self)

    var screens: [NSObject] = []
    let enumSem = DispatchSemaphore(value: 0)
    let enumCallbackQ = DispatchQueue(label: "com.wms.enum-callback")
    let enumHandler: @convention(block) (NSArray?) -> Void = { arr in
        if let arr = arr {
            screens = arr.compactMap { $0 as? NSObject }
        }
        enumSem.signal()
    }
    enumFn(screenAdapterDesc, enumSel, enumCallbackQ as AnyObject, enumHandler as AnyObject)
    _ = enumSem.wait(timeout: .now() + 8.0)

    fputs("[simdevice-capture] Found \\(screens.count) screen(s)\\n", stderr)
    gScreens = screens
    if screens.isEmpty {
        fputs("[simdevice-capture] WARNING: No screens from enumerateScreens — will register on adapter descriptor directly\\n", stderr)
    }

    // 9. Query resolution from the first screen's properties (or fall back to defaults).
    //    Screen objects are ROCKRemoteProxy instances — KVC value(forKey:) is not available;
    //    use InvocationHelper to call the properties getter via the ObjC runtime.
    var encoderWidth = 1170
    var encoderHeight = 2532
    if let firstScreen = screens.first {
        let propsSel = NSSelectorFromString("properties")
        if let props = InvocationHelper.invoke(firstScreen, selector: propsSel) as? NSDictionary,
           let w = props["SimDeviceScreenPixelWidth"] as? Int,
           let h = props["SimDeviceScreenPixelHeight"] as? Int {
            encoderWidth = w
            encoderHeight = h
        }
    }
    fputs("[simdevice-capture] Encoder resolution: \\(encoderWidth)x\\(encoderHeight)\\n", stderr)

    // 10. Create the H.264 encoder.
    encoder = H264Encoder(width: encoderWidth, height: encoderHeight, fps: fps, label: udid)

    // 11. Register frame callbacks on every enumerated screen AND on the adapter descriptor.
    //     Some simulator versions fire callbacks at the descriptor level rather than on
    //     individual screen objects — registering on both ensures we get frames.
    let regSel = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")

    func registerCallbacks(on target: NSObject, label: String) -> NSUUID? {
        guard target.responds(to: regSel) else {
            fputs("[simdevice-capture] \\(label): does not respond to registerScreenCallbacksWithUUID — skipping\\n", stderr)
            return nil
        }
        guard let regIMP = class_getMethodImplementation(type(of: target), regSel) else {
            fputs("[simdevice-capture] \\(label): class_getMethodImplementation returned nil — skipping\\n", stderr)
            return nil
        }
        typealias RegFn = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject) -> Void
        let regFn = unsafeBitCast(regIMP, to: RegFn.self)

        let cbUUID = NSUUID()

        let frameBlock: @convention(block) () -> Void = {
            handleFrameReady()
        }

        let surfaceBlock: @convention(block) (AnyObject?, AnyObject?) -> Void = { _, newObj in
            guard let newObj = newObj else { return }
            // The new surface arrives as an IOSurface Swift class instance.
            // Store the object directly to avoid cross-process IOSurfaceLookup failures.
            if let surf = newObj as? IOSurface {
                surfaceLock.lock()
                currentSurface = surf
                surfaceLock.unlock()
            } else {
                // Fallback: surface was not an IOSurface — log and skip.
                fputs("[simdevice-capture] WARNING: surfacesChanged newObj is not IOSurface (\\(type(of: newObj))) — skipping\\n", stderr)
            }
        }

        let propsBlock: @convention(block) (AnyObject?) -> Void = { _ in }

        regFn(
            target, regSel,
            cbUUID as AnyObject,
            DispatchQueue.main as AnyObject,
            frameBlock as AnyObject,
            surfaceBlock as AnyObject,
            propsBlock as AnyObject
        )
        let uuidStr = cbUUID.uuidString
        fputs("[simdevice-capture] Registered callbacks on \\(label) (UUID=\\(uuidStr))\\n", stderr)
        return cbUUID
    }

    for (idx, screen) in screens.enumerated() {
        if let uuid = registerCallbacks(on: screen, label: "Screen[\\(idx)]") {
            gRegistrations.append((screen, uuid, "Screen[\\(idx)]"))
        }
    }
    // Belt-and-suspenders: also register on the adapter descriptor directly.
    if let uuid = registerCallbacks(on: screenAdapterDesc, label: "AdapterDesc") {
        gRegistrations.append((screenAdapterDesc, uuid, "AdapterDesc"))
    }

    // 12. Seed the initial IOSurface by fetching framebufferSurface from each screen.
    //     The surfacesChanged callback only fires when the surface *changes*; if the
    //     simulator is already rendering on a surface we registered before the first
    //     change, we need to pre-seed currentSurface so handleFrameReady() works.
    let fbSel = NSSelectorFromString("framebufferSurface")
    var seeded = false
    for screen in screens {
        guard screen.responds(to: fbSel) else { continue }
        guard let fbIMP = class_getMethodImplementation(type(of: screen), fbSel) else { continue }
        typealias FbFn = @convention(c) (AnyObject, Selector) -> AnyObject?
        let fbFn = unsafeBitCast(fbIMP, to: FbFn.self)
        guard let fbObj = fbFn(screen, fbSel) else { continue }
        if let surf = fbObj as? IOSurface {
            let surfId = IOSurfaceGetID(surf)
            if surfId != 0 {
                fputs("[simdevice-capture] Seeded initial surface id=\\(surfId) from framebufferSurface\\n", stderr)
                surfaceLock.lock()
                currentSurface = surf
                surfaceLock.unlock()
                seeded = true
                break
            }
        }
    }
    if !seeded {
        fputs("[simdevice-capture] WARNING: could not seed initial surface — waiting for surfacesChanged callback\\n", stderr)
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

connectAndCapture(udid: udid, fps: targetFps)
startIdleRefreshTimer(fps: targetFps)
fputs("[simdevice-capture] Running — capturing \\(udid) at \\(targetFps) fps\\n", stderr)
// RunLoop.main.run() with no registered sources starves DispatchQueue.main on macOS 26,
// preventing XPC frame callbacks from firing. Use a finite-interval loop instead —
// each iteration drains DispatchQueue.main via CFRunLoopRunInMode.
while true {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
}
`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the temporary file path used to store iOS screenshot data.
 *
 * @param sessionId - The session ID to embed in the path for uniqueness.
 * @returns An absolute path under `/tmp`.
 */
function iosTempFilePath(sessionId: string): string {
  return `/tmp/wms-capture-${sessionId}.jpg`;
}

/**
 * Tracks the current scrcpy TCP stream parsing phase for each session.
 *
 * Using a WeakMap avoids polluting the {@link InternalCaptureSession} interface
 * with scrcpy-specific state while still allowing garbage collection when
 * sessions are removed from `captures`.
 */
const scrcpyPhaseMap = new WeakMap<
  InternalCaptureSession,
  'handshake_dummy' | 'handshake_name' | 'handshake_codec' | 'handshake_size' | 'streaming_header' | 'streaming_payload'
>();

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Manages per-session screen capture loops for iOS Simulators and Android
 * emulators.
 *
 * For iOS, a persistent Swift binary is compiled on first use (via
 * `swiftc` + ScreenCaptureKit + VideoToolbox) and spawned per session.  The
 * binary supports two output modes selected via `--format`:
 * - `jpeg` (default): writes 4-byte big-endian length-prefixed JPEG frames to
 *   stdout, parsed and emitted as `'frame'` events.
 * - `h264`: uses VideoToolbox VTCompressionSession for hardware H.264 encoding
 *   and writes frames as `[4B length][1B flags][8B timestamp_us][Annex-B data]`.
 *
 * If compilation fails, the service falls back to the `xcrun simctl io
 * screenshot` polling loop.
 *
 * For Android, `adb exec-out screencap -p` is polled at the target FPS.
 *
 * Export the singleton `screenCaptureService` rather than constructing
 * instances directly.
 */
export class ScreenCaptureService {
  /** Active capture sessions keyed by session ID. */
  private readonly captures = new Map<string, InternalCaptureSession>();

  /** Shared promise for one-time SCK capture binary compilation. */
  private compileBinaryPromise: Promise<void> | null = null;

  /** Shared promise for one-time SimDeviceIO capture binary compilation. */
  private compileSimDeviceBinaryPromise: Promise<void> | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a screen-capture loop for a session.
   *
   * If a capture is already running for `sessionId` the existing
   * {@link EventEmitter} is returned unchanged.
   *
   * For iOS, a persistent ScreenCaptureKit-based process is spawned.  If
   * binary compilation fails the method transparently falls back to the
   * `xcrun simctl io screenshot` polling loop.
   *
   * Emits:
   * - `'frame'` — `Buffer` containing JPEG (iOS JPEG mode) or PNG (Android) image data.
   * - `'nalu'`  — {@link NaluFrame} emitted for each H.264 NALU when `captureFormat === 'h264'`.
   * - `'error'` — `Error` emitted after `MAX_CONSECUTIVE_FAILURES` consecutive
   *   capture failures; the loop is stopped before emission.
   *
   * @param sessionId     - Unique identifier for the session.
   * @param platform      - Target platform: `'ios'` or `'android'`.
   * @param deviceId      - iOS UDID or Android ADB serial (e.g. `'emulator-5554'`).
   * @param targetFps     - Desired capture rate (default {@link DEFAULT_TARGET_FPS}).
   * @param deviceName    - iOS Simulator device name used to locate the correct
   *                        Simulator window (iOS only, falls back to `deviceId`).
   * @param captureFormat - Output format for iOS capture: `'jpeg'` for MJPEG
   *                        streaming (default), `'h264'` for WebRTC H.264.
   * @returns An `EventEmitter` that emits `'frame'` / `'nalu'` / `'error'` events.
   */
  startCapture(
    sessionId: string,
    platform: 'ios' | 'android',
    deviceId: string,
    targetFps: number = DEFAULT_TARGET_FPS,
    deviceName?: string,
    captureFormat: 'jpeg' | 'h264' = 'jpeg',
  ): EventEmitter {
    const existing = this.captures.get(sessionId);
    if (existing) {
      log(`Capture already running for session ${sessionId} — returning existing emitter`);
      return existing.emitter;
    }

    const emitter = new EventEmitter();
    const abortController = new AbortController();

    const session: InternalCaptureSession = {
      sessionId,
      platform,
      deviceId,
      targetFps,
      active: true,
      emitter,
      abortController,
      frameBuffer: Buffer.alloc(0),
      captureFormat,
      captureDeviceId: deviceId,
    };

    this.captures.set(sessionId, session);

    log(`Starting ${platform} capture for session ${sessionId} (device=${deviceId}, fps=${targetFps}, format=${captureFormat})`);

    if (platform === 'ios') {
      void this.ensureSimDeviceCaptureBinaryCompiled()
        .then(() => {
          if (session.active) {
            session.useSimDeviceIO = true;
            this.startIOSCaptureProcess(session, deviceName ?? deviceId, true, deviceId);
          }
        })
        .catch((err: unknown) => {
          warn(`SimDeviceIO binary unavailable (${(err as Error).message}). Falling back to SCK capture.`);
          return this.ensureCaptureBinaryCompiled().then(() => {
            if (session.active) {
              session.useSimDeviceIO = false;
              this.startIOSCaptureProcess(session, deviceName ?? deviceId, false, deviceId);
            }
          });
        })
        .catch((err: unknown) => {
          warn(`All iOS capture binaries unavailable (${(err as Error).message}). Falling back to xcrun polling.`);
          if (session.active) {
            void this.runCaptureLoop(session);
          }
        });
    } else {
      if (captureFormat === 'h264') {
        // Try scrcpy H.264 streaming first, fall back to PNG polling on failure.
        void this.startAndroidScrcpyCapture(session).catch((err: unknown) => {
          warn(
            `scrcpy capture failed for session ${session.sessionId} ` +
            `(${(err as Error).message}). Falling back to PNG polling.`,
          );
          if (session.active) {
            session.captureFormat = 'jpeg';
            void this.runCaptureLoop(session);
          }
        });
      } else {
        void this.runCaptureLoop(session);
      }
    }

    return emitter;
  }

  /**
   * Stop the capture loop for a session and clean up any temp files.
   *
   * Safe to call even if no capture is running for `sessionId`.
   *
   * @param sessionId - Session whose capture should be stopped.
   */
  stopCapture(sessionId: string): void {
    const session = this.captures.get(sessionId);
    if (!session) return;

    log(`Stopping capture for session ${sessionId}`);
    session.active = false;
    session.abortController.abort();

    // Clean up Android scrcpy resources if this was a scrcpy capture.
    if (session.scrcpySocket) {
      try { session.scrcpySocket.destroy(); } catch { /* already closed */ }
      session.scrcpySocket = undefined;
    }
    if (session.scrcpyServerProcess) {
      try { session.scrcpyServerProcess.kill('SIGTERM'); } catch { /* already dead */ }
      session.scrcpyServerProcess = undefined;
    }
    if (session.scrcpyForwardPort && session.deviceId) {
      // Remove the ADB forward rule — fire and forget.
      execFileAsync(ADB, ['-s', session.deviceId, 'forward', '--remove', `tcp:${session.scrcpyForwardPort}`]).catch(() => {});
      session.scrcpyForwardPort = undefined;
    }

    // Kill the persistent iOS capture process if running.
    const hadCaptureProcess = !!session.captureProcess;
    if (session.captureProcess) {
      try { session.captureProcess.kill('SIGTERM'); } catch { /* already dead */ }
      session.captureProcess = undefined;
    }

    this.captures.delete(sessionId);

    // Best-effort temp file cleanup only for iOS xcrun fallback (no persistent process).
    if (session.platform === 'ios' && !hadCaptureProcess) {
      const tmpPath = iosTempFilePath(sessionId);
      unlink(tmpPath).catch(() => {
        // File may not exist if a frame was never captured — ignore silently.
      });
    }
  }

  /**
   * Stop all active capture loops.  Intended for graceful server shutdown.
   */
  cleanup(): void {
    log(`Stopping all ${this.captures.size} active capture(s)…`);
    for (const sessionId of this.captures.keys()) {
      this.stopCapture(sessionId);
    }
  }

  /**
   * Return the number of currently active capture loops.
   */
  getActiveCount(): number {
    return this.captures.size;
  }

  /**
   * Return the {@link EventEmitter} for a running capture session, or `null`
   * if no capture is active for `sessionId`.
   *
   * @param sessionId - Session to look up.
   */
  getEmitter(sessionId: string): EventEmitter | null {
    const session = this.captures.get(sessionId);
    return session?.emitter ?? null;
  }

  /**
   * Return the last cached keyframe for a running capture session, or `null`
   * if no keyframe has been received yet (or no capture is active).
   *
   * Used to replay the most recent IDR frame to newly connected WebSocket
   * clients so the browser's WebCodecs decoder can start immediately without
   * waiting for the next naturally occurring keyframe.
   *
   * @param sessionId - Session whose cached keyframe to retrieve.
   */
  getLastKeyframe(sessionId: string): NaluFrame | null {
    const session = this.captures.get(sessionId);
    return session?.lastKeyframe ?? null;
  }

  /**
   * Request that the capture binary for `sessionId` encode the next frame as
   * a keyframe.  Sends "K\n" to the binary's stdin which triggers
   * VideoToolbox's kVTEncodeFrameOptionKey_ForceKeyFrame.
   *
   * No-op if no capture is running for `sessionId` or the process has no stdin.
   *
   * @param sessionId - Session whose capture should produce a keyframe.
   */
  requestKeyframe(sessionId: string): void {
    const session = this.captures.get(sessionId);
    if (!session?.captureProcess?.stdin) return;

    try {
      session.captureProcess.stdin.write('K\n');
    } catch {
      // Process may have exited — ignore silently.
    }
  }

  // -------------------------------------------------------------------------
  // Private — iOS persistent capture binary
  // -------------------------------------------------------------------------

  /**
   * Idempotent: compiles the Swift iOS capture binary if it does not already
   * exist at {@link CAPTURE_BINARY_PATH}.  Concurrent calls share a single
   * compilation Promise so the binary is compiled at most once per process.
   *
   * Links `-framework ScreenCaptureKit` and `-framework VideoToolbox` to
   * support both JPEG and H.264 output modes.
   *
   * @throws If `swiftc` is unavailable or compilation fails.
   */
  private ensureCaptureBinaryCompiled(): Promise<void> {
    if (!this.compileBinaryPromise) {
      this.compileBinaryPromise = (async () => {
        // Check if a previously compiled binary is already present.
        try {
          await access(CAPTURE_BINARY_PATH, fsConstants.X_OK);
          // Binary exists — check whether it matches the current source version.
          try {
            const ver = await readFile(CAPTURE_BINARY_VERSION_PATH, 'utf8');
            if (ver.trim() === CAPTURE_BINARY_VERSION) {
              log('iOS capture binary already compiled — reusing cached binary');
              return;
            }
          } catch {
            // Version file missing — treat as stale and recompile.
          }
          // Version mismatch or missing version file — delete the stale binary.
          log('iOS capture binary is stale (source changed) — recompiling…');
          await unlink(CAPTURE_BINARY_PATH).catch(() => {});
        } catch {
          // Binary missing or not executable — proceed with compilation.
        }

        log('Compiling iOS capture binary (first run — this takes a few seconds)…');
        await writeFile(CAPTURE_SWIFT_TMP_PATH, IOS_CAPTURE_SWIFT_SOURCE, 'utf8');
        await execFileAsync('swiftc', [
          CAPTURE_SWIFT_TMP_PATH,
          '-framework', 'ScreenCaptureKit',
          '-framework', 'VideoToolbox',
          '-framework', 'CoreMedia',
          '-o', CAPTURE_BINARY_PATH,
        ], { timeout: 60_000 }); // swiftc can be slow
        await writeFile(CAPTURE_BINARY_VERSION_PATH, CAPTURE_BINARY_VERSION, 'utf8');
        log('iOS capture binary compiled successfully');
      })().catch((err: unknown) => {
        // Reset so a subsequent session can retry compilation.
        this.compileBinaryPromise = null;
        throw err;
      });
    }
    return this.compileBinaryPromise;
  }

  /**
   * Idempotent: compiles the SimDeviceIO Swift capture binary if it does not
   * already exist at {@link SIMDEVICE_CAPTURE_BINARY_PATH}.  Concurrent calls
   * share a single compilation Promise so the binary is compiled at most once
   * per process.
   *
   * Links `-framework Foundation -framework IOSurface -framework CoreGraphics
   * -framework CoreMedia -framework VideoToolbox` and the CoreSimulator
   * umbrella framework (for the private ObjC runtime symbols).
   * CoreSimDeviceIO is loaded at runtime via `dlopen` — the linker rejects
   * direct linkage as "not an allowed client".
   *
   * @throws If `swiftc` is unavailable, CoreSimulator is not installed, or
   *         compilation fails.
   */
  private ensureSimDeviceCaptureBinaryCompiled(): Promise<void> {
    if (!this.compileSimDeviceBinaryPromise) {
      this.compileSimDeviceBinaryPromise = (async () => {
        // Check if a previously compiled binary is already present.
        try {
          await access(SIMDEVICE_CAPTURE_BINARY_PATH, fsConstants.X_OK);
          // Binary exists — check whether it matches the current source version.
          try {
            const ver = await readFile(SIMDEVICE_CAPTURE_BINARY_VERSION_PATH, 'utf8');
            if (ver.trim() === SIMDEVICE_CAPTURE_BINARY_VERSION) {
              log('SimDeviceIO capture binary already compiled — reusing cached binary');
              return;
            }
          } catch {
            // Version file missing — treat as stale and recompile.
          }
          // Version mismatch or missing version file — delete the stale binary.
          log('SimDeviceIO capture binary is stale (source changed) — recompiling…');
          await unlink(SIMDEVICE_CAPTURE_BINARY_PATH).catch(() => {});
        } catch {
          // Binary missing or not executable — proceed with compilation.
        }

        log('Compiling SimDeviceIO capture binary (first run — this takes a few seconds)…');
        await writeFile(SIMDEVICE_CAPTURE_SWIFT_TMP_PATH, SIMDEVICE_IO_CAPTURE_SWIFT_SOURCE, 'utf8');

        const coreSimFrameworkPath =
          '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator';

        await execFileAsync('swiftc', [
          '-O',
          '-framework', 'Foundation',
          '-framework', 'IOSurface',
          '-framework', 'CoreGraphics',
          '-framework', 'CoreMedia',
          '-framework', 'VideoToolbox',
          '-Xlinker', '-rpath',
          '-Xlinker', '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Frameworks',
          SIMDEVICE_CAPTURE_SWIFT_TMP_PATH,
          '-o', SIMDEVICE_CAPTURE_BINARY_PATH,
          coreSimFrameworkPath,
        ], {
          timeout: 90_000, // swiftc with optimizations can be slow
          env: {
            ...process.env,
            DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
          },
        });
        await writeFile(SIMDEVICE_CAPTURE_BINARY_VERSION_PATH, SIMDEVICE_CAPTURE_BINARY_VERSION, 'utf8');
        log('SimDeviceIO capture binary compiled successfully');
      })().catch((err: unknown) => {
        // Reset so a subsequent session can retry compilation.
        this.compileSimDeviceBinaryPromise = null;
        throw err;
      });
    }
    return this.compileSimDeviceBinaryPromise;
  }

  /**
   * Spawn the persistent iOS capture binary for a session and wire up stdout
   * frame parsing and process lifecycle handling.
   *
   * When `useSimDeviceIO` is `true`, uses {@link SIMDEVICE_CAPTURE_BINARY_PATH}
   * with `--udid <deviceId>` arguments.  When `false`, uses
   * {@link CAPTURE_BINARY_PATH} with `--device-name <deviceName>` arguments.
   *
   * @param session        - The internal capture session (must have `platform === 'ios'`).
   * @param deviceName     - iOS Simulator device name used for SCK window discovery (SCK path only).
   * @param useSimDeviceIO - `true` to use the SimDeviceIO binary; `false` for the SCK binary.
   * @param deviceId       - iOS device UDID (used for captureDeviceId on the session).
   * @param restartCount   - Number of times this process has been restarted (default 0).
   *                         Used to limit total restart attempts to {@link MAX_IOS_CAPTURE_RESTARTS}.
   */
  private startIOSCaptureProcess(
    session: InternalCaptureSession,
    deviceName: string,
    useSimDeviceIO: boolean,
    deviceId: string = session.deviceId,
    restartCount: number = 0,
  ): void {
    const { sessionId, targetFps, captureFormat } = session;

    session.captureDeviceId = deviceId;

    let binaryPath: string;
    let spawnArgs: string[];

    if (useSimDeviceIO) {
      binaryPath = SIMDEVICE_CAPTURE_BINARY_PATH;
      spawnArgs = ['--udid', deviceId, '--fps', String(targetFps), '--format', 'h264'];
    } else {
      binaryPath = CAPTURE_BINARY_PATH;
      spawnArgs = ['--device-name', deviceName, '--fps', String(targetFps)];
      if (captureFormat === 'h264') {
        spawnArgs.push('--format', 'h264');
      }
    }

    const spawnEnv = useSimDeviceIO
      ? { ...process.env, DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer` }
      : process.env;

    const child = spawn(binaryPath, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    session.captureProcess = child;
    session.frameBuffer = Buffer.alloc(0);

    const effectiveCaptureFormat = useSimDeviceIO ? 'h264' : captureFormat;

    child.stdout!.on('data', (chunk: Buffer) => {
      session.frameBuffer = Buffer.concat([session.frameBuffer, chunk]);
      if (effectiveCaptureFormat === 'h264') {
        this.parseH264Buffer(session);
      } else {
        this.parseFrameBuffer(session);
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      warn(`iOS capture [${sessionId}]: ${data.toString().trim()}`);
    });

    child.on('exit', (code, signal) => {
      if (!session.active) return; // Normal stop via stopCapture — do nothing.

      if (restartCount < MAX_IOS_CAPTURE_RESTARTS) {
        warn(
          `iOS capture process for session ${sessionId} exited unexpectedly ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'null'}) — ` +
          `restarting (attempt ${restartCount + 1}/${MAX_IOS_CAPTURE_RESTARTS})…`,
        );
        // Keep the emitter in the captures map so WebSocket clients stay connected.
        setTimeout(() => {
          if (session.active) {
            this.startIOSCaptureProcess(session, deviceName, useSimDeviceIO, deviceId, restartCount + 1);
          }
        }, 1000);
      } else {
        warn(
          `iOS capture process for session ${sessionId} exhausted all ` +
          `${MAX_IOS_CAPTURE_RESTARTS} restart attempts — stopping capture.`,
        );
        const err = new Error(
          `iOS capture process exhausted all ${MAX_IOS_CAPTURE_RESTARTS} restart attempts`,
        );
        session.active = false;
        this.captures.delete(sessionId);
        session.emitter.emit('error', err);
      }
    });

    child.on('error', (err: Error) => {
      warn(`iOS capture process error for session ${sessionId}: ${err.message}`);
      if (!session.active) return;

      if (restartCount < MAX_IOS_CAPTURE_RESTARTS) {
        warn(
          `Restarting iOS capture process for session ${sessionId} ` +
          `(attempt ${restartCount + 1}/${MAX_IOS_CAPTURE_RESTARTS})…`,
        );
        setTimeout(() => {
          if (session.active) {
            this.startIOSCaptureProcess(session, deviceName, useSimDeviceIO, deviceId, restartCount + 1);
          }
        }, 1000);
      } else {
        session.active = false;
        this.captures.delete(sessionId);
        session.emitter.emit('error', err);
      }
    });

    const binaryLabel = useSimDeviceIO ? 'SimDeviceIO' : 'SCK';
    log(`iOS capture process started for session ${sessionId} (${binaryLabel} device="${useSimDeviceIO ? deviceId : deviceName}", fps=${targetFps}, format=${effectiveCaptureFormat})`);
  }

  /**
   * Parse as many complete length-prefixed JPEG frames as possible from
   * `session.frameBuffer`, emitting a `'frame'` event for each.
   *
   * Frame format: [4-byte big-endian uint32 length][JPEG bytes…]
   *
   * @param session - The iOS capture session whose `frameBuffer` to parse.
   */
  private parseFrameBuffer(session: InternalCaptureSession): void {
    const HEADER_SIZE = 4;
    while (session.frameBuffer.length >= HEADER_SIZE) {
      const frameLength = session.frameBuffer.readUInt32BE(0);

      if (session.frameBuffer.length < HEADER_SIZE + frameLength) {
        break; // Incomplete frame — wait for more data.
      }

      const jpegData = session.frameBuffer.subarray(HEADER_SIZE, HEADER_SIZE + frameLength);
      session.frameBuffer = session.frameBuffer.subarray(HEADER_SIZE + frameLength);

      if (session.active && !session.abortController.signal.aborted) {
        session.emitter.emit('frame', jpegData);
      }
    }
  }

  /**
   * Parse H.264 frames from the capture process stdout buffer, emitting a
   * `'nalu'` event for each complete frame.
   *
   * Frame format: [4B BE uint32 payload-length][1B flags][8B BE uint64 timestamp_us][Annex-B NALU data]
   *
   * The payload length covers the flags byte, timestamp bytes, and NALU data
   * (i.e. it does NOT include the 4-byte length prefix itself).
   *
   * @param session - The iOS capture session whose `frameBuffer` to parse.
   */
  private parseH264Buffer(session: InternalCaptureSession): void {
    const HEADER_SIZE = 4;
    while (session.frameBuffer.length >= HEADER_SIZE) {
      const payloadLength = session.frameBuffer.readUInt32BE(0);

      if (session.frameBuffer.length < HEADER_SIZE + payloadLength) {
        break; // Incomplete frame — wait for more data.
      }

      // Parse the payload fields.
      const flags = session.frameBuffer[HEADER_SIZE];
      const isKeyframe = (flags & 0x01) !== 0;

      // Read 8-byte BE uint64 timestamp (split into two 32-bit reads to avoid
      // precision loss — JavaScript numbers cannot represent all 64-bit integers).
      const timestampHigh = session.frameBuffer.readUInt32BE(HEADER_SIZE + 1);
      const timestampLow = session.frameBuffer.readUInt32BE(HEADER_SIZE + 5);
      const timestampUs = BigInt(timestampHigh) * BigInt(2 ** 32) + BigInt(timestampLow);

      const naluData = Buffer.from(
        session.frameBuffer.subarray(
          HEADER_SIZE + 1 + 8,
          HEADER_SIZE + payloadLength,
        ),
      );

      session.frameBuffer = session.frameBuffer.subarray(HEADER_SIZE + payloadLength);

      if (session.active && !session.abortController.signal.aborted) {
        const naluFrame: NaluFrame = { naluData, isKeyframe, timestampUs };

        if (naluFrame.isKeyframe) {
          session.lastKeyframe = naluFrame;
        }

        session.emitter.emit('nalu', naluFrame);

        // Periodic observability logging — log frame stats every 10 seconds.
        session.h264FrameCount = (session.h264FrameCount ?? 0) + 1;
        const now = Date.now();
        if (!session.lastH264LogTime || now - session.lastH264LogTime >= 10_000) {
          log(`H.264 session ${session.sessionId}: ${session.h264FrameCount} total frames, latest: keyframe=${naluFrame.isKeyframe}, ts=${naluFrame.timestampUs}µs`);
          session.lastH264LogTime = now;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — Android scrcpy H.264 capture
  // -------------------------------------------------------------------------

  /**
   * Start Android H.264 streaming via scrcpy-server.
   *
   * This method:
   * 1. Pushes `scrcpy-server.jar` to the device (idempotent).
   * 2. Sets up an ADB forward tunnel with a random allocated port.
   * 3. Spawns the scrcpy-server process via `adb shell`.
   * 4. Connects a TCP socket to the allocated port.
   * 5. Performs the scrcpy handshake (dummy byte, device name, codec, resolution).
   * 6. Parses the 12-byte scrcpy packet headers and emits {@link NaluFrame} events.
   * 7. Buffers config packets (SPS/PPS) and prepends them to the next media packet.
   *
   * Uses {@link session.frameBuffer} to accumulate partial TCP data across
   * socket `data` events; a state machine tracks the current parsing phase.
   *
   * @param session      - The internal capture session (must have `platform === 'android'`).
   * @param restartCount - Number of times this method has been restarted (default 0).
   *                       Limits total restart attempts to {@link MAX_ANDROID_SCRCPY_RESTARTS}.
   */
  private async startAndroidScrcpyCapture(
    session: InternalCaptureSession,
    restartCount: number = 0,
  ): Promise<void> {
    const { sessionId, deviceId } = session;

    // Generate a random 8-hex-char stream ID used to namespace the abstract socket.
    // scid must fit in a Java signed 32-bit integer (max 0x7FFFFFFF).
    // Mask the MSB to ensure non-negative value.
    const scidNum = randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF;
    const scid = scidNum.toString(16).padStart(8, '0');

    log(`[${sessionId}] Starting scrcpy capture for device ${deviceId} (scid=${scid}, attempt=${restartCount + 1})`);

    // Step 1 — Push the scrcpy-server jar to the device (idempotent).
    log(`[${sessionId}] Pushing scrcpy-server jar to device…`);
    await execFileAsync(ADB, ['-s', deviceId, 'push', SCRCPY_SERVER_JAR, '/data/local/tmp/scrcpy-server.jar']);
    log(`[${sessionId}] scrcpy-server jar pushed`);

    // Step 2 — Set up ADB forward tunnel. `tcp:0` lets the OS pick a free port.
    const { stdout: forwardStdout } = await execFileAsync(
      ADB,
      ['-s', deviceId, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`],
    );
    const allocatedPort = parseInt(forwardStdout.trim(), 10);
    if (!allocatedPort || Number.isNaN(allocatedPort)) {
      throw new Error(`adb forward returned unexpected port: "${forwardStdout.trim()}"`);
    }
    session.scrcpyForwardPort = allocatedPort;
    log(`[${sessionId}] ADB forward established on port ${allocatedPort}`);

    // Step 3 — Start the scrcpy-server process via adb shell.
    const serverProc = spawn(ADB, [
      '-s', deviceId,
      'shell',
      `CLASSPATH=/data/local/tmp/scrcpy-server.jar`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_SERVER_VERSION,
      `scid=${scid}`,
      'log_level=info',
      'audio=false',
      'max_size=720',
      'max_fps=30',
      'tunnel_forward=true',
      'control=false',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    session.scrcpyServerProcess = serverProc;

    serverProc.stderr?.on('data', (data: Buffer) => {
      warn(`[scrcpy-server][${sessionId}]: ${data.toString().trim()}`);
    });

    serverProc.stdout?.on('data', (data: Buffer) => {
      // The server writes startup messages to stdout — log them for diagnostics.
      const msg = data.toString().trim();
      if (msg) {
        log(`[scrcpy-server][${sessionId}]: ${msg}`);
      }
    });

    serverProc.on('exit', (code, signal) => {
      if (!session.active) return; // Normal stop — ignore.
      warn(
        `scrcpy-server process for session ${sessionId} exited unexpectedly ` +
        `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      // Socket close handler will take care of the restart logic.
    });

    // Step 4 — Wait ~1 second for scrcpy-server to start listening on the abstract socket.
    await sleep(1000);

    if (!session.active) return; // Session was stopped while waiting.

    // Step 5 — Connect via TCP to the forwarded port.
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port: allocatedPort, host: '127.0.0.1' });
      session.scrcpySocket = socket;

      // Reset the frame buffer and initialize parse state for this connection.
      session.frameBuffer = Buffer.alloc(0);
      scrcpyPhaseMap.set(session, 'handshake_dummy');

      // Track payload bytes remaining for the streaming_payload phase.
      let pendingPayloadSize = 0;
      // pts_flags for the current in-progress packet (parsed from header).
      let pendingPtsHigh = 0;
      let pendingPtsLow = 0;

      const onData = (chunk: Buffer): void => {
        session.frameBuffer = Buffer.concat([session.frameBuffer, chunk]);

        // Process as much data as possible from the accumulated buffer.
        let keepProcessing = true;
        while (keepProcessing && session.frameBuffer.length > 0) {
          const phase = scrcpyPhaseMap.get(session) ?? 'handshake_dummy';

          if (phase === 'handshake_dummy') {
            // Read 1 dummy byte.
            if (session.frameBuffer.length < 1) { keepProcessing = false; break; }
            session.frameBuffer = session.frameBuffer.subarray(1);
            scrcpyPhaseMap.set(session, 'handshake_name');

          } else if (phase === 'handshake_name') {
            // Read 64-byte null-padded UTF-8 device name.
            if (session.frameBuffer.length < 64) { keepProcessing = false; break; }
            const nameBytes = session.frameBuffer.subarray(0, 64);
            const nullIdx = nameBytes.indexOf(0);
            const deviceName = nameBytes.subarray(0, nullIdx === -1 ? 64 : nullIdx).toString('utf8');
            log(`[${sessionId}] scrcpy device name: "${deviceName}"`);
            session.frameBuffer = session.frameBuffer.subarray(64);
            scrcpyPhaseMap.set(session, 'handshake_codec');

          } else if (phase === 'handshake_codec') {
            // Read 4-byte BE codec_id. Expected: 0x68323634 ('h264').
            if (session.frameBuffer.length < 4) { keepProcessing = false; break; }
            const codecId = session.frameBuffer.readUInt32BE(0);
            const CODEC_H264 = 0x68323634;
            if (codecId !== CODEC_H264) {
              warn(`[${sessionId}] Unexpected scrcpy codec_id: 0x${codecId.toString(16)} (expected 0x68323634)`);
            }
            session.frameBuffer = session.frameBuffer.subarray(4);
            scrcpyPhaseMap.set(session, 'handshake_size');

          } else if (phase === 'handshake_size') {
            // Read 4-byte BE width + 4-byte BE height (8 bytes total).
            if (session.frameBuffer.length < 8) { keepProcessing = false; break; }
            const width = session.frameBuffer.readUInt32BE(0);
            const height = session.frameBuffer.readUInt32BE(4);
            log(`[${sessionId}] scrcpy initial resolution: ${width}×${height}`);
            session.frameBuffer = session.frameBuffer.subarray(8);
            scrcpyPhaseMap.set(session, 'streaming_header');
            // Handshake complete — resolve the outer promise so startCapture can return.
            resolve();

          } else if (phase === 'streaming_header') {
            // Read 12-byte packet header: [8B BE pts_flags][4B BE packet_size].
            if (session.frameBuffer.length < 12) { keepProcessing = false; break; }

            pendingPtsHigh = session.frameBuffer.readUInt32BE(0);
            pendingPtsLow = session.frameBuffer.readUInt32BE(4);
            pendingPayloadSize = session.frameBuffer.readUInt32BE(8);
            session.frameBuffer = session.frameBuffer.subarray(12);
            scrcpyPhaseMap.set(session, 'streaming_payload');

          } else if (phase === 'streaming_payload') {
            // Read pendingPayloadSize bytes of NALU data.
            if (session.frameBuffer.length < pendingPayloadSize) { keepProcessing = false; break; }

            const rawNalu = Buffer.from(session.frameBuffer.subarray(0, pendingPayloadSize));
            session.frameBuffer = session.frameBuffer.subarray(pendingPayloadSize);
            scrcpyPhaseMap.set(session, 'streaming_header');

            // Decode pts_flags:
            //   Bit 63 (MSB of pts_flags_high uint32): SC_PACKET_FLAG_CONFIG
            //   Bit 62: SC_PACKET_FLAG_KEY_FRAME
            //   Bits 0-61: PTS in microseconds
            const isConfig = (pendingPtsHigh & 0x80000000) !== 0;
            const isKeyframe = (pendingPtsHigh & 0x40000000) !== 0;

            // Extract PTS: mask out top 2 bits of the high 32 bits.
            const ptsHigh = pendingPtsHigh & 0x3FFFFFFF;
            const timestampUs = BigInt(ptsHigh) * BigInt(2 ** 32) + BigInt(pendingPtsLow);

            if (isConfig) {
              // Buffer SPS/PPS config data — do NOT emit standalone.
              session.scrcpyConfigBuffer = rawNalu;
              log(`[${sessionId}] scrcpy: buffered config packet (${rawNalu.length} bytes)`);
            } else if (session.active && !session.abortController.signal.aborted) {
              // Media packet: prepend buffered config data if present.
              let naluData: Buffer;
              if (isKeyframe && session.scrcpyConfigBuffer) {
                // Prepend SPS/PPS to every IDR frame so lastKeyframe always carries
                // the decoder configuration record. Do NOT clear scrcpyConfigBuffer —
                // scrcpy sends CONFIG only once, so we keep it for all future keyframes.
                naluData = Buffer.concat([session.scrcpyConfigBuffer, rawNalu]);
              } else {
                naluData = rawNalu;
              }

              const naluFrame: NaluFrame = {
                naluData,
                isKeyframe, // keyframe if IDR frame (SPS/PPS is prepended to every IDR)
                timestampUs,
              };

              if (naluFrame.isKeyframe) {
                session.lastKeyframe = naluFrame;
              }

              session.emitter.emit('nalu', naluFrame);

              // Periodic observability logging — log frame stats every 10 seconds.
              session.h264FrameCount = (session.h264FrameCount ?? 0) + 1;
              const now = Date.now();
              if (!session.lastH264LogTime || now - session.lastH264LogTime >= 10_000) {
                log(
                  `scrcpy H.264 session ${sessionId}: ${session.h264FrameCount} total frames, ` +
                  `latest: keyframe=${naluFrame.isKeyframe}, ts=${naluFrame.timestampUs}µs`,
                );
                session.lastH264LogTime = now;
              }
            }
          } else {
            // Should never happen — defensive guard.
            keepProcessing = false;
          }
        }
      };

      socket.on('data', onData);

      socket.on('error', (err: Error) => {
        warn(`[${sessionId}] scrcpy socket error: ${err.message}`);
        if (!session.active) return;

        // Reject the handshake promise if we haven't resolved yet.
        reject(err);

        // Schedule a restart attempt if within limits.
        if (restartCount < MAX_ANDROID_SCRCPY_RESTARTS) {
          warn(
            `[${sessionId}] Restarting scrcpy capture ` +
            `(attempt ${restartCount + 1}/${MAX_ANDROID_SCRCPY_RESTARTS})…`,
          );
          setTimeout(() => {
            if (session.active) {
              void this.startAndroidScrcpyCapture(session, restartCount + 1).catch((restartErr: unknown) => {
                warn(`[${sessionId}] scrcpy restart failed: ${(restartErr as Error).message}`);
                session.active = false;
                this.captures.delete(sessionId);
                session.emitter.emit('error', restartErr instanceof Error ? restartErr : new Error(String(restartErr)));
              });
            }
          }, 1000);
        } else {
          warn(`[${sessionId}] scrcpy capture exhausted all ${MAX_ANDROID_SCRCPY_RESTARTS} restart attempts`);
          session.active = false;
          this.captures.delete(sessionId);
          session.emitter.emit('error', err);
        }
      });

      socket.on('close', () => {
        if (!session.active) return; // Normal stop.

        warn(`[${sessionId}] scrcpy socket closed unexpectedly`);

        if (restartCount < MAX_ANDROID_SCRCPY_RESTARTS) {
          warn(
            `[${sessionId}] Restarting scrcpy capture after socket close ` +
            `(attempt ${restartCount + 1}/${MAX_ANDROID_SCRCPY_RESTARTS})…`,
          );
          setTimeout(() => {
            if (session.active) {
              void this.startAndroidScrcpyCapture(session, restartCount + 1).catch((restartErr: unknown) => {
                warn(`[${sessionId}] scrcpy restart failed: ${(restartErr as Error).message}`);
                session.active = false;
                this.captures.delete(sessionId);
                session.emitter.emit('error', restartErr instanceof Error ? restartErr : new Error(String(restartErr)));
              });
            }
          }, 1000);
        } else {
          warn(`[${sessionId}] scrcpy capture exhausted all ${MAX_ANDROID_SCRCPY_RESTARTS} restart attempts`);
          session.active = false;
          this.captures.delete(sessionId);
          session.emitter.emit('error', new Error(`scrcpy capture failed after ${MAX_ANDROID_SCRCPY_RESTARTS} restart attempts`));
        }
      });

      socket.on('connect', () => {
        log(`[${sessionId}] scrcpy TCP socket connected on port ${allocatedPort}`);
      });
    });

    log(`[${sessionId}] scrcpy handshake complete — streaming H.264`);
  }

  // -------------------------------------------------------------------------
  // Private — capture loops
  // -------------------------------------------------------------------------

  /**
   * Main capture loop.  Runs until the session's `AbortController` is aborted
   * or `MAX_CONSECUTIVE_FAILURES` consecutive errors occur.
   *
   * Used by Android and by the iOS xcrun fallback path.
   *
   * @param session - The internal capture session to run the loop for.
   */
  private async runCaptureLoop(session: InternalCaptureSession): Promise<void> {
    const { sessionId, platform, targetFps } = session;
    const frameIntervalMs = Math.round(1000 / targetFps);
    let consecutiveFailures = 0;

    while (session.active && !session.abortController.signal.aborted) {
      const frameStart = Date.now();

      try {
        let frame: Buffer;

        if (platform === 'ios') {
          frame = await this.captureIOSFrame(session);
        } else {
          frame = await this.captureAndroidFrame(session);
        }

        // Reset failure counter on success.
        consecutiveFailures = 0;

        if (session.active && !session.abortController.signal.aborted) {
          session.emitter.emit('frame', frame);
        }
      } catch (error: unknown) {
        consecutiveFailures++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        warn(
          `Capture failure #${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} ` +
          `for session ${sessionId}: ${errorMessage}`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          warn(`Session ${sessionId} exceeded max failures — stopping capture loop`);
          session.active = false;
          this.captures.delete(sessionId);

          const captureError = new Error(
            `Screen capture for session ${sessionId} failed after ` +
            `${MAX_CONSECUTIVE_FAILURES} consecutive errors. ` +
            `Last error: ${errorMessage}`,
          );
          session.emitter.emit('error', captureError);
          return;
        }

        // Retry after a short delay.
        await sleep(FAILURE_RETRY_DELAY_MS);
        continue;
      }

      // Throttle to target FPS: sleep for the remaining frame budget.
      const elapsed = Date.now() - frameStart;
      const remaining = frameIntervalMs - elapsed;
      if (remaining > 0 && session.active && !session.abortController.signal.aborted) {
        await sleep(remaining);
      }
    }

    log(`Capture loop ended for session ${sessionId}`);
  }

  /**
   * Capture a single JPEG frame from an iOS Simulator using `xcrun simctl io`.
   *
   * Writes the screenshot to a per-session temp file then reads it back as a
   * `Buffer`.  Using a file is required because `simctl io screenshot` does
   * not reliably write image data to stdout.
   *
   * @param session - The internal capture session (must have `platform === 'ios'`).
   * @returns A `Buffer` containing JPEG image data.
   */
  private async captureIOSFrame(session: InternalCaptureSession): Promise<Buffer> {
    const { deviceId } = session;
    const tmpPath = iosTempFilePath(session.sessionId);

    await execFileAsync(
      'xcrun',
      ['simctl', 'io', deviceId, 'screenshot', '--type=jpeg', tmpPath],
      {
        maxBuffer: 1024 * 1024,
        ...XCRUN_EXEC_OPTIONS,
      },
    );

    return readFile(tmpPath);
  }

  /**
   * Capture a single PNG frame from an Android emulator using `adb exec-out screencap`.
   *
   * The `adb exec-out screencap -p` command writes raw PNG data directly to
   * stdout, so we capture it as a binary `Buffer`.
   *
   * @param session - The internal capture session (must have `platform === 'android'`).
   * @returns A `Buffer` containing PNG image data.
   */
  private async captureAndroidFrame(session: InternalCaptureSession): Promise<Buffer> {
    const { deviceId } = session;

    const result = await execFileAsync(
      ADB,
      ['-s', deviceId, 'exec-out', 'screencap', '-p'],
      // `encoding: 'buffer'` keeps stdout as a raw Buffer instead of a string.
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
    );

    // When encoding is 'buffer', stdout is typed as Buffer by Node's overloads.
    const stdout = result.stdout as unknown as Buffer;

    if (!stdout || stdout.length === 0) {
      throw new Error(`adb screencap returned empty data for device ${deviceId}`);
    }

    return stdout;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const screenCaptureService = new ScreenCaptureService();
