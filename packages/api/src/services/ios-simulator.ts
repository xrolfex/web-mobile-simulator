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
   * Simulate pressing a hardware button on the device via the precompiled
   * CGEvent binary.
   *
   * Triggers Simulator.app keyboard shortcuts rather than `xcrun simctl ui
   * pressButton`, which does not exist — `simctl ui` only supports
   * `appearance`, `increase_contrast`, and `content_size`.
   *
   * Button → Simulator.app keyboard shortcut mapping:
   * - `home`       → Cmd+Shift+H  (Device > Home)          kVK_ANSI_H = 4
   * - `lock`       → Cmd+L        (Device > Lock Screen)   kVK_ANSI_L = 37
   * - `volumeUp`   → Cmd+Up       (Device > Volume Up)     kVK_UpArrow = 126
   * - `volumeDown` → Cmd+Down     (Device > Volume Down)   kVK_DownArrow = 125
   *
   * Simulator.app must be running and connected to the device.
   *
   * @param udid   - The device UDID (used for logging).
   * @param button - Button to press: `'home' | 'lock' | 'volumeUp' | 'volumeDown'`
   */
  async pressButton(
    udid: string,
    button: 'home' | 'lock' | 'volumeUp' | 'volumeDown',
  ): Promise<void> {
    log(`Pressing button "${button}" on device ${udid}`);

    const binary = await this.ensureInputBinary();

    // Map each button to a Simulator.app keyboard shortcut.
    // These are the same shortcuts the Simulator.app Device menu uses.
    switch (button) {
      case 'home':
        // Device > Home (Cmd+Shift+H) — kVK_ANSI_H = 4
        await exec(binary, ['shortcut', '4', 'cmd,shift'], { timeout: 5_000 });
        break;
      case 'lock':
        // Device > Lock Screen (Cmd+L) — kVK_ANSI_L = 37
        await exec(binary, ['shortcut', '37', 'cmd'], { timeout: 5_000 });
        break;
      case 'volumeUp':
        // Device > Volume Up (Cmd+ArrowUp on some versions, but no reliable shortcut)
        // Use Cmd+Up — kVK_UpArrow = 126
        await exec(binary, ['shortcut', '126', 'cmd'], { timeout: 5_000 });
        break;
      case 'volumeDown':
        // Device > Volume Down (Cmd+ArrowDown on some versions, but no reliable shortcut)
        // Use Cmd+Down — kVK_DownArrow = 125
        await exec(binary, ['shortcut', '125', 'cmd'], { timeout: 5_000 });
        break;
      default:
        throw new Error(`Unknown button: ${button}`);
    }

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
   * Uses the precompiled CGEvent binary `type` command, which posts Unicode
   * keyboard events per character — no `xcrun simctl` command exists for
   * typing text.
   *
   * Requires Simulator.app to be running and connected to the device.
   *
   * @param udid - The device UDID (used for logging).
   * @param text - The text string to type.
   */
  async sendText(udid: string, text: string): Promise<void> {
    log(`Sending text to device ${udid}: "${text.substring(0, 50)}${text.length > 50 ? '…' : ''}"`);

    const binary = await this.ensureInputBinary();
    await exec(binary, ['type', text], { timeout: 10_000 });
    log(`Text sent to device ${udid}`);
  }

  /**
   * Send a tap at the given normalised coordinates on the iOS simulator.
   * Uses a precompiled Swift / CoreGraphics CGEvent binary (mouse-down →
   * mouse-up) posted via `post(tap: .cghidEventTap)` after activating
   * Simulator.app.
   *
   * Unlike the legacy AppleScript `System Events click at {x, y}` approach,
   * this avoids macOS TCC errors (-25211, -25204) that arise from the global
   * `click at` command. Simulator.app is brought to the foreground before
   * events are posted so they are routed to it.
   *
   * Coordinate mapping:
   *   screenX = windowX + normX × windowWidth
   *   screenY = windowY + normY × windowHeight
   *
   * @param udid  - The device UDID (used for logging only).
   * @param normX - Normalised X coordinate (0.0 = left edge, 1.0 = right edge).
   * @param normY - Normalised Y coordinate (0.0 = top edge, 1.0 = bottom edge).
   * @throws If Simulator.app is not running or the input binary is unavailable.
   */
  async sendTap(udid: string, normX: number, normY: number): Promise<void> {
    log(`Sending tap to device ${udid} at normalised (${normX.toFixed(3)}, ${normY.toFixed(3)})`);

    const content = await this.getSimulatorContentGeometry();

    const screenX = Math.round(content.windowX + normX * content.windowWidth);
    const screenY = Math.round(content.windowY + normY * content.windowHeight);

    const binary = await this.ensureInputBinary();
    await exec(binary, ['tap', String(screenX), String(screenY)], { timeout: 5_000 });
    log(`Tap sent to device ${udid} at screen (${screenX}, ${screenY})`);
  }

  /**
   * Send a swipe gesture on the iOS simulator.
   * Uses a precompiled Swift / CoreGraphics CGEvent binary (mouse-down → drag
   * → mouse-up) posted via `post(tap: .cghidEventTap)` after activating
   * Simulator.app.
   *
   * Unlike `postToPid`, `post(tap: .cghidEventTap)` requires Accessibility
   * permission (not Input Monitoring). Simulator.app is brought to the
   * foreground before events are posted so they are routed to it.
   *
   * Coordinate mapping:
   *   startX = windowX + normX1 × windowWidth   (absolute screen coordinates)
   *   startY = windowY + normY1 × windowHeight
   *   endX   = windowX + normX2 × windowWidth
   *   endY   = windowY + normY2 × windowHeight
   *
   * @param udid       - The device UDID (used for logging only).
   * @param normX1     - Normalised start X (0.0–1.0).
   * @param normY1     - Normalised start Y (0.0–1.0).
   * @param normX2     - Normalised end X (0.0–1.0).
   * @param normY2     - Normalised end Y (0.0–1.0).
   * @param durationMs - Duration of the swipe in milliseconds (default 300).
   * @throws If Simulator.app is not running or the input binary is unavailable.
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

    const content = await this.getSimulatorContentGeometry();

    const startX = Math.round(content.windowX + normX1 * content.windowWidth);
    const startY = Math.round(content.windowY + normY1 * content.windowHeight);
    const endX   = Math.round(content.windowX + normX2 * content.windowWidth);
    const endY   = Math.round(content.windowY + normY2 * content.windowHeight);

    const steps = Math.max(5, Math.round(durationMs / 30));
    const stepDelaySecs = (durationMs / 1000) / steps;

    const binary = await this.ensureInputBinary();
    await exec(binary, [
      'swipe',
      String(startX), String(startY),
      String(endX), String(endY),
      String(steps), String(stepDelaySecs),
    ], { timeout: 10_000 });
    log(`Swipe sent to device ${udid} from (${startX}, ${startY}) to (${endX}, ${endY})`);
  }

  /**
   * Send a key event to the iOS simulator via the precompiled CGEvent binary.
   *
   * - Special keys (Enter, Backspace, arrows, etc.) are sent using the `key`
   *   command with the macOS virtual key code (CGEvent key down+up).
   * - Single printable characters are sent using the `keystroke` command
   *   (CGEvent Unicode posting).
   * - Multi-character keys not in the map (Shift, Control, etc.) are ignored.
   *
   * Requires Simulator.app to be running and connected to the device.
   *
   * @param udid - The device UDID (used for logging).
   * @param key  - Logical key value from `KeyboardEvent.key`
   *               (e.g. `'a'`, `'Enter'`, `'Backspace'`).
   * @param code - Physical key code from `KeyboardEvent.code` (reserved, unused).
   */
  async sendKeyEvent(udid: string, key: string, code: string): Promise<void> {
    // Map browser KeyboardEvent.key names → macOS virtual key codes.
    // Reference: HIToolbox/Events.h (kVK_* constants).
    const specialKeyMap: Record<string, number> = {
      'Enter':      36,  // kVK_Return
      'Backspace':  51,  // kVK_Delete (backspace)
      'Delete':    117,  // kVK_ForwardDelete
      'Tab':        48,  // kVK_Tab
      'Escape':     53,  // kVK_Escape
      'ArrowUp':   126,  // kVK_UpArrow
      'ArrowDown': 125,  // kVK_DownArrow
      'ArrowLeft': 123,  // kVK_LeftArrow
      'ArrowRight':124,  // kVK_RightArrow
      ' ':          49,  // kVK_Space
      'Home':      115,  // kVK_Home
      'End':       119,  // kVK_End
      'PageUp':    116,  // kVK_PageUp
      'PageDown':  121,  // kVK_PageDown
    };

    const macKeyCode = specialKeyMap[key];

    if (macKeyCode !== undefined) {
      // Special key — use the 'key' command with virtual key code
      const binary = await this.ensureInputBinary();
      await exec(binary, ['key', String(macKeyCode)], { timeout: 5_000 });
    } else if (key.length === 1) {
      // Printable character — use the 'keystroke' command
      const binary = await this.ensureInputBinary();
      await exec(binary, ['keystroke', key], { timeout: 5_000 });
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
