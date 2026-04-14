import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DeviceType,
  DeviceState,
  Runtime,
  SimulatorDevice,
} from '@web-mobile-simulator/shared';
import { DEVICE_BOOT_TIMEOUT_MS } from '@web-mobile-simulator/shared';
import { exec, execJSON } from '../utils/exec.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Internal types — raw shapes returned by `xcrun simctl list … -j`
// ---------------------------------------------------------------------------

/** A device-type entry from `xcrun simctl list devicetypes -j`. */
interface SimctlDeviceType {
  /** Human-readable name, e.g. "iPhone 15 Pro". */
  name: string;
  /** Reverse-DNS identifier, e.g. "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro". */
  identifier: string;
  minRuntimeVersion: number;
  maxRuntimeVersion: number;
  /** Product family string, e.g. "iPhone", "iPad", "Apple Watch". */
  productFamily: string;
}

/** A runtime entry from `xcrun simctl list runtimes -j`. */
interface SimctlRuntime {
  /** Human-readable name, e.g. "iOS 17.5". */
  name: string;
  /** Reverse-DNS identifier, e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5". */
  identifier: string;
  /** Version string, e.g. "17.5". */
  version: string;
  /** Whether Xcode considers this runtime usable. */
  isAvailable: boolean;
  buildversion: string;
  /** Platform family string, e.g. "iOS", "tvOS", "watchOS". */
  platform: string;
  bundlePath: string;
  supportedDeviceTypes: Array<{ identifier: string; name: string }>;
}

/** A simulator device entry from `xcrun simctl list devices -j`. */
interface SimctlDevice {
  udid: string;
  name: string;
  /** Lifecycle state string, e.g. "Shutdown", "Booted", "Booting". */
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string;
  availabilityError?: string;
  dataPath: string;
  logPath: string;
}

