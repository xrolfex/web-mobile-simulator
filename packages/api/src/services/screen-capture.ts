import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, unlink, writeFile, access, constants as fsConstants } from 'node:fs/promises';
import { promisify } from 'node:util';
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

  /** Shared promise for one-time capture binary compilation. */
  private compileBinaryPromise: Promise<void> | null = null;

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
    };

    this.captures.set(sessionId, session);

    log(`Starting ${platform} capture for session ${sessionId} (device=${deviceId}, fps=${targetFps}, format=${captureFormat})`);

    if (platform === 'ios') {
      // Start a persistent SCStream-based capture process.
      // Falls back to the xcrun polling loop if compilation fails.
      void this.ensureCaptureBinaryCompiled()
        .then(() => {
          if (session.active) {
            this.startIOSCaptureProcess(session, deviceName ?? deviceId);
          }
        })
        .catch((err: unknown) => {
          warn(
            `iOS capture binary unavailable (${(err as Error).message}). ` +
            'Falling back to xcrun screenshot polling.',
          );
          if (session.active) {
            void this.runCaptureLoop(session);
          }
        });
    } else {
      void this.runCaptureLoop(session);
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
   * Spawn the persistent iOS capture binary for a session and wire up
   * stdout frame parsing and process lifecycle handling.
   *
   * @param session      - The internal capture session (must have platform === 'ios').
   * @param deviceName   - iOS Simulator device name used to locate the correct window.
   * @param restartCount - Number of times this process has been restarted (default 0).
   *                       Used to limit total restart attempts to {@link MAX_IOS_CAPTURE_RESTARTS}.
   */
  private startIOSCaptureProcess(
    session: InternalCaptureSession,
    deviceName: string,
    restartCount: number = 0,
  ): void {
    const { sessionId, targetFps, captureFormat } = session;

    const spawnArgs = [
      '--device-name', deviceName,
      '--fps', String(targetFps),
    ];

    if (captureFormat === 'h264') {
      spawnArgs.push('--format', 'h264');
    }

    const child = spawn(CAPTURE_BINARY_PATH, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin is now 'pipe' instead of 'ignore'
    });

    session.captureProcess = child;
    session.frameBuffer = Buffer.alloc(0);

    child.stdout!.on('data', (chunk: Buffer) => {
      session.frameBuffer = Buffer.concat([session.frameBuffer, chunk]);
      if (captureFormat === 'h264') {
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
        // Restart after a short delay to let Simulator.app fully appear.
        setTimeout(() => {
          if (session.active) {
            this.startIOSCaptureProcess(session, deviceName, restartCount + 1);
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
            this.startIOSCaptureProcess(session, deviceName, restartCount + 1);
          }
        }, 1000);
      } else {
        session.active = false;
        this.captures.delete(sessionId);
        session.emitter.emit('error', err);
      }
    });

    log(`iOS capture process started for session ${sessionId} (device="${deviceName}", fps=${targetFps}, format=${captureFormat})`);
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
