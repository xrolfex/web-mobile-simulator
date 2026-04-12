import { spawn } from 'node:child_process';
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
   * Simulate pressing a hardware button on the device.
   * Uses: `xcrun simctl ui <udid> pressButton <buttonName>`
   *
   * @param udid   - The device UDID.
   * @param button - Button name: `'home' | 'lock' | 'volumeUp' | 'volumeDown'`
   */
  async pressButton(
    udid: string,
    button: 'home' | 'lock' | 'volumeUp' | 'volumeDown',
  ): Promise<void> {
    log(`Pressing button "${button}" on device ${udid}`);
    await this.assertSimctlAvailable();

    // simctl uses camelCase for volume buttons
    const buttonMap: Record<string, string> = {
      home: 'home',
      lock: 'lock',
      volumeUp: 'volumeUp',
      volumeDown: 'volumeDown',
    };
    const simctlButton = buttonMap[button];
    if (!simctlButton) {
      throw new Error(`Unknown button: ${button}`);
    }

    await exec(SIMCTL, ['simctl', 'ui', udid, 'pressButton', simctlButton], XCRUN_EXEC_OPTIONS);
    log(`Button "${button}" pressed on device ${udid}`);
  }

  /**
   * Set the device orientation/rotation.
   * Uses: `xcrun simctl orientation <udid> <orientation>`
   *
   * NOTE: `xcrun simctl orientation` is available in newer Xcode versions.
   * For older versions, fallback approaches are needed (UI automation).
   *
   * @param udid        - The device UDID.
   * @param orientation - `'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'`
   */
  async setOrientation(
    udid: string,
    orientation: 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown',
  ): Promise<void> {
    log(`Setting orientation to "${orientation}" on device ${udid}`);
    await this.assertSimctlAvailable();

    const orientationMap: Record<string, string> = {
      portrait: 'portrait',
      landscapeLeft: 'landscape left',
      landscapeRight: 'landscape right',
      portraitUpsideDown: 'portrait upside down',
    };

    const simctlOrientation = orientationMap[orientation];
    if (!simctlOrientation) {
      const validOrientations = Object.keys(orientationMap);
      throw new Error(
        `Invalid orientation: ${orientation}. Valid options: ${validOrientations.join(', ')}`,
      );
    }

    await exec(
      SIMCTL,
      ['simctl', 'orientation', udid, simctlOrientation],
      XCRUN_EXEC_OPTIONS,
    );
    log(`Orientation set to "${orientation}" on device ${udid}`);
  }

  /**
   * Trigger a shake gesture on the device.
   * Uses: `xcrun simctl ui <udid> shake` (available in Xcode 15+).
   *
   * Note: This command may not be available in all Xcode versions.
   * If it fails, a descriptive error is thrown rather than silently swallowed.
   *
   * @param udid - The device UDID.
   */
  async shake(udid: string): Promise<void> {
    log(`Triggering shake gesture on device ${udid}`);
    await this.assertSimctlAvailable();

    try {
      await exec(SIMCTL, ['simctl', 'ui', udid, 'shake'], XCRUN_EXEC_OPTIONS);
      log(`Shake gesture triggered on device ${udid}`);
    } catch (error: unknown) {
      // Shake may not be supported in older Xcode versions — surface a clear message.
      warn(`Shake gesture failed (may not be supported): ${String(error)}`);
      throw new Error('Shake gesture is not supported in this Xcode version.');
    }
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
   * Type text into the currently focused text field on the device.
   * Uses: `xcrun simctl io <udid> type <text>`
   *
   * NOTE: This requires Xcode 15+ and only works when a text field is focused.
   * If no text field is focused, simctl may fail silently or error.
   *
   * @param udid - The device UDID.
   * @param text - The text string to type.
   */
  async sendText(udid: string, text: string): Promise<void> {
    log(`Sending text to device ${udid}: "${text.substring(0, 50)}${text.length > 50 ? '…' : ''}"`);
    await this.assertSimctlAvailable();

    // simctl io type expects the text as trailing arguments.
    // We pass it as a single argument — simctl handles spaces correctly.
    await exec(
      SIMCTL,
      ['simctl', 'io', udid, 'type', text],
      XCRUN_EXEC_OPTIONS,
    );
    log(`Text sent to device ${udid}`);
  }

  /**
   * Send a tap (touch down + up) at the given pixel coordinates on the iOS simulator.
   * Uses: `xcrun simctl io <udid> sendTouchEvent down|up <x> <y>` (Xcode 15+).
   *
   * @param udid - The device UDID.
   * @param x    - X pixel coordinate on the device screen.
   * @param y    - Y pixel coordinate on the device screen.
   * @throws If the simulator is not running or the command fails.
   */
  async sendTap(udid: string, x: number, y: number): Promise<void> {
    log(`Sending tap to device ${udid} at (${x}, ${y})`);
    await this.assertSimctlAvailable();

    const px = String(Math.round(x));
    const py = String(Math.round(y));

    await exec(SIMCTL, ['simctl', 'io', udid, 'sendTouchEvent', 'began', px, py], XCRUN_EXEC_OPTIONS);
    // Brief delay between began and ended to simulate a real tap
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    await exec(SIMCTL, ['simctl', 'io', udid, 'sendTouchEvent', 'ended', px, py], XCRUN_EXEC_OPTIONS);

    log(`Tap sent to device ${udid} at (${x}, ${y})`);
  }

  /**
   * Send a swipe gesture from one point to another on the iOS simulator.
   * Uses a series of `sendTouchEvent` commands: began → moved (interpolated) → ended.
   *
   * @param udid       - The device UDID.
   * @param x1         - Starting X pixel coordinate.
   * @param y1         - Starting Y pixel coordinate.
   * @param x2         - Ending X pixel coordinate.
   * @param y2         - Ending Y pixel coordinate.
   * @param durationMs - Approximate duration of the swipe in milliseconds (default 300).
   * @throws If the simulator is not running or the command fails.
   */
  async sendSwipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
  ): Promise<void> {
    log(`Sending swipe to device ${udid} from (${x1},${y1}) to (${x2},${y2})`);
    await this.assertSimctlAvailable();

    // Number of intermediate move steps for a smooth swipe
    const steps = Math.max(5, Math.round(durationMs / 30));
    const stepDelay = durationMs / steps;

    // Touch down at start point
    await exec(SIMCTL, ['simctl', 'io', udid, 'sendTouchEvent', 'began',
      String(Math.round(x1)), String(Math.round(y1))], XCRUN_EXEC_OPTIONS);

    // Interpolate move events
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(x1 + (x2 - x1) * t);
      const iy = Math.round(y1 + (y2 - y1) * t);
      await new Promise<void>(resolve => setTimeout(resolve, stepDelay));
      await exec(SIMCTL, ['simctl', 'io', udid, 'sendTouchEvent', 'moved',
        String(ix), String(iy)], XCRUN_EXEC_OPTIONS);
    }

    // Touch up at end point
    await exec(SIMCTL, ['simctl', 'io', udid, 'sendTouchEvent', 'ended',
      String(Math.round(x2)), String(Math.round(y2))], XCRUN_EXEC_OPTIONS);

    log(`Swipe sent to device ${udid}`);
  }

  /**
   * Send a key event to the iOS simulator.
   *
   * For printable characters, uses `xcrun simctl io <udid> type <char>`.
   * For special keys (Enter, Backspace, etc.), uses `xcrun simctl io <udid> sendKeyboardEvent <key>`
   * which is available in Xcode 15+.
   *
   * @param udid - The device UDID.
   * @param key  - The logical key value from KeyboardEvent.key (e.g. 'a', 'Enter', 'Backspace').
   * @param code - The physical key code from KeyboardEvent.code (e.g. 'KeyA', 'Enter').
   * @throws If the simulator is not running or the command fails.
   */
  async sendKeyEvent(udid: string, key: string, code: string): Promise<void> {
    await this.assertSimctlAvailable();

    // Map browser key names to simctl keyboard event codes
    // simctl io sendKeyboardEvent uses key codes from IOHIDUsageTables.h
    const specialKeyMap: Record<string, number> = {
      'Enter': 0x28,        // kHIDUsage_KeyboardReturnOrEnter
      'Backspace': 0x2A,    // kHIDUsage_KeyboardDeleteOrBackspace
      'Delete': 0x4C,       // kHIDUsage_KeyboardDeleteForward
      'Tab': 0x2B,          // kHIDUsage_KeyboardTab
      'Escape': 0x29,       // kHIDUsage_KeyboardEscape
      'ArrowUp': 0x52,      // kHIDUsage_KeyboardUpArrow
      'ArrowDown': 0x51,    // kHIDUsage_KeyboardDownArrow
      'ArrowLeft': 0x50,    // kHIDUsage_KeyboardLeftArrow
      'ArrowRight': 0x4F,   // kHIDUsage_KeyboardRightArrow
      ' ': 0x2C,            // kHIDUsage_KeyboardSpacebar
      'Home': 0x4A,         // kHIDUsage_KeyboardHome
      'End': 0x4D,          // kHIDUsage_KeyboardEnd
      'PageUp': 0x4B,       // kHIDUsage_KeyboardPageUp
      'PageDown': 0x4E,     // kHIDUsage_KeyboardPageDown
    };

    const hidCode = specialKeyMap[key];
    if (hidCode !== undefined) {
      // Use simctl keyboard event for special keys (Xcode 15+)
      try {
        await exec(
          SIMCTL,
          ['simctl', 'io', udid, 'sendKeyboardEvent', String(hidCode)],
          XCRUN_EXEC_OPTIONS,
        );
      } catch {
        // sendKeyboardEvent may not be available in older Xcode — log and skip
        log(`sendKeyboardEvent not supported for key "${key}" (HID code 0x${hidCode.toString(16)})`);
      }
    } else if (key.length === 1) {
      // Single printable character — use `simctl io type`
      await exec(
        SIMCTL,
        ['simctl', 'io', udid, 'type', key],
        XCRUN_EXEC_OPTIONS,
      );
    }
    // Multi-character keys not in the map are silently ignored
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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