/** Top-level shape of `xcrun simctl list -j` output. */
interface SimctlListOutput {
  devicetypes: SimctlDeviceType[];
  runtimes: SimctlRuntime[];
  /** Devices keyed by runtime identifier string. */
  devices: Record<string, SimctlDevice[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIMCTL = 'xcrun';
const LOG_PREFIX = '[IOSSimulatorService]';

/** How long (ms) to cache Simulator window geometry before re-querying. */
const GEOMETRY_CACHE_TTL_MS = 2000;

/** Private temp directory for WMS iOS input binary (restrictive permissions). */
const WMS_INPUT_TMP_DIR = join(tmpdir(), 'wms-ios-input-dir');

// Create the directory eagerly at module load with 0o700 (owner-only access).
// mkdirSync with recursive:true is idempotent — safe for module re-evaluation.
mkdirSync(WMS_INPUT_TMP_DIR, { recursive: true, mode: 0o700 });

/** Path where the compiled iOS input binary is cached. */
const INPUT_BINARY_PATH = join(WMS_INPUT_TMP_DIR, 'wms-ios-input');

/** Temp path for Swift source before compilation. */
const INPUT_SWIFT_TMP_PATH = join(WMS_INPUT_TMP_DIR, 'wms-ios-input.swift');

/** Version tag — increment to force recompilation. */
const INPUT_BINARY_VERSION = '4';

/** Sidecar file storing the version of the cached binary. */
const INPUT_BINARY_VERSION_PATH = join(WMS_INPUT_TMP_DIR, 'wms-ios-input.ver');

/** Path where the compiled IndigoHID binary is cached. */
const INDIGO_BINARY_PATH = join(WMS_INPUT_TMP_DIR, 'wms-indigo-hid');

/** Temp path for Swift source before compilation. */
const INDIGO_SWIFT_TMP_PATH = join(WMS_INPUT_TMP_DIR, 'wms-indigo-hid.swift');

/** Version tag — increment to force recompilation of IndigoHID binary. */
const INDIGO_BINARY_VERSION = '6';

/** Sidecar file storing the version of the cached IndigoHID binary. */
const INDIGO_BINARY_VERSION_PATH = join(WMS_INPUT_TMP_DIR, 'wms-indigo-hid.ver');

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

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

/**
 * Map a raw simctl state string to our shared `DeviceState` union.
 * Unknown strings fall back to `'error'`.
 */
function mapSimctlState(rawState: string): DeviceState {
  switch (rawState.toLowerCase()) {
    case 'shutdown':
      return 'shutdown';
    case 'booting':
      return 'booting';
    case 'booted':
      return 'booted';
    case 'shutting down':
      return 'shutting_down';
    default:
      return 'error';
  }
}

/** Product families we expose — skip Watch, TV, Vision, etc. */
const SUPPORTED_FAMILIES = new Set(['iPhone', 'iPad']);

// ---------------------------------------------------------------------------
// Embedded Swift source — iOS input helper
// ---------------------------------------------------------------------------

/**
 * Swift source for the reusable iOS input helper binary.
 * Handles tap, swipe, key, type, keystroke, shortcut, geometry, and
 * toolbar-hide via command-line arguments so the binary is compiled once and
 * reused across many calls (avoiding ~80-150 ms Swift JIT overhead per
 * invocation).
 *
 * Commands:
 *   tap <x> <y>                         — mouse down/up at screen coords
 *   swipe <x1> <y1> <x2> <y2> <steps> <stepDelay> — drag gesture
 *   key <virtualKeyCode>                — CGEvent key down+up by macOS vkey
 *   type <text…>                        — CGEvent Unicode posting per char
 *   keystroke <char>                    — CGEvent Unicode single char
 *   shortcut <keyCode> <modifiers>      — key press with modifier flags
 *   geometry                            — print windowX,windowY,windowWidth,windowHeight
 *   toolbar-hide                        — toggle Simulator toolbar (Cmd+Opt+T)
 */
const IOS_INPUT_SWIFT_SOURCE = `
import CoreGraphics
import Foundation
import AppKit
import Carbon

// Parse command line
let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: wms-ios-input <command> [args...]\\n", stderr)
    fputs("Commands: tap, swipe, key, type, keystroke, geometry, toolbar-hide\\n", stderr)
    exit(1)
}

let command = args[1]

// Find Simulator.app (most commands need it)
let simulatorApps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator")

func requireSimulator() -> NSRunningApplication {
    guard let sim = simulatorApps.first else {
        fputs("ERROR: Simulator.app not running\\n", stderr)
        exit(1)
    }
    return sim
}

/// Save a reference to the currently focused app so we can restore it after posting events.
let previousApp = NSWorkspace.shared.frontmostApplication

/// Activate Simulator and wait for the window server to bring it to front.
func activateSimulator() {
    let sim = requireSimulator()
    sim.activate(options: .activateIgnoringOtherApps)
    Thread.sleep(forTimeInterval: 0.05)
}

/// Re-activate the app that was focused before we activated Simulator.
/// This is a no-op if Simulator was already the frontmost app.
func reactivatePreviousApp() {
    guard let prev = previousApp,
          prev.processIdentifier != requireSimulator().processIdentifier else { return }
    // Small delay to let posted events be processed by Simulator before switching away
    Thread.sleep(forTimeInterval: 0.05)
    prev.activate(options: .activateIgnoringOtherApps)
}

func postMouse(_ type: CGEventType, _ x: Double, _ y: Double) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: UInt16, _ keyDown: Bool, _ modifiers: CGEventFlags = []) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else { return }
    event.flags = modifiers
    event.post(tap: .cghidEventTap)
}

func postKeyPress(_ keyCode: UInt16, _ modifiers: CGEventFlags = []) {
    postKey(keyCode, true, modifiers)
    Thread.sleep(forTimeInterval: 0.01)
    postKey(keyCode, false, modifiers)
}

switch command {
case "tap":
    guard args.count >= 4,
          let x = Double(args[2]),
          let y = Double(args[3]) else {
        fputs("Usage: wms-ios-input tap <x> <y>\\n", stderr)
        exit(1)
    }
    activateSimulator()
    postMouse(.leftMouseDown, x, y)
    Thread.sleep(forTimeInterval: 0.03)
    postMouse(.leftMouseUp, x, y)
    reactivatePreviousApp()

case "swipe":
    guard args.count >= 8,
          let x1 = Double(args[2]),
          let y1 = Double(args[3]),
          let x2 = Double(args[4]),
          let y2 = Double(args[5]),
          let steps = Int(args[6]),
          let stepDelay = Double(args[7]) else {
        fputs("Usage: wms-ios-input swipe <x1> <y1> <x2> <y2> <steps> <stepDelay>\\n", stderr)
        exit(1)
    }
    activateSimulator()
    postMouse(.leftMouseDown, x1, y1)
    Thread.sleep(forTimeInterval: 0.02)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let ix = x1 + (x2 - x1) * t
        let iy = y1 + (y2 - y1) * t
        postMouse(.leftMouseDragged, ix, iy)
        Thread.sleep(forTimeInterval: stepDelay)
    }
    postMouse(.leftMouseUp, x2, y2)
    reactivatePreviousApp()

case "key":
    // Usage: wms-ios-input key <virtualKeyCode>
    // Posts a single key down+up event using the macOS virtual key code.
    guard args.count >= 3,
          let keyCode = UInt16(args[2]) else {
        fputs("Usage: wms-ios-input key <virtualKeyCode>\\n", stderr)
        exit(1)
    }
    activateSimulator()
    postKeyPress(keyCode)
    reactivatePreviousApp()

case "type":
    // Usage: wms-ios-input type <text>
    // Types a string by posting CGEvent keyboard events with Unicode characters.
    guard args.count >= 3 else {
        fputs("Usage: wms-ios-input type <text>\\n", stderr)
        exit(1)
    }
    // Join remaining args in case text had spaces
    let text = args[2...].joined(separator: " ")
    activateSimulator()
    for char in text {
        let utf16 = Array(String(char).utf16)
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { continue }
        event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.005)
        guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        upEvent.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.005)
    }
    reactivatePreviousApp()

case "keystroke":
    // Usage: wms-ios-input keystroke <char>
    // Types a single character using CGEvent Unicode posting.
    guard args.count >= 3 else {
        fputs("Usage: wms-ios-input keystroke <char>\\n", stderr)
        exit(1)
    }
    let char = args[2]
    activateSimulator()
    let utf16 = Array(char.utf16)
    guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
        fputs("ERROR: Failed to create CGEvent\\n", stderr)
        exit(1)
    }
    downEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    downEvent.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.01)
    if let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
        upEvent.post(tap: .cghidEventTap)
    }
    reactivatePreviousApp()

case "shortcut":
    // Usage: wms-ios-input shortcut <keyCode> <modifiers>
    // modifiers is a comma-separated list: cmd,shift,ctrl,opt
    guard args.count >= 4,
          let keyCode = UInt16(args[2]) else {
        fputs("Usage: wms-ios-input shortcut <keyCode> <modifiers: cmd,shift,ctrl,opt>\\n", stderr)
        exit(1)
    }
    let modParts = args[3].lowercased().split(separator: ",")
    var flags: CGEventFlags = []
    for mod in modParts {
        switch mod {
        case "cmd":   flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "ctrl":  flags.insert(.maskControl)
        case "opt":   flags.insert(.maskAlternate)
        default: break
        }
    }
    activateSimulator()
    postKeyPress(keyCode, flags)
    reactivatePreviousApp()

case "geometry":
    // Usage: wms-ios-input geometry
    // Returns window geometry as: windowX,windowY,windowWidth,windowHeight
    // Uses CGWindowListCopyWindowInfo — NO accessibility permission needed.
    let sim = requireSimulator()
    let pid = sim.processIdentifier

    guard let windowInfoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        fputs("ERROR: Failed to query window list\\n", stderr)
        exit(1)
    }

    // Find the main Simulator window (layer 0 = normal window, not menu/popover)
    var found = false
    for info in windowInfoList {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int32,
              ownerPID == pid,
              let bounds = info[kCGWindowBounds as String] as? [String: Double],
              let layer = info[kCGWindowLayer as String] as? Int,
              layer == 0,
              let wx = bounds["X"],
              let wy = bounds["Y"],
              let ww = bounds["Width"],
              let wh = bounds["Height"],
              ww > 50, wh > 50 else { continue }
        // Output: windowX,windowY,windowWidth,windowHeight
        print("\\(Int(wx)),\\(Int(wy)),\\(Int(ww)),\\(Int(wh))")
        found = true
        break
    }
    if !found {
        fputs("ERROR: No Simulator window found\\n", stderr)
        exit(1)
    }

case "toolbar-hide":
    // Usage: wms-ios-input toolbar-hide
    // Toggles the toolbar visibility using Cmd+Opt+T (View > Toggle Toolbar in Simulator.app)
    // Note: This is Simulator.app's keyboard shortcut for View > Show/Hide Toolbar.
    // kVK_ANSI_T = 17
    activateSimulator()
    postKeyPress(17, [.maskCommand, .maskAlternate])
    reactivatePreviousApp()

default:
    fputs("Unknown command: \\(command)\\n", stderr)
    exit(1)
}
`;

/** Embedded Swift source for the IndigoHID binary (wms-indigo-hid).
 * Uses SimulatorKit's private IndigoHID APIs to inject touch, keyboard,
 * and button events directly to the simulator's backboard — no Simulator.app
 * focus required.
 */
const INDIGO_HID_SWIFT_SOURCE = `/// wms-indigo-poc.swift
///
/// Proof-of-Concept: Inject touch events into an iOS Simulator using
/// SimulatorKit's IndigoHID mechanism, bypassing the macOS window server
/// entirely (no CGEvent, no Simulator.app focus required).
///
/// Build:   see build.sh
/// Usage:
///   wms-indigo-poc --discover
///   wms-indigo-poc <udid> tap <normX> <normY>
///
/// Technique:
///   1. dlopen CoreSimulator + SimulatorKit private frameworks
///   2. Use NSClassFromString / ObjC runtime to find SimServiceContext,
///      SimDeviceSet, and the target SimDevice by UDID
///   3. Create a SimDeviceLegacyHIDClient for the device (Swift class in
///      SimulatorKit — accessed via ObjC runtime bridging)
///   4. Synthesise an IndigoHIDMessageStruct touch (down + up) using
///      IndigoHIDMessageForMouseNSEvent (C function in SimulatorKit)
///   5. Send the message via SimDeviceLegacyHIDClient.send(message:)
///
/// Author: WMS POC — Eric (via Builder agent), 2026

import Foundation
import AppKit
import ObjectiveC

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Framework loading
// ──────────────────────────────────────────────────────────────────────────────

/// Paths to the private frameworks we need.
let kCoreSimulatorPath =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
let kSimulatorKitPath: String = {
    let devDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"
    return "\\(devDir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
}()

/// Load a dynamic library, aborting with a diagnostic if it fails.
func loadFramework(_ path: String) {
    guard dlopen(path, RTLD_NOW | RTLD_GLOBAL) != nil else {
        let reason = String(cString: dlerror())
        fputs("❌ Failed to load \\(path)\\n   Reason: \\(reason)\\n", stderr)
        exit(1)
    }
    fputs("✅ Loaded \\(path)\\n", stderr)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - ObjC runtime helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Perform a zero-argument selector on an object, returning the result as AnyObject?.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel)?.takeUnretainedValue()
}

/// Perform a one-argument selector on an object.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector, with arg: AnyObject?) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel, with: arg)?.takeUnretainedValue()
}

/// Perform a two-argument selector on an object.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector, with arg1: AnyObject?, and arg2: AnyObject?) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel, with: arg1, with: arg2)?.takeUnretainedValue()
}

/// Return all method names on an ObjC class.
func methodNames(of cls: AnyClass) -> [String] {
    var count: UInt32 = 0
    guard let methods = class_copyMethodList(cls, &count) else { return [] }
    defer { free(methods) }
    return (0..<Int(count)).map { NSStringFromSelector(method_getName(methods[$0])) }
}

/// Return all class method names on an ObjC class.
func classMethodNames(of cls: AnyClass) -> [String] {
    guard let meta = object_getClass(cls) else { return [] }
    return methodNames(of: meta)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHIDMessageStruct (opaque)
// ──────────────────────────────────────────────────────────────────────────────

/// Opaque representation of IndigoHIDMessageStruct.
/// The actual layout is private, but we only need to hold a pointer
/// returned by IndigoHIDMessageForMouseNSEvent and pass it to send().
/// Size is at least 0x200 bytes based on disassembly of IndigoHIDMessageForMouseNSEvent
/// (calloc(1, 0x200) observed at 0x11284–0x112ec in SimulatorKit arm64e).
struct IndigoHIDMessageStruct {
    var storage: (
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64
    ) = (
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
    )
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHID C-function signatures (resolved via dlsym)
// ──────────────────────────────────────────────────────────────────────────────

/// IndigoHIDMessageForMouseNSEvent signature (reverse-engineered from the
/// embedded debug string in SimulatorKit binary).
///
/// C signature:
///   IndigoHIDMessage *IndigoHIDMessageForMouseNSEvent(
///       CGPoint *point0,        // x0 — pointer to primary touch coords (0.0–1.0)
///       CGPoint *point1,        // x1 — pointer to secondary touch coords (NULL for single)
///       IndigoHIDTarget target, // x2 — HID target (0x40000000 for digitizer touch, 0x35 for pointer)
///       NSEventType eventType,  // x3 — 1 = ButtonEventTypeDown, 2 = ButtonEventTypeUp
///       NSSize size,            // d0 = width, d1 = height — scale divisors (1.0, 1.0)
///       IndigoHIDEdge edge      // x4 — edge flags (0 = none)
///   )
///
/// arm64 register layout (integer and float register files are independent):
///   x0 = point0  (pointer)
///   x1 = point1  (pointer, nil for single touch)
///   x2 = target  (integer, 0x40000000 for digitizer touch)
///   x3 = eventType (integer, 1=down / 2=up)
///   x4 = edge    (integer, 0 = none)
///   d0 = size.width  (float, 1.0)
///   d1 = size.height (float, 1.0)
///
/// Swift @convention(c) assigns x-registers to pointer/integer params in
/// declaration order, and d-registers to float params in declaration order,
/// independently — so listing all pointer/int params first, then floats,
/// then the trailing int correctly maps every argument to its register.
///
/// Returns: heap-allocated pointer to IndigoHIDMessageStruct (caller should
///          not free when passing freeWhenDone:false to the send call).
typealias IndigoHIDMessageForMouseNSEventFn = @convention(c) (
    UnsafeMutableRawPointer?,   // x0 — point0 (CGPoint*, primary touch coords)
    UnsafeMutableRawPointer?,   // x1 — point1 (CGPoint*, nil for single touch)
    UInt,                        // x2 — target (0x40000000 for digitizer, 0x35 for pointer)
    UInt,                        // x3 — eventType (1=down, 2=up)
    Double,                      // d0 — size.width  (1.0)
    Double,                      // d1 — size.height (1.0)
    UInt                         // x4 — edge (0 = none)
) -> UnsafeMutableRawPointer?

/// IndigoHIDMessageForKeyboardArbitrary — keyboard events via USB HID usage code.
///
/// C signature (reverse-engineered from SimulatorKit disassembly):
///   IndigoHIDMessage *IndigoHIDMessageForKeyboardArbitrary(
///       uint32_t usageCode,   // x0 — USB HID Keyboard/Keypad page usage code
///       uint32_t keyState     // x1 — 1=down, 2=up
///   )
///
/// The function allocates a 0xC0-byte struct, sets message type to 3 (keyboard),
/// populates the usage code and key state. No target parameter needed.
typealias IndigoHIDMessageForKeyboardArbitraryFn = @convention(c) (
    UInt32,   // x0 — usageCode (USB HID usage code, e.g. 0x04='a', 0x28=Enter)
    UInt32    // x1 — keyState (1=down, 2=up)
) -> UnsafeMutableRawPointer?

/// IndigoHIDMessageForButton — hardware button events (home, lock, volume).
///
/// C signature (reverse-engineered from SimulatorKit disassembly):
///   IndigoHIDMessage *IndigoHIDMessageForButton(
///       uint32_t buttonCode,  // x0 — button key code
///       uint32_t keyState,    // x1 — 1=down, 2=up
///       uint32_t target       // x2 — IndigoHIDTarget (0x33 for iPhone)
///   )
///
/// Button codes (from Simulator.app disassembly):
///   0    = Home button (Face ID devices — wzr)
///   401  = Home button (Touch ID devices — 0x191)
///   1    = Lock/Power/Side button
typealias IndigoHIDMessageForButtonFn = @convention(c) (
    UInt32,   // x0 — buttonCode
    UInt32,   // x1 — keyState (1=down, 2=up)
    UInt32    // x2 — target (0x33 for iPhone/iPad)
) -> UnsafeMutableRawPointer?

/// IndigoHIDMessageForHIDArbitrary — arbitrary USB HID page events.
///
/// C signature (from embedded debug string in SimulatorKit):
///   IndigoHIDMessage *IndigoHIDMessageForHIDArbitrary(
///       IndigoHIDTarget target,    // x0 — HID target (0x33 for iPhone)
///       uint32_t        usagePage, // x1 — HID Usage Page (e.g. 0x0c = Consumer Control)
///       uint32_t        usageCode, // x2 — HID Usage Code (e.g. 0xe9 = Volume Up)
///       IndigoHIDButtonOp buttonOp // x3 — 1=down, 2=up
///   )
///
/// Used for volume buttons (usagePage=0x0c Consumer Control):
///   Volume Up:   usageCode=0xe9
///   Volume Down: usageCode=0xea
typealias IndigoHIDMessageForHIDArbitraryFn = @convention(c) (
    UInt32,   // x0 — target (0x33 for iPhone/iPad)
    UInt32,   // x1 — usagePage
    UInt32,   // x2 — usageCode
    UInt32    // x3 — buttonOp (1=down, 2=up)
) -> UnsafeMutableRawPointer?

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Discover mode
// ──────────────────────────────────────────────────────────────────────────────

/// Print a formatted list of known CoreSimulator / SimulatorKit ObjC classes
/// and their instance + class methods. Uses targeted \`NSClassFromString\` lookups
/// rather than \`objc_copyClassList\`, which hangs when iterating ~60 k classes
/// (triggers Swift runtime realization for every class in the loaded images).
func discoverClasses() {
    // Known ObjC/Swift class names in CoreSimulator and SimulatorKit.
    // Add more names here as needed; each is looked up with NSClassFromString.
    let knownNames: [String] = [
        // CoreSimulator
        "SimServiceContext",
        "SimDeviceSet",
        "SimDevice",
        "SimRuntime",
        "SimDeviceType",
        // SimulatorKit — Swift classes use mangled names
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient",
        "_TtC12SimulatorKit16SimHIDClientBase",
        "_TtC12SimulatorKit22SimDeviceHIDIOSurface",
        "_TtC12SimulatorKit13SimHIDSession",
        "SimDigitizerInputView",
        "SimDisplayManager",
        "SimDisplayDescriptor",
    ]

    var matched = 0
    for name in knownNames {
        guard let cls = NSClassFromString(name) else {
            fputs("  ⚠️  \\(name) — not found (class not registered)\\n", stderr)
            continue
        }
        matched += 1

        fputs("\\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n", stderr)
        fputs("CLASS: \\(name)\\n", stderr)
        if let superCls = class_getSuperclass(cls) {
            fputs("  Superclass: \\(String(cString: class_getName(superCls)))\\n", stderr)
        }

        let instMethods = methodNames(of: cls)
        if !instMethods.isEmpty {
            fputs("  Instance methods (\\(instMethods.count)):\\n", stderr)
            instMethods.sorted().forEach { fputs("    - \\($0)\\n", stderr) }
        }

        let clsMethods = classMethodNames(of: cls)
        if !clsMethods.isEmpty {
            fputs("  Class methods (\\(clsMethods.count)):\\n", stderr)
            clsMethods.sorted().forEach { fputs("    + \\($0)\\n", stderr) }
        }
    }

    fputs("\\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n", stderr)
    fputs("Found \\(matched)/\\(knownNames.count) targeted class(es).\\n", stderr)
    fputs("\\n", stderr)
    fputs("ℹ️  Note: Full objc_copyClassList enumeration (~60 k classes) hangs\\n", stderr)
    fputs("   due to Swift runtime realization. Use NSClassFromString for any\\n", stderr)
    fputs("   additional classes you want to inspect.\\n", stderr)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - CoreSimulator device lookup
// ──────────────────────────────────────────────────────────────────────────────

/// Locate a SimDevice by UDID using SimServiceContext → defaultDeviceSet → devices.
///
/// Returns the SimDevice as an \`AnyObject\` (opaque ObjC class instance), or nil
/// if the device cannot be found. Diagnostic output is printed throughout.
func findSimDevice(udid: String) -> AnyObject? {
    // ── 1. Get SimServiceContext shared instance ──────────────────────────────
    guard let ctxClass = NSClassFromString("SimServiceContext") else {
        fputs("❌ SimServiceContext class not found — CoreSimulator not loaded?\\n", stderr)
        return nil
    }
    fputs("🔍 Found SimServiceContext class: \\(ctxClass)\\n", stderr)

    // +sharedServiceContextForDeveloperDir:error:
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"
    fputs("🔍 Using DEVELOPER_DIR: \\(developerDir)\\n", stderr)

    let sharedCtxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard let sharedCtxMethod = class_getClassMethod(ctxClass, sharedCtxSel) else {
        fputs("❌ SimServiceContext does not have sharedServiceContextForDeveloperDir:error:\\n", stderr)
        let altMethods = classMethodNames(of: ctxClass)
        fputs("  Available class methods: \\(altMethods.joined(separator: ", "))\\n", stderr)
        return nil
    }

    // IMP: +[SimServiceContext sharedServiceContextForDeveloperDir:error:]
    // -> SimServiceContext?
    typealias SharedContextFn = @convention(c) (
        AnyClass,
        Selector,
        NSString,
        AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let sharedContextImpl = unsafeBitCast(
        method_getImplementation(sharedCtxMethod),
        to: SharedContextFn.self
    )
    var contextError: NSError? = nil
    guard let serviceContext = sharedContextImpl(
        ctxClass,
        sharedCtxSel,
        developerDir as NSString,
        &contextError
    ) else {
        fputs("❌ sharedServiceContextForDeveloperDir: returned nil", stderr)
        if let err = contextError {
            fputs(" — \\(err.localizedDescription)\\n", stderr)
        } else {
            fputs("\\n", stderr)
        }
        return nil
    }
    fputs("✅ Got SimServiceContext: \\(serviceContext)\\n", stderr)

    // ── 2. Get defaultDeviceSet ───────────────────────────────────────────────
    let defaultSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
    let serviceContextClass: AnyClass = type(of: serviceContext)
    guard let defaultSetMethod = class_getInstanceMethod(serviceContextClass, defaultSetSel) else {
        fputs("❌ SimServiceContext does not respond to defaultDeviceSetWithError:\\n", stderr)
        let instMethods = methodNames(of: serviceContextClass)
        fputs("  Available instance methods (first 30): \\(instMethods.prefix(30).joined(separator: ", "))\\n", stderr)
        return nil
    }

    typealias DefaultSetFn = @convention(c) (
        AnyObject,
        Selector,
        AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let defaultSetImpl = unsafeBitCast(
        method_getImplementation(defaultSetMethod),
        to: DefaultSetFn.self
    )
    var setError: NSError? = nil
    guard let deviceSet = defaultSetImpl(serviceContext, defaultSetSel, &setError) else {
        fputs("❌ defaultDeviceSetWithError: returned nil", stderr)
        if let err = setError {
            fputs(" — \\(err.localizedDescription)\\n", stderr)
        } else {
            fputs("\\n", stderr)
        }
        return nil
    }
    fputs("✅ Got SimDeviceSet: \\(deviceSet)\\n", stderr)

    // ── 3. Get devices dictionary via devicesByUDID (keyed by NSUUID) ────────────
    //
    // IMPORTANT: The keys in this dictionary are NSUUID objects, NOT NSString.
    // Searching by string equality silently misses every entry.
    // We must construct an NSUUID from the caller's udid string and use it
    // as the dictionary key directly.
    let byUDIDSel = NSSelectorFromString("devicesByUDID")
    guard let devicesObj = objcCall(deviceSet, sel: byUDIDSel) else {
        fputs("❌ SimDeviceSet.devicesByUDID returned nil\\n", stderr)
        return nil
    }

    guard let devicesDict = devicesObj as? NSDictionary else {
        fputs("❌ Could not cast devicesByUDID result to NSDictionary; type=\\(type(of: devicesObj))\\n", stderr)
        return nil
    }
    fputs("  devicesByUDID count: \\(devicesDict.count)\\n", stderr)

    // Build an NSUUID key from the provided UDID string.
    guard let swiftUUID = UUID(uuidString: udid) else {
        fputs("❌ '\\(udid)' is not a valid UUID string.\\n", stderr)
        return nil
    }
    let nsUUID = swiftUUID as NSUUID

    if let found = devicesDict[nsUUID] {
        let device = found as AnyObject
        fputs("✅ Found SimDevice for UDID \\(udid): \\(device)\\n", stderr)
        return device
    }

    fputs("❌ Device with UDID \\(udid) not found in devicesByUDID.\\n", stderr)
    let availableUDIDs = devicesDict.allKeys.map { String(describing: $0) }.joined(separator: "\\n    ")
    fputs("  Available UDIDs:\\n    \\(availableUDIDs)\\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - SimDeviceLegacyHIDClient creation
// ──────────────────────────────────────────────────────────────────────────────

/// Create a SimDeviceLegacyHIDClient for the given SimDevice.
///
/// SimDeviceLegacyHIDClient is a Swift class in SimulatorKit.
/// Its ObjC-visible name is \`_TtC12SimulatorKit24SimDeviceLegacyHIDClient\`.
/// Initializer: init(device: SimDevice) throws
///
/// Returns the HID client as AnyObject, or nil on failure.
func createHIDClient(for device: AnyObject) -> AnyObject? {
    // The Swift-mangled ObjC class name for SimDeviceLegacyHIDClient.
    // Swift classes get an ObjC name of the form _TtC<module-len><module><class-len><class>.
    let possibleNames = [
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient",
        "SimDeviceLegacyHIDClient",
    ]

    var hidClientClass: AnyClass? = nil
    for name in possibleNames {
        if let cls = NSClassFromString(name) {
            hidClientClass = cls
            fputs("✅ Found SimDeviceLegacyHIDClient class as: \\(name)\\n", stderr)
            break
        }
    }

    guard let cls = hidClientClass else {
        fputs("❌ SimDeviceLegacyHIDClient class not found.\\n", stderr)
        fputs("   Tried: \\(possibleNames.joined(separator: ", "))\\n", stderr)
        return nil
    }

    let instMethods = methodNames(of: cls)
    fputs("  HIDClient instance methods: \\(instMethods.joined(separator: ", "))\\n", stderr)
    let clsMethodsList = classMethodNames(of: cls)
    fputs("  HIDClient class methods: \\(clsMethodsList.joined(separator: ", "))\\n", stderr)

    // ── Allocate via +alloc using IMP ─────────────────────────────────────────
    let allocSel = NSSelectorFromString("alloc")
    guard let allocMethod = class_getClassMethod(cls, allocSel) else {
        fputs("❌ Cannot find +alloc on SimDeviceLegacyHIDClient\\n", stderr)
        return nil
    }
    typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
    let allocImpl = unsafeBitCast(method_getImplementation(allocMethod), to: AllocFn.self)
    let alloc: AnyObject = allocImpl(cls, allocSel)
    fputs("  Allocated instance: \\(alloc)\\n", stderr)

    // ── Try -initWithDevice:error: ────────────────────────────────────────────
    let initErrSel = NSSelectorFromString("initWithDevice:error:")
    if let initMethod = class_getInstanceMethod(cls, initErrSel) {
        typealias InitErrFn = @convention(c) (
            AnyObject,
            Selector,
            AnyObject,
            AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> AnyObject?
        let initImpl = unsafeBitCast(method_getImplementation(initMethod), to: InitErrFn.self)
        var initError: NSError? = nil
        let client = initImpl(alloc, initErrSel, device, &initError)
        if let err = initError {
            fputs("❌ SimDeviceLegacyHIDClient initWithDevice:error: error: \\(err.localizedDescription)\\n", stderr)
            return nil
        }
        if let c = client {
            fputs("✅ Created SimDeviceLegacyHIDClient: \\(c)\\n", stderr)
            return c
        }
        fputs("⚠️  initWithDevice:error: returned nil (no error)\\n", stderr)
    }

    // ── Try -initWithDevice: (no error) ──────────────────────────────────────
    let initSimpleSel = NSSelectorFromString("initWithDevice:")
    if let initSimpleMethod = class_getInstanceMethod(cls, initSimpleSel) {
        typealias InitSimpleFn = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        let initSimpleImpl = unsafeBitCast(method_getImplementation(initSimpleMethod), to: InitSimpleFn.self)
        if let c = initSimpleImpl(alloc, initSimpleSel, device) {
            fputs("✅ Created SimDeviceLegacyHIDClient (simple init): \\(c)\\n", stderr)
            return c
        }
        fputs("⚠️  initWithDevice: returned nil\\n", stderr)
    }

    fputs("❌ No usable initializer found on SimDeviceLegacyHIDClient.\\n", stderr)
    fputs("   Known instance selectors: \\(instMethods.joined(separator: ", "))\\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHID touch injection
// ──────────────────────────────────────────────────────────────────────────────

/// ButtonEventType raw values passed to IndigoHIDMessageForMouseNSEvent as x3.
/// These happen to match the NSEventType values for left-mouse down/up (1 and 2).
let kButtonEventTypeDown: UInt = 1
let kButtonEventTypeUp: UInt   = 2

/// IndigoHID target for the pointer/trackpad service (subtype=3).
/// NOT used for touch injection — routes through a broken RelativePointerEvent path.
let kIndigoHIDTargetPointer: UInt = 0x35

/// IndigoHID target for the main iPhone screen touch service.
///
/// TARGET ID DETERMINATION (from SimulatorKit digitizerTarget getter):
///   screenType 0 (main iPhone/iPad): targetID = 0x32 (50)
///   screenType 3/4/5+ (CarPlay, external): targetID = screenID | 0x40000000
///
/// SimulatorHID pre-registers mainScreenTouchService at allServices[@(0x32)]
/// during initWithEventSystem:. No registration message needed — the service
/// exists from boot with a fully-configured event callback via
/// SimHIDMainScreenTouchServiceCallbackProvider.
let kIndigoHIDTargetDigitizer: UInt = 0x32

/// IndigoHID target for hardware button events on iPhone/iPad.
/// From SimDeviceScreen.buttonTarget getter in SimulatorKit.
let kIndigoHIDTargetButton: UInt32 = 0x33

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - USB HID usage codes
// ──────────────────────────────────────────────────────────────────────────────

/// Map browser KeyboardEvent.key names → USB HID Keyboard/Keypad usage codes.
/// Reference: USB HID Usage Tables, Section 10 (Keyboard/Keypad Page 0x07).
let kUSBHIDUsageCodes: [String: UInt32] = [
    // Letters (a-z)
    "a": 0x04, "b": 0x05, "c": 0x06, "d": 0x07, "e": 0x08,
    "f": 0x09, "g": 0x0A, "h": 0x0B, "i": 0x0C, "j": 0x0D,
    "k": 0x0E, "l": 0x0F, "m": 0x10, "n": 0x11, "o": 0x12,
    "p": 0x13, "q": 0x14, "r": 0x15, "s": 0x16, "t": 0x17,
    "u": 0x18, "v": 0x19, "w": 0x1A, "x": 0x1B, "y": 0x1C,
    "z": 0x1D,
    // Uppercase letters (same usage code — modifier handles shift)
    "A": 0x04, "B": 0x05, "C": 0x06, "D": 0x07, "E": 0x08,
    "F": 0x09, "G": 0x0A, "H": 0x0B, "I": 0x0C, "J": 0x0D,
    "K": 0x0E, "L": 0x0F, "M": 0x10, "N": 0x11, "O": 0x12,
    "P": 0x13, "Q": 0x14, "R": 0x15, "S": 0x16, "T": 0x17,
    "U": 0x18, "V": 0x19, "W": 0x1A, "X": 0x1B, "Y": 0x1C,
    "Z": 0x1D,
    // Numbers (0-9)
    "1": 0x1E, "2": 0x1F, "3": 0x20, "4": 0x21, "5": 0x22,
    "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26, "0": 0x27,
    // Special keys
    "Enter": 0x28, "Return": 0x28,
    "Escape": 0x29,
    "Backspace": 0x2A, "Delete": 0x4C,  // Backspace=0x2A, Forward Delete=0x4C
    "Tab": 0x2B,
    " ": 0x2C,  // Space
    // Punctuation
    "-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30,
    "\\\\": 0x31, ";": 0x33, "'": 0x34, "\`": 0x35,
    ",": 0x36, ".": 0x37, "/": 0x38,
    // Arrow keys
    "ArrowRight": 0x4F, "ArrowLeft": 0x50,
    "ArrowDown": 0x51, "ArrowUp": 0x52,
    // Function keys
    "Home": 0x4A, "End": 0x4D,
    "PageUp": 0x4B, "PageDown": 0x4E,
]

/// Attempt to inject a single tap (down + up) at the given normalised coordinates
/// using IndigoHIDMessageForMouseNSEvent and SimDeviceLegacyHIDClient.send(message:).
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance (AnyObject).
///   - normX:     Normalised X coordinate (0.0 = left, 1.0 = right).
///   - normY:     Normalised Y coordinate (0.0 = top,  1.0 = bottom).
/// - Returns: nil on success, or an error message string on failure.
func injectTap(hidClient: AnyObject, normX: Double, normY: Double) -> String? {
    // ── 1. Resolve IndigoHIDMessageForMouseNSEvent via dlsym ─────────────────
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not currently loaded — cannot dlsym\\n", stderr)
        return "SimulatorKit not currently loaded"
    }
    defer { dlclose(simKitHandle) }

    guard let rawIndigoPtr = dlsym(simKitHandle, "IndigoHIDMessageForMouseNSEvent") else {
        fputs("❌ dlsym(IndigoHIDMessageForMouseNSEvent) failed: \\(String(cString: dlerror()))\\n", stderr)
        return "dlsym(IndigoHIDMessageForMouseNSEvent) failed"
    }
    let indigoFn = unsafeBitCast(rawIndigoPtr, to: IndigoHIDMessageForMouseNSEventFn.self)

    // ── 2. Resolve the correct send selector on the HIDClient ────────────────
    //
    // The correct ObjC-bridged selector (confirmed via disassembly / test_hid6)
    // is \`sendWithMessage:freeWhenDone:completionQueue:completion:\`.
    // Earlier guesses ("sendMessage:", "send:", "sendWithMessage:") are all wrong.
    let clientClass: AnyClass = type(of: hidClient)
    let instMethods = methodNames(of: clientClass)

    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to \\(sendSelName)\\n", stderr)
        fputs("   Available methods: \\(instMethods.joined(separator: ", "))\\n", stderr)
        return "HIDClient does not respond to \\(sendSelName)"
    }

    // ── 3. No registration needed ──────────────────────────────────────────────
    //
    // SimulatorHID pre-registers the main screen touch service at
    // allServices[@(0x32)] during initWithEventSystem:. Sending registration
    // messages (CreatePointerService, CreateMouseService, CreateDigitizerService)
    // is unnecessary and could interfere with the pre-existing properly-configured
    // services. The pointer (0x35) and mouse (0x36) registrations are also
    // skipped as they are not needed for touch injection.

    // ── 4. Send touch-down ─────────────────────────────────────────────────────
    sendTouchEventViaObjC(
        hidClient: hidClient,
        sendSel: sendSel,
        sendMethod: sendMethod,
        indigoFn: indigoFn,
        x: normX, y: normY,
        eventType: kButtonEventTypeDown
    )

    Thread.sleep(forTimeInterval: 0.05)

    // ── 5. Send touch-up ───────────────────────────────────────────────────────
    sendTouchEventViaObjC(
        hidClient: hidClient,
        sendSel: sendSel,
        sendMethod: sendMethod,
        indigoFn: indigoFn,
        x: normX, y: normY,
        eventType: kButtonEventTypeUp
    )
    fputs("✅ Tap injection complete.\\n", stderr)
    return nil
}

/// Send an IndigoHID registration message to register a HID service in the
/// simulator's backboardd process.  Without this, \`serviceForIndigoHIDData:\`
/// cannot find any service for the target and crashes with SIGABRT.
///
/// Registration message wire format (from reverse-engineering SimulatorKit):
///   +0x18 (u32)   = element_data_size = 0xa0
///   +0x1c (u8)    = flag = 0x01
///   +0x20 (u32)   = message type = 0x7fff0001 (registration)
///   +0x30 (u32)   = subtype (3=CreatePointer, 5=CreateMouse, 1=CreateDigitizer)
///   +0x40 (u32)   = targetID
///   Total size: 0xc0 (192 bytes)
///
/// - Parameters:
///   - hidClient:  The SimDeviceLegacyHIDClient instance.
///   - sendSel:    The resolved send selector.
///   - sendMethod: The Method for the send selector.
///   - subtype:    Registration subtype (3=CreatePointer, 5=CreateMouse).
///   - targetID:   The HID target identifier to register (e.g. 0x35 for pointer).
private func sendRegistrationMessage(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    subtype: UInt32,
    targetID: UInt32
) {
    let buf = calloc(1, 0xc0)!

    // Write fields at their exact byte offsets
    buf.storeBytes(of: UInt32(0xa0),       toByteOffset: 0x18, as: UInt32.self)  // element_data_size
    buf.storeBytes(of: UInt8(0x01),        toByteOffset: 0x1c, as: UInt8.self)   // flag
    buf.storeBytes(of: UInt32(0x7fff0001), toByteOffset: 0x20, as: UInt32.self)  // message type = registration
    buf.storeBytes(of: subtype,            toByteOffset: 0x30, as: UInt32.self)  // subtype
    buf.storeBytes(of: targetID,           toByteOffset: 0x40, as: UInt32.self)  // targetID

    typealias SendFn = @convention(c) (
        AnyObject,               // self
        Selector,                // _cmd
        UnsafeMutableRawPointer, // message
        Bool,                    // freeWhenDone
        AnyObject?,              // completionQueue
        AnyObject?               // completion
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, buf, true, nil, nil)
    // freeWhenDone:true — framework takes ownership
}

/// Send an IndigoHID digitizer registration message (subtype=1) to register
/// the screen touch digitizer service in backboardd's allServices dictionary.
///
/// Wire format (confirmed from SimulatorHID block_invoke disassembly):
///   +0x18 (u32)       = element_data_size = 0xa0
///   +0x1c (u8)        = flag = 0x01
///   +0x20 (u32)       = message type = 0x7fff0001 (registration)
///   +0x30 (u32)       = subtype = 1 (createDigitizer)
///   +0x40 (u32)       = targetID (must have bit 30 set, e.g. 0x40000000)
///   +0x44 (c-string)  = displayUID, null-terminated UTF-8, max 63 chars
///                       = "PurpleMain" for the main iPhone screen
///   Total size: 0xc0 (192 bytes)
private func sendDigitizerRegistrationMessage(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    targetID: UInt32,
    displayUID: String
) {
    let buf = calloc(1, 0xc0)!

    buf.storeBytes(of: UInt32(0xa0),       toByteOffset: 0x18, as: UInt32.self)
    buf.storeBytes(of: UInt8(0x01),        toByteOffset: 0x1c, as: UInt8.self)
    buf.storeBytes(of: UInt32(0x7fff0001), toByteOffset: 0x20, as: UInt32.self)
    buf.storeBytes(of: UInt32(1),          toByteOffset: 0x30, as: UInt32.self)  // subtype = CreateDigitizer
    buf.storeBytes(of: targetID,           toByteOffset: 0x40, as: UInt32.self)

    // Write displayUID as null-terminated UTF-8 at offset 0x44, max 63 chars
    let uidBytes = Array(displayUID.utf8.prefix(63))
    for (i, byte) in uidBytes.enumerated() {
        buf.storeBytes(of: byte, toByteOffset: 0x44 + i, as: UInt8.self)
    }
    // null terminator already present from calloc zeroing

    typealias SendFn = @convention(c) (
        AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, buf, true, nil, nil)
}

/// Normalised (x, y) coordinate pair passed as x0 to IndigoHIDMessageForMouseNSEvent.
///
/// The first argument of IndigoHIDMessageForMouseNSEvent is a pointer to this struct
/// (NOT nil as originally assumed). Passing nil causes a SIGSEGV.
struct TouchCoords {
    var x: Double
    var y: Double
}

/// Build one IndigoHID message and dispatch it via the HIDClient.
///
/// - Parameters:
///   - hidClient:   The \`SimDeviceLegacyHIDClient\` instance.
///   - sendSel:     The resolved \`sendWithMessage:freeWhenDone:completionQueue:completion:\` selector.
///   - sendMethod:  The \`Method\` for that selector (already looked up by the caller).
///   - indigoFn:    Resolved \`IndigoHIDMessageForMouseNSEvent\` function pointer.
///   - x:           Normalised x coordinate (0–1).
///   - y:           Normalised y coordinate (0–1).
///   - eventType:   ButtonEventType raw value (1 = down, 2 = up).
private func sendTouchEventViaObjC(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    indigoFn: IndigoHIDMessageForMouseNSEventFn,
    x: Double, y: Double,
    eventType: UInt
) {
    // Build the coords struct on the stack and pass a pointer to it as x0 (point0).
    // x1 (point1) = nil  — single touch, no secondary point.
    // x2 (target) = 0x40000000 — digitizer touch screen target (bit 30 set).
    // x3 (eventType) = 1 (down) or 2 (up).
    // d0/d1 (size) = 1.0, 1.0 — scale divisors (normalised coords need no scaling).
    // x4 (edge) = 0 — no edge flags.
    var coords = TouchCoords(x: x, y: y)
    let msgPtr = withUnsafeMutablePointer(to: &coords) { coordsPtr in
        indigoFn(coordsPtr, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0)
    }

    guard let msg = msgPtr else {
        fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil (eventType=\\(eventType))\\n", stderr)
        return
    }
    // PATCH: IndigoHIDMessageForMouseNSEvent hardcodes phase=2 (kIOHIDPhaseChanged)
    // at buf+0x74 for ALL event types.  The touch state machine requires:
    //   Began(1) → Changed(2)* → Ended(4)
    // Without this patch, events are silently dropped (no preceding Began).
    let correctPhase: UInt32
    switch eventType {
    case kButtonEventTypeDown: correctPhase = 1  // kIOHIDPhaseBegan
    case kButtonEventTypeUp:   correctPhase = 4  // kIOHIDPhaseEnded
    default:                   correctPhase = 2  // kIOHIDPhaseChanged
    }
    msg.storeBytes(of: correctPhase, toByteOffset: 0x74, as: UInt32.self)
    // NOTE: freeWhenDone is passed as \`false\` to the send call below, so the
    // framework keeps ownership of the message buffer — do NOT free(msg) here.

    // IMP for sendWithMessage:freeWhenDone:completionQueue:completion:
    // Parameters (after self + _cmd):
    //   message        (UnsafeMutableRawPointer)
    //   freeWhenDone   (Bool / ObjC BOOL)
    //   completionQueue (DispatchQueue? bridged as AnyObject?)
    //   completion      (block / AnyObject?)
    typealias SendFn = @convention(c) (
        AnyObject,              // self
        Selector,               // _cmd
        UnsafeMutableRawPointer, // message
        Bool,                   // freeWhenDone
        AnyObject?,             // completionQueue
        AnyObject?              // completion
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, msg, false, DispatchQueue.global(qos: .utility) as AnyObject, nil)
}

/// Fallback: find and call the Swift dispatch thunk for
/// SimDeviceLegacyHIDClient.send(message:) directly via dlsym of the
/// Swift-mangled symbol.
///
/// The Swift mangled name is:
///   $s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tFTj
/// (dispatch thunk of SimulatorKit.SimDeviceLegacyHIDClient.send(message:))
private func attemptSwiftDirectCall(
    hidClient: AnyObject,
    indigoFn: IndigoHIDMessageForMouseNSEventFn,
    normX: Double,
    normY: Double
) {
    let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD)
    defer { if let h = simKitHandle { dlclose(h) } }

    // Mangle: SimulatorKit.SimDeviceLegacyHIDClient.send(message:) dispatch thunk
    let mangledName = "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tFTj"
    guard let fnPtr = dlsym(simKitHandle, mangledName) else {
        fputs("❌ dlsym for Swift mangled send(message:) failed: \\(String(cString: dlerror()))\\n", stderr)
        fputs("   Mangled name attempted: \\(mangledName)\\n", stderr)
        return
    }
    fputs("✅ Found Swift send(message:) dispatch thunk at \\(fnPtr)\\n", stderr)

    // The Swift dispatch thunk has the following calling convention:
    // arg0 (x0) = UnsafeMutablePointer<IndigoHIDMessageStruct>
    // self (x20) = SimDeviceLegacyHIDClient (Swift self register, arm64e ABI)
    //
    // Since we can't pass Swift's \`self\` register from C calling convention,
    // we use a workaround: call the underlying implementation directly.
    // Try the non-thunk symbol first:
    let implMangledName = "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tF"
    let implFnPtr = dlsym(simKitHandle, implMangledName) ?? fnPtr
    fputs("  Using impl at \\(implFnPtr)\\n", stderr)

    let events: [(UInt, String)] = [
        (kButtonEventTypeDown, "touch-down"),
        (kButtonEventTypeUp,   "touch-up"),
    ]

    for (eventType, label) in events {
        if label == "touch-up" { Thread.sleep(forTimeInterval: 0.05) }

        guard let msgPtr = indigoFn(nil, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0) else {
            fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil for \\(label)\\n", stderr)
            continue
        }
        defer { free(msgPtr) }
        fputs("📤 Swift direct: \\(label) at (\\(normX), \\(normY))…\\n", stderr)

        // Attempt: cast the thunk to a C function that takes (message_ptr, self).
        // NOTE: This may crash if the ABI assumption is wrong; it's a best-effort.
        // On arm64e, Swift methods use x20 for self, but many thunks accept
        // self as an extra trailing argument — behaviour depends on exact thunk.
        typealias SwiftSendFn = @convention(c) (UnsafeMutableRawPointer, AnyObject) -> Void
        let sendFn = unsafeBitCast(implFnPtr, to: SwiftSendFn.self)
        sendFn(msgPtr, hidClient)
        fputs("   Swift direct send called for \\(label).\\n", stderr)
    }
    fputs("✅ Swift direct call tap injection attempt complete.\\n", stderr)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Keyboard injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a keyboard event (key down + key up) for a single key.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - keyName:   Key name (e.g. "a", "Enter", "Backspace", "ArrowUp").
/// - Returns: nil on success, or an error message string on failure.
func injectKeyEvent(hidClient: AnyObject, keyName: String) -> String? {
    guard let usageCode = kUSBHIDUsageCodes[keyName] else {
        fputs("❌ Unknown key name: \\"\\(keyName)\\" — not in USB HID usage table\\n", stderr)
        return "Unknown key name: \\(keyName)"
    }

    // Resolve function
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\\n", stderr)
        return "SimulatorKit not loaded"
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForKeyboardArbitrary") else {
        fputs("❌ dlsym(IndigoHIDMessageForKeyboardArbitrary) failed\\n", stderr)
        return "dlsym(IndigoHIDMessageForKeyboardArbitrary) failed"
    }
    let keyFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForKeyboardArbitraryFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\\n", stderr)
        return "HIDClient does not respond to send selector"
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    // Key down
    guard let msgDown = keyFn(usageCode, 1) else {
        fputs("❌ IndigoHIDMessageForKeyboardArbitrary returned nil for key down\\n", stderr)
        return "IndigoHIDMessageForKeyboardArbitrary returned nil for key down"
    }
    sendFn(hidClient, sendSel, msgDown, false, nil, nil)

    Thread.sleep(forTimeInterval: 0.02)

    // Key up
    guard let msgUp = keyFn(usageCode, 2) else {
        fputs("❌ IndigoHIDMessageForKeyboardArbitrary returned nil for key up\\n", stderr)
        return "IndigoHIDMessageForKeyboardArbitrary returned nil for key up"
    }
    sendFn(hidClient, sendSel, msgUp, false, nil, nil)

    fputs("✅ Key event sent: \\"\\(keyName)\\" (USB HID 0x\\(String(usageCode, radix: 16)))\\n", stderr)
    return nil
}

/// Inject a text string as a series of key events.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - text:      The text to type.
/// - Returns: nil on success, or an error message string on failure.
func injectTextInput(hidClient: AnyObject, text: String) -> String? {
    // Resolve function
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\\n", stderr)
        return "SimulatorKit not loaded"
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForKeyboardArbitrary") else {
        fputs("❌ dlsym(IndigoHIDMessageForKeyboardArbitrary) failed\\n", stderr)
        return "dlsym(IndigoHIDMessageForKeyboardArbitrary) failed"
    }
    let keyFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForKeyboardArbitraryFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\\n", stderr)
        return "HIDClient does not respond to send selector"
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    for char in text {
        let charStr = String(char)
        guard let usageCode = kUSBHIDUsageCodes[charStr] else {
            fputs("⚠️  Skipping unsupported character: \\"\\(charStr)\\"\\n", stderr)
            continue
        }

        // Key down
        if let msgDown = keyFn(usageCode, 1) {
            sendFn(hidClient, sendSel, msgDown, false, nil, nil)
        }

        Thread.sleep(forTimeInterval: 0.01)

        // Key up
        if let msgUp = keyFn(usageCode, 2) {
            sendFn(hidClient, sendSel, msgUp, false, nil, nil)
        }

        Thread.sleep(forTimeInterval: 0.01)
    }

    fputs("✅ Text input sent: \\"\\(text.prefix(50))\\(text.count > 50 ? "…" : "")\\" (\\(text.count) chars)\\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Swipe injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a swipe gesture from one normalised coordinate to another.
///
/// Uses a Began → Changed* → Ended phase sequence with interpolated coordinates.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - fromX, fromY: Start coordinates (normalised 0.0–1.0).
///   - toX, toY:     End coordinates (normalised 0.0–1.0).
///   - steps:        Number of intermediate move events (default 10).
///   - durationMs:   Total swipe duration in milliseconds (default 300).
/// - Returns: nil on success, or an error message string on failure.
func injectSwipe(
    hidClient: AnyObject,
    fromX: Double, fromY: Double,
    toX: Double, toY: Double,
    steps: Int = 10,
    durationMs: Int = 300
) -> String? {
    // Resolve IndigoHIDMessageForMouseNSEvent
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\\n", stderr)
        return "SimulatorKit not loaded"
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForMouseNSEvent") else {
        fputs("❌ dlsym(IndigoHIDMessageForMouseNSEvent) failed\\n", stderr)
        return "dlsym(IndigoHIDMessageForMouseNSEvent) failed"
    }
    let indigoFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForMouseNSEventFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\\n", stderr)
        return "HIDClient does not respond to send selector"
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    let stepDelay = Double(durationMs) / 1000.0 / Double(steps)

    // Helper to send a single touch event with proper phase patching
    func sendTouch(x: Double, y: Double, eventType: UInt, phase: UInt32) {
        var coords = TouchCoords(x: x, y: y)
        guard let msg = withUnsafeMutablePointer(to: &coords, { ptr in
            indigoFn(ptr, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0)
        }) else {
            fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil\\n", stderr)
            return
        }
        // Patch phase field (same fix as injectTap)
        msg.storeBytes(of: phase, toByteOffset: 0x74, as: UInt32.self)
        sendFn(hidClient, sendSel, msg, false, nil, nil)
    }

    // ── 1. Touch down at start (Began) ──
    sendTouch(x: fromX, y: fromY, eventType: kButtonEventTypeDown, phase: 1)

    // ── 2. Intermediate moves (Changed) ──
    for i in 1...steps {
        Thread.sleep(forTimeInterval: stepDelay)
        let t = Double(i) / Double(steps)
        let x = fromX + (toX - fromX) * t
        let y = fromY + (toY - fromY) * t
        // For move events, use eventType=down (1) with phase=Changed (2)
        sendTouch(x: x, y: y, eventType: kButtonEventTypeDown, phase: 2)
    }

    // ── 3. Touch up at end (Ended) ──
    Thread.sleep(forTimeInterval: 0.01)
    sendTouch(x: toX, y: toY, eventType: kButtonEventTypeUp, phase: 4)

    fputs("✅ Swipe sent: (\\(fromX), \\(fromY)) → (\\(toX), \\(toY)) in \\(steps) steps over \\(durationMs)ms\\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Button injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a hardware button press (down + up).
///
/// Button routing (from Simulator.app / SimulatorKit disassembly):
///   - home, lock → IndigoHIDMessageForButton(code, keyState, target)
///   - volumeUp, volumeDown → IndigoHIDMessageForHIDArbitrary(target, 0x0c, usage, keyState)
///
/// Button codes:
///   home (Face ID)  = 0     (hasHomeButton==false → wzr)
///   home (Touch ID) = 401   (0x191, hasHomeButton==true)
///   lock/power      = 1     (lockButtonPressed: hardcoded)
///   volumeUp        = HID Consumer Control page 0x0c, usage 0xe9
///   volumeDown      = HID Consumer Control page 0x0c, usage 0xea
/// - Returns: nil on success, or an error message string on failure.
func injectButton(hidClient: AnyObject, buttonName: String) -> String? {
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\\n", stderr)
        return "SimulatorKit not loaded"
    }
    defer { dlclose(simKitHandle) }

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\\n", stderr)
        return "HIDClient does not respond to send selector"
    }
    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    // ── Volume buttons use IndigoHIDMessageForHIDArbitrary ──
    if buttonName == "volumeUp" || buttonName == "volumeDown" {
        guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForHIDArbitrary") else {
            fputs("❌ dlsym(IndigoHIDMessageForHIDArbitrary) failed\\n", stderr)
            return "dlsym(IndigoHIDMessageForHIDArbitrary) failed"
        }
        let arbitraryFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForHIDArbitraryFn.self)

        let kConsumerControlPage: UInt32 = 0x0c
        let usageCode: UInt32 = (buttonName == "volumeUp") ? 0xe9 : 0xea

        // Button down
        guard let msgDown = arbitraryFn(kIndigoHIDTargetButton, kConsumerControlPage, usageCode, 1) else {
            fputs("❌ IndigoHIDMessageForHIDArbitrary returned nil (down)\\n", stderr)
            return "IndigoHIDMessageForHIDArbitrary returned nil (down)"
        }
        sendFn(hidClient, sendSel, msgDown, false, nil, nil)
        Thread.sleep(forTimeInterval: 0.05)

        // Button up
        guard let msgUp = arbitraryFn(kIndigoHIDTargetButton, kConsumerControlPage, usageCode, 2) else {
            fputs("❌ IndigoHIDMessageForHIDArbitrary returned nil (up)\\n", stderr)
            return "IndigoHIDMessageForHIDArbitrary returned nil (up)"
        }
        sendFn(hidClient, sendSel, msgUp, false, nil, nil)

        fputs("✅ Volume button: \\"\\(buttonName)\\" (page=0x0c, usage=0x\\(String(usageCode, radix: 16)))\\n", stderr)
        return nil
    }

    // ── All other buttons use IndigoHIDMessageForButton ──
    // Button code mapping (from Simulator.app disassembly):
    //   home: Face ID = 0, Touch ID = 401 (0x191)
    //   lock: 1
    // For now we default to Face ID (code=0) since iPhone 17 Pro is our test device.
    // TODO: Query device.hasHomeButton via ObjC runtime to auto-detect.
    let buttonCodes: [String: UInt32] = [
        "home": 0,      // Face ID home (goes to home screen)
        "lock": 1,      // Lock/Power/Side button
    ]

    guard let buttonCode = buttonCodes[buttonName] else {
        fputs("❌ Unknown button: \\"\\(buttonName)\\". Valid: home, lock, volumeUp, volumeDown\\n", stderr)
        return "Unknown button: \\(buttonName). Valid: home, lock, volumeUp, volumeDown"
    }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForButton") else {
        fputs("❌ dlsym(IndigoHIDMessageForButton) failed\\n", stderr)
        return "dlsym(IndigoHIDMessageForButton) failed"
    }
    let buttonFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForButtonFn.self)

    // Button down
    guard let msgDown = buttonFn(buttonCode, 1, kIndigoHIDTargetButton) else {
        fputs("❌ IndigoHIDMessageForButton returned nil (down)\\n", stderr)
        return "IndigoHIDMessageForButton returned nil (down)"
    }
    sendFn(hidClient, sendSel, msgDown, false, nil, nil)
    Thread.sleep(forTimeInterval: 0.05)

    // Button up
    guard let msgUp = buttonFn(buttonCode, 2, kIndigoHIDTargetButton) else {
        fputs("❌ IndigoHIDMessageForButton returned nil (up)\\n", stderr)
        return "IndigoHIDMessageForButton returned nil (up)"
    }
    sendFn(hidClient, sendSel, msgUp, false, nil, nil)

    fputs("✅ Button pressed: \\"\\(buttonName)\\" (code=\\(buttonCode), target=0x\\(String(kIndigoHIDTargetButton, radix: 16)))\\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Main entry point
// ──────────────────────────────────────────────────────────────────────────────

func printUsage() -> Never {
    fputs("""
    Usage:
      wms-indigo-poc --discover
          List SimulatorKit/CoreSimulator ObjC classes and their methods.

      wms-indigo-poc <udid>
          Daemon mode: read newline-delimited JSON commands from stdin,
          write JSON responses to stdout.

      wms-indigo-poc <udid> tap <normX> <normY>
          Inject a tap at normalised coordinates (0.0–1.0).

      wms-indigo-poc <udid> swipe <x1> <y1> <x2> <y2> [steps] [durationMs]
          Inject a swipe gesture between normalised coordinates.
          Default: 10 steps, 300ms duration.

      wms-indigo-poc <udid> key <keyName>
          Inject a single key press (down + up).
          Key names: a-z, 0-9, Enter, Backspace, Delete, Tab, Escape,
                     ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, etc.

      wms-indigo-poc <udid> type <text>
          Type a text string as a series of key events.

      wms-indigo-poc <udid> button <buttonName>
          Press a hardware button: home, lock, volumeUp, volumeDown.

    Examples:
      wms-indigo-poc --discover
      wms-indigo-poc ABCD-1234
      wms-indigo-poc ABCD-1234 tap 0.5 0.5
      wms-indigo-poc ABCD-1234 swipe 0.5 0.8 0.5 0.2
      wms-indigo-poc ABCD-1234 key Enter
      wms-indigo-poc ABCD-1234 type "hello world"
      wms-indigo-poc ABCD-1234 button home

    """, stderr)
    exit(1)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Daemon mode helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Serialise a dictionary to a JSON line and write it to stdout (the daemon protocol channel).
/// Uses JSONSerialization so all values are properly encoded — no hand-rolled escaping.
func writeJSONResponse(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          var jsonStr = String(data: data, encoding: .utf8) else {
        fputs("[daemon] Failed to serialize JSON response\\n", stderr)
        return
    }
    jsonStr += "\\n"
    FileHandle.standardOutput.write(jsonStr.data(using: .utf8)!)
}

/// Parse and dispatch a single JSON command line received from the daemon's stdin.
///
/// - Parameters:
///   - line:      A single UTF-8 line (without the trailing newline).
///   - hidClient: The ready SimDeviceLegacyHIDClient instance.
func processCommand(_ line: String, hidClient: AnyObject) {
    guard let lineData = line.data(using: .utf8) else { return }

    // Parse JSON
    guard let jsonObj = try? JSONSerialization.jsonObject(with: lineData),
          let dict = jsonObj as? [String: Any] else {
        fputs("[daemon] Could not parse JSON line: \\(line)\\n", stderr)
        return
    }

    let reqId = (dict["id"] as? String) ?? ""
    guard let cmd = dict["cmd"] as? String else {
        writeJSONResponse(["id": reqId, "ok": false, "error": "Missing 'cmd' field"])
        return
    }

    fputs("[daemon] cmd=\\(cmd) id=\\(reqId)\\n", stderr)

    // Dispatch — each injection function returns nil on success or an error string.
    var errorMsg: String? = nil

    switch cmd {
    case "tap":
        guard let x = dict["x"] as? Double, let y = dict["y"] as? Double else {
            errorMsg = "tap requires numeric x and y"
            break
        }
        if let err = injectTap(hidClient: hidClient, normX: x, normY: y) {
            errorMsg = err
        }

    case "swipe":
        guard let x1 = dict["x1"] as? Double, let y1 = dict["y1"] as? Double,
              let x2 = dict["x2"] as? Double, let y2 = dict["y2"] as? Double else {
            errorMsg = "swipe requires numeric x1, y1, x2, y2"
            break
        }
        // Clamp steps and durationMs to ≥1 to avoid divide-by-zero in injectSwipe.
        let steps = max(1, (dict["steps"] as? Int) ?? 10)
        let durationMs = max(1, (dict["durationMs"] as? Int) ?? 300)
        if let err = injectSwipe(hidClient: hidClient, fromX: x1, fromY: y1, toX: x2, toY: y2,
                                 steps: steps, durationMs: durationMs) {
            errorMsg = err
        }

    case "key":
        guard let name = dict["name"] as? String else {
            errorMsg = "key requires string name"
            break
        }
        if let err = injectKeyEvent(hidClient: hidClient, keyName: name) {
            errorMsg = err
        }

    case "type":
        guard let text = dict["text"] as? String else {
            errorMsg = "type requires string text"
            break
        }
        if let err = injectTextInput(hidClient: hidClient, text: text) {
            errorMsg = err
        }

    case "button":
        guard let name = dict["name"] as? String else {
            errorMsg = "button requires string name"
            break
        }
        if let err = injectButton(hidClient: hidClient, buttonName: name) {
            errorMsg = err
        }

    default:
        errorMsg = "Unknown cmd: \\(cmd)"
    }

    if let err = errorMsg {
        writeJSONResponse(["id": reqId, "ok": false, "error": err])
    } else {
        writeJSONResponse(["id": reqId, "ok": true])
    }
}

/// Run the stdin read loop (daemon mode).
///
/// Uses \`FileHandle.read(upToCount:)\` which blocks until at least 1 byte
/// arrives or EOF — unlike \`availableData\` which returns empty Data immediately
/// on a pipe with no buffered data, causing a premature daemon exit.
///
/// - Parameters:
///   - hidClient: The ready SimDeviceLegacyHIDClient.
///   - udid:      The device UDID (echoed in the ready signal).
func runDaemonLoop(hidClient: AnyObject, udid: String) {
    // Emit ready signal on stdout
    writeJSONResponse(["ready": true, "udid": udid])
    fputs("[daemon] Ready. Waiting for commands on stdin.\\n", stderr)

    let stdinHandle = FileHandle.standardInput
    var lineBuffer = Data()
    let newline = UInt8(0x0A) // \\n

    while true {
        // read(upToCount:) blocks until at least 1 byte arrives or EOF.
        // On a pipe, this is the correct blocking behavior we need.
        guard let chunk = try? stdinHandle.read(upToCount: 4096), !chunk.isEmpty else {
            fputs("[daemon] stdin EOF — exiting.\\n", stderr)
            exit(0)
        }

        lineBuffer.append(chunk)

        // Process all complete lines in the buffer
        while let newlineIndex = lineBuffer.firstIndex(of: newline) {
            let lineData = lineBuffer[lineBuffer.startIndex..<newlineIndex]
            lineBuffer = Data(lineBuffer[(newlineIndex + 1)...])

            guard let lineStr = String(data: lineData, encoding: .utf8),
                  !lineStr.isEmpty else { continue }

            // Parse and dispatch the JSON command
            processCommand(lineStr, hidClient: hidClient)
        }
    }
}

let args = CommandLine.arguments

guard args.count >= 2 else { printUsage() }

// ── Install signal handlers for clean exit ────────────────────────────────────
signal(SIGTERM) { _ in exit(143) }
signal(SIGINT)  { _ in exit(0) }

// ── Load frameworks first (required before any ObjC introspection) ────────────
fputs("──────────────────────────────────────────────────────────\\n", stderr)
fputs("  WMS IndigoHID POC\\n", stderr)
fputs("──────────────────────────────────────────────────────────\\n", stderr)
loadFramework(kCoreSimulatorPath)
loadFramework(kSimulatorKitPath)
fputs("\\n", stderr)

// ── Dispatch on command ───────────────────────────────────────────────────────
let command = args[1]

if command == "--discover" {
    fputs("🔍 Discovering SimulatorKit and CoreSimulator ObjC classes…\\n\\n", stderr)
    discoverClasses()
} else if args.count == 2 {
    // ── Daemon mode: just UDID, no subcommand ─────────────────────────────────
    let udid = command
    fputs("[daemon] Starting for UDID: \\(udid)\\n", stderr)

    guard let device = findSimDevice(udid: udid) else {
        writeJSONResponse(["ready": false, "error": "Could not locate SimDevice for UDID \\(udid)"])
        exit(1)
    }

    if let nameVal = objcCall(device, sel: NSSelectorFromString("name")),
       let stateVal = objcCall(device, sel: NSSelectorFromString("stateString")) {
        fputs("[daemon] Device: \\(nameVal) (\\(stateVal))\\n", stderr)
    }

    guard let hidClient = createHIDClient(for: device) else {
        writeJSONResponse(["ready": false, "error": "Could not create SimDeviceLegacyHIDClient"])
        exit(1)
    }

    // Dispatch the stdin read/dispatch loop onto a background thread.
    // The main thread MUST run the RunLoop so that XPC/mach-port
    // replies from backboardd can be delivered (SimDeviceLegacyHIDClient
    // uses XPC under the hood).
    DispatchQueue.global(qos: .userInitiated).async {
        runDaemonLoop(hidClient: hidClient, udid: udid)
    }

    // Spin the main RunLoop forever — required for XPC delivery.
    RunLoop.main.run()
} else {
    // All other commands require: <udid> <command> [args...]
    guard args.count >= 3 else { printUsage() }
    let udid = command
    let subcommand = args[2]

    // Find device and create HID client (common for all commands)
    fputs("🎯 Target UDID: \\(udid)\\n\\n", stderr)

    guard let device = findSimDevice(udid: udid) else {
        fputs("❌ Could not locate SimDevice — see diagnostics above.\\n", stderr)
        exit(1)
    }

    if let nameVal = objcCall(device, sel: NSSelectorFromString("name")),
       let stateVal = objcCall(device, sel: NSSelectorFromString("stateString")) {
        fputs("  Device: \\(nameVal) (\\(stateVal))\\n", stderr)
    }
    fputs("\\n", stderr)

    guard let hidClient = createHIDClient(for: device) else {
        fputs("❌ Could not create SimDeviceLegacyHIDClient.\\n", stderr)
        exit(1)
    }
    fputs("\\n", stderr)

    switch subcommand {
    case "tap":
        guard args.count >= 5,
              let normX = Double(args[3]), let normY = Double(args[4]),
              (0.0...1.0).contains(normX), (0.0...1.0).contains(normY) else {
            fputs("Usage: wms-indigo-poc <udid> tap <normX> <normY>\\n", stderr)
            exit(1)
        }
        fputs("🎯 Tap at (\\(normX), \\(normY))\\n", stderr)
        _ = injectTap(hidClient: hidClient, normX: normX, normY: normY)

    case "swipe":
        guard args.count >= 7,
              let x1 = Double(args[3]), let y1 = Double(args[4]),
              let x2 = Double(args[5]), let y2 = Double(args[6]) else {
            fputs("Usage: wms-indigo-poc <udid> swipe <x1> <y1> <x2> <y2> [steps] [durationMs]\\n", stderr)
            exit(1)
        }
        let steps = args.count >= 8 ? (Int(args[7]) ?? 10) : 10
        let durationMs = args.count >= 9 ? (Int(args[8]) ?? 300) : 300
        fputs("🎯 Swipe (\\(x1),\\(y1)) → (\\(x2),\\(y2)) steps=\\(steps) duration=\\(durationMs)ms\\n", stderr)
        _ = injectSwipe(hidClient: hidClient, fromX: x1, fromY: y1, toX: x2, toY: y2, steps: steps, durationMs: durationMs)

    case "key":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> key <keyName>\\n", stderr)
            exit(1)
        }
        let keyName = args[3]
        fputs("🎯 Key: \\"\\(keyName)\\"\\n", stderr)
        _ = injectKeyEvent(hidClient: hidClient, keyName: keyName)

    case "type":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> type <text>\\n", stderr)
            exit(1)
        }
        let text = args[3]
        fputs("🎯 Type: \\"\\(text.prefix(50))\\(text.count > 50 ? "…" : "")\\\"\\n", stderr)
        _ = injectTextInput(hidClient: hidClient, text: text)

    case "button":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> button <home|lock|volumeUp|volumeDown>\\n", stderr)
            exit(1)
        }
        let buttonName = args[3]
        fputs("🎯 Button: \\"\\(buttonName)\\"\\n", stderr)
        _ = injectButton(hidClient: hidClient, buttonName: buttonName)

    default:
        fputs("❌ Unknown command: \\(subcommand)\\n", stderr)
        printUsage()
    }
}
`;

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Wraps Apple's `xcrun simctl` CLI to manage iOS Simulators programmatically.
 *
 * All public methods are `async` and throw descriptive `Error` instances on
 * failure. Export the singleton `iosSimulatorService` rather than constructing
 * instances directly.
 */
export class IOSSimulatorService {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Cached result of the last geometry query. */
  private geometryCache: {
    x: number; y: number; width: number; height: number;
    windowX: number; windowY: number; windowWidth: number; windowHeight: number;
  } | null = null;

  /** Timestamp (ms) when `geometryCache` was last populated. */
  private geometryCacheTime = 0;

  /** In-flight promise for binary compilation (prevents parallel compilations). */
  private ensureInputBinaryPromise: Promise<string> | null = null;

  /** In-flight promise for IndigoHID binary compilation (prevents parallel compilations). */
  private ensureIndigoHIDBinaryPromise: Promise<string> | null = null;

  // -------------------------------------------------------------------------
  // Input binary management
  // -------------------------------------------------------------------------

  /**
   * Ensure the iOS input binary is compiled and ready.
   * Concurrent calls share a single compilation Promise so the binary is
   * compiled at most once per process. Returns the path to the compiled binary.
   */
  private ensureInputBinary(): Promise<string> {
    if (!this.ensureInputBinaryPromise) {
      this.ensureInputBinaryPromise = (async (): Promise<string> => {
        // Check if already compiled with current version
        if (existsSync(INPUT_BINARY_PATH) && existsSync(INPUT_BINARY_VERSION_PATH)) {
          let cachedVersion = '';
          try {
            cachedVersion = readFileSync(INPUT_BINARY_VERSION_PATH, 'utf-8').trim();
          } catch {
            // Unreadable version file — treat as stale, fall through to recompile.
          }
          if (cachedVersion === INPUT_BINARY_VERSION) {
            return INPUT_BINARY_PATH;
          }
        }

        // Delete stale binary before recompiling (M1 fix).
        try { unlinkSync(INPUT_BINARY_PATH); } catch { /* already gone */ }
        try { unlinkSync(INPUT_BINARY_VERSION_PATH); } catch { /* already gone */ }

        log('Compiling iOS input helper binary…');
        writeFileSync(INPUT_SWIFT_TMP_PATH, IOS_INPUT_SWIFT_SOURCE);
        await exec('swiftc', [
          INPUT_SWIFT_TMP_PATH,
          '-o', INPUT_BINARY_PATH,
          '-framework', 'AppKit',
          '-framework', 'CoreGraphics',
          '-O',
        ], { timeout: 60_000 });
        writeFileSync(INPUT_BINARY_VERSION_PATH, INPUT_BINARY_VERSION);
        log('iOS input helper binary compiled successfully.');
        return INPUT_BINARY_PATH;
      })().catch((err: unknown) => {
        // Reset so a subsequent call can retry compilation.
        this.ensureInputBinaryPromise = null;
        throw err;
      });
    }
    return this.ensureInputBinaryPromise;
  }

  /**
   * Ensure the IndigoHID binary is compiled and ready.
   * Uses SimulatorKit's private IndigoHID APIs to inject touch, keyboard,
   * and button events directly to the simulator's backboard — no Simulator.app
   * focus required.
   * Concurrent calls share a single compilation Promise so the binary is
   * compiled at most once per process. Returns the path to the compiled binary.
   */
  private ensureIndigoHIDBinary(): Promise<string> {
    if (!this.ensureIndigoHIDBinaryPromise) {
      this.ensureIndigoHIDBinaryPromise = (async (): Promise<string> => {
        // Check if already compiled with current version
        if (existsSync(INDIGO_BINARY_PATH) && existsSync(INDIGO_BINARY_VERSION_PATH)) {
          let cachedVersion = '';
          try {
            cachedVersion = readFileSync(INDIGO_BINARY_VERSION_PATH, 'utf-8').trim();
          } catch {
            // Unreadable version file — treat as stale, fall through to recompile.
          }
          if (cachedVersion === INDIGO_BINARY_VERSION) {
            return INDIGO_BINARY_PATH;
          }
        }

        // Delete stale binary before recompiling.
        try { unlinkSync(INDIGO_BINARY_PATH); } catch { /* already gone */ }
        try { unlinkSync(INDIGO_BINARY_VERSION_PATH); } catch { /* already gone */ }

        log('Compiling IndigoHID binary…');
        writeFileSync(INDIGO_SWIFT_TMP_PATH, INDIGO_HID_SWIFT_SOURCE);
        await exec('swiftc', [
          INDIGO_SWIFT_TMP_PATH,
          '-o', INDIGO_BINARY_PATH,
          '-framework', 'Foundation',
          '-framework', 'AppKit',
          '-framework', 'CoreGraphics',
          '-O',
          '-whole-module-optimization',
        ], { timeout: 120_000 });
        writeFileSync(INDIGO_BINARY_VERSION_PATH, INDIGO_BINARY_VERSION);
        log('IndigoHID binary compiled successfully.');
        return INDIGO_BINARY_PATH;
      })().catch((err: unknown) => {
        // Reset so a subsequent call can retry compilation.
        this.ensureIndigoHIDBinaryPromise = null;
        throw err;
      });
    }
    return this.ensureIndigoHIDBinaryPromise;
  }

  // -------------------------------------------------------------------------
  // Device types
  // -------------------------------------------------------------------------

  /**
   * List all available iOS device types (iPhone & iPad only).
   * Runs: `xcrun simctl list devicetypes -j`
   *
   * @returns Array of `DeviceType` objects from the shared type library.
   */
  async listDeviceTypes(): Promise<DeviceType[]> {
    log('Listing device types…');
    await this.assertSimctlAvailable();

    const output = await execJSON<Pick<SimctlListOutput, 'devicetypes'>>(
      SIMCTL,
      ['simctl', 'list', 'devicetypes', '-j'],
      XCRUN_EXEC_OPTIONS,
    );

    return output.devicetypes
      .filter((dt) => SUPPORTED_FAMILIES.has(dt.productFamily))
      .map((dt): DeviceType => ({
        id: dt.identifier,
        name: dt.name,
        platform: 'ios',
        modelName: dt.name,
        modelIdentifier: dt.identifier,
      }));
  }

  // -------------------------------------------------------------------------
  // Runtimes
  // -------------------------------------------------------------------------

  /**
   * List all installed iOS runtimes.
   * Runs: `xcrun simctl list runtimes -j`
   *
   * @returns Array of `Runtime` objects filtered to the iOS platform.
   */
  async listRuntimes(): Promise<Runtime[]> {
    log('Listing runtimes…');
    await this.assertSimctlAvailable();

    const output = await execJSON<Pick<SimctlListOutput, 'runtimes'>>(
      SIMCTL,
      ['simctl', 'list', 'runtimes', '-j'],
      XCRUN_EXEC_OPTIONS,
    );

    return output.runtimes
      .filter((rt) => rt.platform === 'iOS')
      .map((rt): Runtime => ({
        id: rt.identifier,
        platform: 'ios',
        version: rt.name,           // e.g. "iOS 17.5"
        identifier: rt.identifier,
        status: rt.isAvailable ? 'installed' : 'error',
      }));
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /**
   * List all iOS simulator devices across all runtimes.
   * Runs: `xcrun simctl list devices -j`
   *
   * The simctl JSON nests devices under runtime-identifier keys; this method
   * flattens that structure and resolves `DeviceType` / `Runtime` references
   * using the full `simctl list -j` output so a single CLI call suffices.
   *
   * @returns Flat array of `SimulatorDevice` objects.
   */
  async listDevices(): Promise<SimulatorDevice[]> {
    log('Listing devices…');
    await this.assertSimctlAvailable();

    // Fetch everything in one call so we can resolve references cheaply.
    const output = await execJSON<SimctlListOutput>(SIMCTL, [
      'simctl',
      'list',
      '-j',
    ], XCRUN_EXEC_OPTIONS);

    // Build lookup maps for O(1) resolution.
    const deviceTypeMap = new Map<string, SimctlDeviceType>(
      output.devicetypes.map((dt) => [dt.identifier, dt]),
    );
    const runtimeMap = new Map<string, SimctlRuntime>(
      output.runtimes.map((rt) => [rt.identifier, rt]),
    );

    const results: SimulatorDevice[] = [];

    for (const [runtimeIdentifier, devices] of Object.entries(output.devices)) {
      const simRuntime = runtimeMap.get(runtimeIdentifier);

      // Skip non-iOS runtimes (e.g. watchOS, tvOS).
      if (simRuntime && simRuntime.platform !== 'iOS') continue;

      for (const device of devices) {
        if (!device.isAvailable) continue;

        const simDeviceType = deviceTypeMap.get(device.deviceTypeIdentifier);

        // Build Runtime reference — fall back gracefully if runtime metadata
        // is absent (can happen with partially installed runtimes).
        const runtime: Runtime = simRuntime
          ? {
              id: simRuntime.identifier,
              platform: 'ios',
              version: simRuntime.name,
              identifier: simRuntime.identifier,
              status: simRuntime.isAvailable ? 'installed' : 'error',
            }
          : {
              id: runtimeIdentifier,
              platform: 'ios',
              version: runtimeIdentifier,
              identifier: runtimeIdentifier,
              status: 'error',
            };

        // Build DeviceType reference.
        const deviceType: DeviceType = simDeviceType
          ? {
              id: simDeviceType.identifier,
              name: simDeviceType.name,
              platform: 'ios',
              modelName: simDeviceType.name,
              modelIdentifier: simDeviceType.identifier,
            }
          : {
              id: device.deviceTypeIdentifier,
              name: device.name,
              platform: 'ios',
              modelName: device.name,
              modelIdentifier: device.deviceTypeIdentifier,
            };

        results.push({
          id: device.udid,
          platformDeviceId: device.udid,
          platform: 'ios',
          deviceType,
          runtime,
          state: mapSimctlState(device.state),
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Lifecycle — create / boot / shutdown / delete
  // -------------------------------------------------------------------------

  /**
   * Create a new iOS simulator device.
   * Runs: `xcrun simctl create <name> <deviceTypeId> <runtimeId>`
   *
   * @param name         - Human-readable name for the new device.
   * @param deviceTypeId - Device-type identifier (e.g. "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro").
   * @param runtimeId    - Runtime identifier (e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5").
   * @returns The UDID of the newly created device.
   */
  async createDevice(
    name: string,
    deviceTypeId: string,
    runtimeId: string,
  ): Promise<string> {
    log(`Creating device: name="${name}" deviceType="${deviceTypeId}" runtime="${runtimeId}"`);
    await this.assertSimctlAvailable();

    const { stdout } = await exec(SIMCTL, [
      'simctl',
      'create',
      name,
      deviceTypeId,
      runtimeId,
    ], XCRUN_EXEC_OPTIONS);

    const udid = stdout.trim();
    if (!udid) {
      throw new Error(`simctl create returned empty output for device "${name}"`);
    }

    log(`Created device with UDID: ${udid}`);
    return udid;
  }

  /**
   * Boot an iOS simulator device and wait until it reaches the "Booted" state.
   * Runs: `xcrun simctl boot <udid>` then polls `getDeviceState` until booted
   * or until `DEVICE_BOOT_TIMEOUT_MS` elapses.
   *
   * @param udid - The UDID of the device to boot.
   * @throws If the device fails to reach "Booted" within the timeout.
   */
  async bootDevice(udid: string): Promise<void> {
    log(`Booting device: ${udid}`);
    await this.assertSimctlAvailable();

    // Issue the boot command — simctl exits as soon as the boot is initiated,
    // not when it is complete, so we poll afterwards.
    await exec(SIMCTL, ['simctl', 'boot', udid], XCRUN_EXEC_OPTIONS);

    // Poll until the device reports "Booted" or we time out.
    const pollIntervalMs = 2_000;
    const deadline = Date.now() + DEVICE_BOOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const state = await this.getDeviceState(udid);
      if (state === 'booted') {
        log(`Device ${udid} is booted.`);
        return;
      }
      if (state === 'error') {
        throw new Error(`Device ${udid} entered an error state while booting.`);
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for device ${udid} to boot after ${DEVICE_BOOT_TIMEOUT_MS} ms.`,
    );
  }

  /**
   * Shut down a booted iOS simulator device.
   * Runs: `xcrun simctl shutdown <udid>`
   *
   * @param udid - The UDID of the device to shut down.
   */
  async shutdownDevice(udid: string): Promise<void> {
    log(`Shutting down device: ${udid}`);
    await this.assertSimctlAvailable();
    await exec(SIMCTL, ['simctl', 'shutdown', udid], XCRUN_EXEC_OPTIONS);
    log(`Shutdown command sent for device: ${udid}`);
  }

  /**
   * Permanently delete an iOS simulator device.
   * Runs: `xcrun simctl delete <udid>`
   *
   * @param udid - The UDID of the device to delete.
   */
  async deleteDevice(udid: string): Promise<void> {
    log(`Deleting device: ${udid}`);
    await this.assertSimctlAvailable();
    await exec(SIMCTL, ['simctl', 'delete', udid], XCRUN_EXEC_OPTIONS);
    log(`Deleted device: ${udid}`);
  }

  // -------------------------------------------------------------------------
  // State query
  // -------------------------------------------------------------------------

  /**
   * Retrieve the current lifecycle state of a simulator device.
   * Runs: `xcrun simctl list devices -j` and locates the device by UDID.
   *
   * @param udid - The UDID of the device to query.
   * @returns The current `DeviceState`, or `'error'` if the device is not found.
   */
  async getDeviceState(udid: string): Promise<DeviceState> {
    const output = await execJSON<Pick<SimctlListOutput, 'devices'>>(SIMCTL, [
      'simctl',
      'list',
      'devices',
      '-j',
    ], XCRUN_EXEC_OPTIONS);

    for (const devices of Object.values(output.devices)) {
      for (const device of devices) {
        if (device.udid === udid) {
          return mapSimctlState(device.state);
        }
      }
    }

    warn(`getDeviceState: device ${udid} not found — returning 'error'`);
    return 'error';
  }

  // -------------------------------------------------------------------------
  // Runtime download
  // -------------------------------------------------------------------------

  /**
   * Initiate a background download/installation of an iOS runtime.
   *
   * Uses `xcrun simctl runtime add <identifier>` which is available in Xcode
   * 14+.  For older Xcode versions we fall back to
   * `xcodebuild -downloadPlatform iOS`.
   *
   * This method is intentionally fire-and-forget: callers should track
   * progress via the WebSocket `runtime_download_progress` events rather than
   * awaiting completion here.
   *
   * @param identifier - The runtime identifier to download
   *                     (e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5").
   */
  async downloadRuntime(identifier: string): Promise<void> {
    log(`Initiating runtime download: ${identifier}`);
    await this.assertSimctlAvailable();

    // `xcrun simctl runtime add` was added in Xcode 14 / simctl 800.
    // We attempt it first and fall back to xcodebuild on failure.
    try {
      await exec(SIMCTL, ['simctl', 'runtime', 'add', identifier], XCRUN_EXEC_OPTIONS);
      log(`Runtime download initiated via simctl for: ${identifier}`);
    } catch (simctlError: unknown) {
      warn(
        `simctl runtime add failed (${String(simctlError)}); ` +
          `falling back to xcodebuild -downloadPlatform iOS`,
      );
      try {
        await exec('xcodebuild', ['-downloadPlatform', 'iOS'], XCRUN_EXEC_OPTIONS);
        log('Runtime download initiated via xcodebuild.');
      } catch (xcodebuildError: unknown) {
        throw new Error(
          `Failed to download runtime "${identifier}".\n` +
            `simctl error:     ${String(simctlError)}\n` +
            `xcodebuild error: ${String(xcodebuildError)}`,
          { cause: xcodebuildError },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Device Control
  // -------------------------------------------------------------------------

  /**
   * Simulate pressing a hardware button on the device via the IndigoHID binary.
   *
   * Uses SimulatorKit's private IndigoHID APIs to inject hardware button events
   * directly to the simulator's backboard — no Simulator.app focus required.
   *
   * Supported buttons:
   * - `home`       — Home button (Face ID: code 0)
   * - `lock`       — Lock/Power/Side button (code 1)
   * - `volumeUp`   — Volume Up (HID Consumer Control page 0x0c, usage 0xe9)
   * - `volumeDown` — Volume Down (HID Consumer Control page 0x0c, usage 0xea)
   *
   * @param udid   - The device UDID.
   * @param button - Button to press: `'home' | 'lock' | 'volumeUp' | 'volumeDown'`
   */
  async pressButton(
    udid: string,
    button: 'home' | 'lock' | 'volumeUp' | 'volumeDown',
  ): Promise<void> {
    log(`Pressing button "${button}" on device ${udid}`);

    const binary = await this.ensureIndigoHIDBinary();
    await exec(binary, [udid, 'button', button], {
      ...XCRUN_EXEC_OPTIONS,
      timeout: 5_000,
    });

    log(`Button "${button}" pressed on device ${udid}`);
  }

  /**
   * Rotate the device orientation via the precompiled CGEvent binary.
   *
   * `xcrun simctl orientation` is NOT a valid simctl subcommand — it does not
   * exist in any Xcode version.  Instead this method sends Simulator.app
   * keyboard shortcuts for Rotate Left (Cmd+Left Arrow) and Rotate Right
   * (Cmd+Right Arrow).
   *
   * **Limitation:** Simulator.app only exposes *relative* rotation commands
   * (left / right), not absolute orientation setters.  The mapping below
   * applies a single relative rotation as a best-effort approximation:
   *
   * | `orientation`        | Action                              |
   * |----------------------|-------------------------------------|
   * | `landscapeLeft`      | Cmd+Left  (kVK_LeftArrow = 123)     |
   * | `landscapeRight`     | Cmd+Right (kVK_RightArrow = 124)    |
   * | `portrait`           | Cmd+Right (best effort)             |
   * | `portraitUpsideDown` | Cmd+Left  (best effort)             |
   *
   * Callers that need precise absolute orientation control should track the
   * current orientation externally and issue multiple rotate calls as needed.
   *
   * Simulator.app must be running and connected to the device.
   *
   * @param udid        - The device UDID (used for logging).
   * @param orientation - `'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'`
   */
  async setOrientation(
    udid: string,
    orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown',
  ): Promise<void> {
    log(`Setting orientation to "${orientation}" on device ${udid}`);

    const binary = await this.ensureInputBinary();

    // Map each orientation to a Simulator.app rotation shortcut.
    // Cmd+Left Arrow = Rotate Left (kVK_LeftArrow = 123)
    // Cmd+Right Arrow = Rotate Right (kVK_RightArrow = 124)
    switch (orientation) {
      case 'landscapeLeft':
        await exec(binary, ['shortcut', '123', 'cmd'], { timeout: 5_000 });
        break;
      case 'landscapeRight':
        await exec(binary, ['shortcut', '124', 'cmd'], { timeout: 5_000 });
        break;
      case 'portrait':
        // Best-effort: rotate right
        await exec(binary, ['shortcut', '124', 'cmd'], { timeout: 5_000 });
        break;
      case 'portraitUpsideDown':
        // Best-effort: rotate left
        await exec(binary, ['shortcut', '123', 'cmd'], { timeout: 5_000 });
        break;
      default:
        throw new Error(
          `Invalid orientation: "${orientation}". ` +
          `Valid options: portrait, landscapeLeft, landscapeRight, portraitUpsideDown`,
        );
    }

    log(`Orientation set to "${orientation}" on device ${udid}`);
  }

  /**
   * Trigger a shake gesture on the device via the precompiled CGEvent binary.
   *
   * `xcrun simctl ui <udid> shake` does not exist — `simctl ui` only supports
   * `appearance`, `increase_contrast`, and `content_size`.  Instead this
   * method sends the Simulator.app keyboard shortcut for Device > Shake:
   * Ctrl+Cmd+Z (kVK_ANSI_Z = 6).
   *
   * Simulator.app must be running and connected to the device.
   *
   * @param udid - The device UDID (used for logging).
   */
  async shake(udid: string): Promise<void> {
    log(`Triggering shake gesture on device ${udid}`);

    // Simulator.app Device > Shake (Ctrl+Cmd+Z) — kVK_ANSI_Z = 6
    const binary = await this.ensureInputBinary();
    await exec(binary, ['shortcut', '6', 'cmd,ctrl'], { timeout: 5_000 });

    log(`Shake gesture triggered on device ${udid}`);
  }

  /**
   * Take a screenshot of the device screen and save it to `outputPath`.
   * Uses: `xcrun simctl io <udid> screenshot --type=png <outputPath>`
   *
   * @param udid       - The device UDID.
   * @param outputPath - Filesystem path where the PNG screenshot will be written.
   */
  async takeScreenshot(udid: string, outputPath: string): Promise<void> {
    log(`Taking screenshot of device ${udid} → ${outputPath}`);
    await this.assertSimctlAvailable();

    await exec(
      SIMCTL,
      ['simctl', 'io', udid, 'screenshot', '--type=png', outputPath],
      XCRUN_EXEC_OPTIONS,
    );
    log(`Screenshot saved: ${outputPath}`);
  }

  /**
   * Set the device clipboard content.
   * Uses: `xcrun simctl pbcopy <udid>` with text piped to stdin.
   *
   * @param udid - The device UDID.
   * @param text - The text to place on the clipboard.
   */
  async setClipboard(udid: string, text: string): Promise<void> {
    log(`Setting clipboard on device ${udid} (${text.length} chars)`);
    await this.assertSimctlAvailable();

    // pbcopy reads from stdin, so we spawn the process and write to its stdin
    return new Promise<void>((resolve, reject) => {
      const child = spawn(SIMCTL, ['simctl', 'pbcopy', udid], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          DEVELOPER_DIR: `${config.xcodePath}/Contents/Developer`,
        },
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        if (code === 0) {
          log(`Clipboard set on device ${udid}`);
          resolve();
        } else {
          reject(new Error(`simctl pbcopy exited with code ${code}: ${stderr.trim()}`));
        }
      });

      child.on('error', (err) => reject(err));

      child.stdin?.write(text);
      child.stdin?.end();
    });
  }

  /**
   * Get the device clipboard content.
   * Uses: `xcrun simctl pbpaste <udid>`
   *
   * @param udid - The device UDID.
   * @returns The clipboard text content.
   */
  async getClipboard(udid: string): Promise<string> {
    log(`Getting clipboard from device ${udid}`);
    await this.assertSimctlAvailable();

    const { stdout } = await exec(
      SIMCTL,
      ['simctl', 'pbpaste', udid],
      XCRUN_EXEC_OPTIONS,
    );
    log(`Clipboard read from device ${udid}: ${stdout.length} chars`);
    return stdout;
  }

  /**
   * Open a URL or deep-link on the device.
   * Uses: `xcrun simctl openurl <udid> <url>`
   *
   * @param udid - The device UDID.
   * @param url  - The URL or deep-link scheme to open.
   */
  async openUrl(udid: string, url: string): Promise<void> {
    log(`Opening URL on device ${udid}: ${url}`);
    await this.assertSimctlAvailable();

    await exec(
      SIMCTL,
      ['simctl', 'openurl', udid, url],
      XCRUN_EXEC_OPTIONS,
    );
    log(`URL opened on device ${udid}`);
  }

  /**
   * Launch Simulator.app and connect it to the given device.
   * Required for input injection (tap, swipe, keyboard) since there is no
   * CLI-based input API — Simulator.app acts as the IndigoHID bridge.
   *
   * Before launching, device bezels (hardware chrome overlays) are disabled
   * via `defaults write com.apple.iphonesimulator ShowChrome -int 0`. This
   * makes the window content area exactly equal to the device screen, which
   * simplifies coordinate mapping for tap and swipe input.
   *
   * Uses: `open -a Simulator --args -CurrentDeviceUDID <udid>`
   *
   * This is idempotent — calling it when Simulator.app is already running
   * and connected to the device has no adverse effect.
   *
   * @param udid - The device UDID (must already be booted).
   */
  async openSimulatorApp(udid: string): Promise<void> {
    log(`Opening Simulator.app for device ${udid}`);

    // Disable device bezels so the window content area matches the device
    // screen exactly, simplifying coordinate mapping for tap/swipe input.
    // This sets the Simulator.app preference before launch.
    await exec('defaults', [
      'write', 'com.apple.iphonesimulator', 'ShowChrome', '-int', '0',
    ]);

    // `open` does not need DEVELOPER_DIR — it is a standard macOS utility.
    await exec('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]);
    // Give Simulator.app time to connect to the booted device.
    await new Promise<void>(resolve => setTimeout(resolve, 2000));

    // Hide the Simulator toolbar to reduce chrome height in the captured stream.
    // This is best-effort — if the toolbar-hide command fails (e.g. the window hasn't
    // fully rendered yet), we log a warning and continue rather than aborting.
    let toolbarHidden = false;
    try {
      const binary = await this.ensureInputBinary();
      await exec(binary, ['toolbar-hide'], { timeout: 5_000 });
      toolbarHidden = true;
    } catch (err: unknown) {
      warn(
        `Could not hide Simulator toolbar for device ${udid} ` +
        `(continuing — toolbar hide is cosmetic only): ${String(err)}`,
      );
    }
    log(
      `Simulator.app launched for device ${udid}` +
      ` (bezels disabled${toolbarHidden ? ', toolbar hidden' : ''})`,
    );
  }

  /**
   * Type text into the currently focused text field on the device.
   * Uses the IndigoHID binary's `type` command to inject keyboard events
   * directly via USB HID usage codes — no Simulator.app focus required.
   *
   * @param udid - The device UDID.
   * @param text - The text string to type.
   */
  async sendText(udid: string, text: string): Promise<void> {
    log(`Sending text to device ${udid}: "${text.substring(0, 50)}${text.length > 50 ? '…' : ''}"`);

    const binary = await this.ensureIndigoHIDBinary();
    await exec(binary, [udid, 'type', text], {
      ...XCRUN_EXEC_OPTIONS,
      timeout: 10_000,
    });
    log(`Text sent to device ${udid}`);
  }

  /**
   * Send a tap at the given normalised coordinates on the iOS simulator.
   * Uses the IndigoHID binary's `tap` command to inject a touch event
   * directly via SimulatorKit's private IndigoHID APIs.
   *
   * No geometry lookup is required — IndigoHID accepts normalised coordinates
   * (0.0–1.0) directly. No Simulator.app focus required.
   *
   * @param udid  - The device UDID.
   * @param normX - Normalised X coordinate (0.0 = left edge, 1.0 = right edge).
   * @param normY - Normalised Y coordinate (0.0 = top edge, 1.0 = bottom edge).
   */
  async sendTap(udid: string, normX: number, normY: number): Promise<void> {
    log(`Sending tap to device ${udid} at normalised (${normX.toFixed(3)}, ${normY.toFixed(3)})`);

    const binary = await this.ensureIndigoHIDBinary();
    await exec(binary, [udid, 'tap', String(normX), String(normY)], {
      ...XCRUN_EXEC_OPTIONS,
      timeout: 5_000,
    });
    log(`Tap sent to device ${udid} at (${normX.toFixed(3)}, ${normY.toFixed(3)})`);
  }

  /**
   * Send a swipe gesture on the iOS simulator.
   * Uses the IndigoHID binary's `swipe` command to inject a touch drag
   * directly via SimulatorKit's private IndigoHID APIs.
   *
   * No geometry lookup required — IndigoHID accepts normalised coordinates
   * (0.0–1.0) directly. No Simulator.app focus required.
   *
   * @param udid       - The device UDID.
   * @param normX1     - Normalised start X (0.0–1.0).
   * @param normY1     - Normalised start Y (0.0–1.0).
   * @param normX2     - Normalised end X (0.0–1.0).
   * @param normY2     - Normalised end Y (0.0–1.0).
   * @param durationMs - Duration of the swipe in milliseconds (default 300).
   */
  async sendSwipe(
    udid: string,
    normX1: number,
    normY1: number,
    normX2: number,
    normY2: number,
    durationMs: number = 300,
  ): Promise<void> {
    log(
      `Sending swipe to device ${udid} from ` +
      `(${normX1.toFixed(3)},${normY1.toFixed(3)}) to ` +
      `(${normX2.toFixed(3)},${normY2.toFixed(3)})`,
    );

    const steps = Math.max(5, Math.round(durationMs / 30));

    const swipeTimeoutMs = Math.max(10_000, durationMs + 5_000);
    const binary = await this.ensureIndigoHIDBinary();
    await exec(binary, [
      udid, 'swipe',
      String(normX1), String(normY1),
      String(normX2), String(normY2),
      String(steps), String(durationMs),
    ], {
      ...XCRUN_EXEC_OPTIONS,
      timeout: swipeTimeoutMs,
    });
    log(`Swipe sent to device ${udid} from (${normX1}, ${normY1}) to (${normX2}, ${normY2})`);
  }

  /**
   * Send a key event to the iOS simulator via the IndigoHID binary.
   *
   * Uses IndigoHID key injection via USB HID usage codes — no Simulator.app
   * focus required. IndigoHID's internal kUSBHIDUsageCodes table handles the
   * mapping from key name to USB HID code.
   *
   * - Special keys (Enter, Backspace, arrows, etc.) are mapped to IndigoHID
   *   key names and sent via the `key` command.
   * - Single printable characters are sent via the `key` command directly.
   * - Multi-character keys not in the map (Shift, Control, etc.) are ignored.
   *
   * @param udid - The device UDID.
   * @param key  - Logical key value from `KeyboardEvent.key`
   *               (e.g. `'a'`, `'Enter'`, `'Backspace'`).
   * @param code - Physical key code from `KeyboardEvent.code` (reserved, unused).
   */
  async sendKeyEvent(udid: string, key: string, code: string): Promise<void> {
    // Map browser KeyboardEvent.key names to IndigoHID key names.
    // IndigoHID's kUSBHIDUsageCodes table accepts these names directly.
    // NOTE: Space (' ') is intentionally NOT mapped here — it falls through to
    // the single-character path below, which sends ' ' directly. The Swift HID
    // table has `" ": 0x2C` (the space character), not `"Space"`.
    const specialKeyMap: Record<string, string> = {
      'Enter':      'Enter',
      'Backspace':  'Backspace',
      'Delete':     'Delete',
      'Tab':        'Tab',
      'Escape':     'Escape',
      'ArrowUp':    'ArrowUp',
      'ArrowDown':  'ArrowDown',
      'ArrowLeft':  'ArrowLeft',
      'ArrowRight': 'ArrowRight',
      'Home':       'Home',
      'End':        'End',
      'PageUp':     'PageUp',
      'PageDown':   'PageDown',
    };

    const indigoKeyName = specialKeyMap[key];

    if (indigoKeyName !== undefined) {
      // Special key — use the IndigoHID 'key' command
      const binary = await this.ensureIndigoHIDBinary();
      await exec(binary, [udid, 'key', indigoKeyName], {
        ...XCRUN_EXEC_OPTIONS,
        timeout: 5_000,
      });
    } else if (key.length === 1) {
      // Single printable character (including space) — send the character directly.
      // The Swift HID table maps single characters (e.g. ' ', 'a') by their
      // literal value, so we pass the character as-is.
      const binary = await this.ensureIndigoHIDBinary();
      await exec(binary, [udid, 'key', key], {
        ...XCRUN_EXEC_OPTIONS,
        timeout: 5_000,
      });
    } else {
      // Multi-character keys not in the map (Shift, Control, Alt, Meta, etc.) — ignore.
      log(`Ignoring unsupported key: "${key}" (code: "${code}")`);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get the Simulator.app **window geometry** via the precompiled CGEvent
   * binary's `geometry` command.
   *
   * The binary uses `CGWindowListCopyWindowInfo` — which does NOT require
   * Accessibility permissions — to locate the main Simulator window and
   * returns `windowX,windowY,windowWidth,windowHeight` on stdout.
   *
   * Since bezels are disabled via `ShowChrome -int 0`, the content area is
   * the window minus the title bar, computed with a 28 px offset.
   *
   * The full window frame matches the reference frame of the captured screen
   * stream, so normalised coordinates sent from the browser can be mapped
   * directly via:
   *
   *   screenX = windowX + normX × windowWidth
   *   screenY = windowY + normY × windowHeight
   *
   * @returns Object with:
   *   - `x`, `y` — content area origin in screen coordinates
   *   - `width`, `height` — content area size (excludes title bar)
   *   - `windowX`, `windowY` — full window origin in screen coordinates
   *   - `windowWidth`, `windowHeight` — full window size (includes title bar)
   * @throws If Simulator.app is not running, has no open windows, or the
   *         binary output cannot be parsed.
   */
  private async getSimulatorContentGeometry(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    windowX: number;
    windowY: number;
    windowWidth: number;
    windowHeight: number;
  }> {
    // Return cached geometry if still fresh.
    if (this.geometryCache && (Date.now() - this.geometryCacheTime) < GEOMETRY_CACHE_TTL_MS) {
      return this.geometryCache;
    }

    const binary = await this.ensureInputBinary();
    const { stdout } = await exec(binary, ['geometry'], { timeout: 5_000 });
    const parts = stdout.trim().split(',').map(s => parseInt(s.trim(), 10));

    if (parts.length < 4 || parts.some(n => isNaN(n))) {
      throw new Error(
        `Failed to parse Simulator window geometry from binary output: "${stdout.trim()}"`,
      );
    }

    const titleBarHeight = 28;
    this.geometryCache = {
      windowX: parts[0]!,
      windowY: parts[1]!,
      windowWidth: parts[2]!,
      windowHeight: parts[3]!,
      x: parts[0]!,
      y: parts[1]! + titleBarHeight,
      width: parts[2]!,
      height: parts[3]! - titleBarHeight,
    };
    this.geometryCacheTime = Date.now();
    return this.geometryCache;
  }

  /** Clear the cached Simulator window geometry, forcing re-query on next interaction. */
  invalidateGeometryCache(): void {
    this.geometryCache = null;
    this.geometryCacheTime = 0;
  }

  /**
   * Verify that `xcrun` can locate `simctl` inside the configured Xcode.app.
   * Throws a clear, actionable error if Xcode (not just Command Line Tools)
   * is absent or `DEVELOPER_DIR` does not point to a full Xcode bundle.
   */
  private async assertSimctlAvailable(): Promise<void> {
    // We perform this check lazily (not in the constructor) so the service can
    // be imported on non-macOS hosts without throwing at module load time.
    // The actual execution will fail with a clear OS-level error anyway, but
    // this produces a friendlier message.
    if (process.platform !== 'darwin') {
      throw new Error(
        'IOSSimulatorService requires macOS. ' +
          `Current platform: ${process.platform}`,
      );
    }

    // Verify xcrun can actually locate simctl — not just that 'xcrun' binary
    // exists on PATH.  xcrun --find simctl exits 0 and prints the path if
    // simctl is reachable, exits non-zero if it is not.
    try {
      await exec(SIMCTL, ['--find', 'simctl'], XCRUN_EXEC_OPTIONS);
    } catch {
      throw new Error(
        'xcrun cannot locate simctl. Ensure Xcode (not just Command Line Tools) ' +
          'is installed, and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds.
 * Used by `bootDevice` to poll device state.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const iosSimulatorService = new IOSSimulatorService();
