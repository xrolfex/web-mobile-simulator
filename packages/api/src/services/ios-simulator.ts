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
   * Simulate pressing a hardware button on the device via AppleScript.
   *
   * Triggers Simulator.app keyboard shortcuts or Device-menu clicks rather
   * than `xcrun simctl ui pressButton`, which does not exist — `simctl ui`
   * only supports `appearance`, `increase_contrast`, and `content_size`.
   *
   * Button → Simulator.app action mapping:
   * - `home`       → Cmd+Shift+H  (Device > Home)
   * - `lock`       → Device menu item "Lock Screen"
   * - `volumeUp`   → Device menu item "Volume Up"   (no keyboard shortcut)
   * - `volumeDown` → Device menu item "Volume Down" (no keyboard shortcut)
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

    // Map each button to the AppleScript snippet that triggers it.
    // Simulator.app must be frontmost for keyboard shortcuts to work.
    let actionSnippet: string;
    switch (button) {
      case 'home':
        // Device > Home (Cmd+Shift+H)
        actionSnippet = 'keystroke "h" using {command down, shift down}';
        break;
      case 'lock':
        // Device > Lock Screen — use menu click to avoid ambiguity with
        // Cmd+L which maps to different actions on some Xcode versions.
        actionSnippet = 'click menu item "Lock Screen" of menu 1 of menu bar item "Device" of menu bar 1';
        break;
      case 'volumeUp':
        // Device > Volume Up — no keyboard shortcut; click the menu item directly.
        actionSnippet = 'click menu item "Volume Up" of menu 1 of menu bar item "Device" of menu bar 1';
        break;
      case 'volumeDown':
        // Device > Volume Down — no keyboard shortcut; click the menu item directly.
        actionSnippet = 'click menu item "Volume Down" of menu 1 of menu bar item "Device" of menu bar 1';
        break;
      default:
        throw new Error(`Unknown button: ${button}`);
    }

    const script = `
      tell application "System Events"
        tell process "Simulator"
          set frontmost to true
          ${actionSnippet}
        end tell
      end tell
    `;

    await exec('osascript', ['-e', script]);
    log(`Button "${button}" pressed on device ${udid}`);
  }

  /**
   * Rotate the device orientation via Simulator.app Device-menu clicks.
   *
   * `xcrun simctl orientation` is NOT a valid simctl subcommand — it does not
   * exist in any Xcode version.  Instead this method triggers the
   * Simulator.app Device menu items "Rotate Left" and "Rotate Right".
   *
   * **Limitation:** Simulator.app only exposes *relative* rotation commands
   * (left / right), not absolute orientation setters.  The mapping below
   * applies a single relative rotation as a best-effort approximation:
   *
   * | `orientation`        | Action                        |
   * |----------------------|-------------------------------|
   * | `landscapeLeft`      | Device > Rotate Left          |
   * | `landscapeRight`     | Device > Rotate Right         |
   * | `portrait`           | Device > Rotate Right (best effort) |
   * | `portraitUpsideDown` | Device > Rotate Left  (best effort) |
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

    // Map each requested orientation to the closest Device-menu item name.
    // "Rotate Left" and "Rotate Right" are the only orientation-related items
    // available in all Xcode versions — no absolute-orientation menu items exist.
    const menuItemMap: Record<string, string> = {
      landscapeLeft:      'Rotate Left',
      landscapeRight:     'Rotate Right',
      portrait:           'Rotate Right',  // best-effort relative rotation
      portraitUpsideDown: 'Rotate Left',   // best-effort relative rotation
    };

    const menuItem = menuItemMap[orientation];
    if (!menuItem) {
      throw new Error(
        `Invalid orientation: "${orientation}". ` +
        `Valid options: ${Object.keys(menuItemMap).join(', ')}`,
      );
    }

    const script = `
      tell application "System Events"
        tell process "Simulator"
          set frontmost to true
          click menu item "${menuItem}" of menu 1 of menu bar item "Device" of menu bar 1
        end tell
      end tell
    `;

    await exec('osascript', ['-e', script]);
    log(`Orientation set to "${orientation}" on device ${udid}`);
  }

  /**
   * Trigger a shake gesture on the device via AppleScript.
   *
   * `xcrun simctl ui <udid> shake` does not exist — `simctl ui` only supports
   * `appearance`, `increase_contrast`, and `content_size`.  Instead this
   * method sends the Simulator.app keyboard shortcut for Device > Shake:
   * Ctrl+Cmd+Z.
   *
   * Simulator.app must be running and connected to the device.
   *
   * @param udid - The device UDID (used for logging).
   */
  async shake(udid: string): Promise<void> {
    log(`Triggering shake gesture on device ${udid}`);

    // Simulator.app Device > Shake (Ctrl+Cmd+Z)
    const script = `
      tell application "System Events"
        tell process "Simulator"
          set frontmost to true
          keystroke "z" using {command down, control down}
        end tell
      end tell
    `;

    await exec('osascript', ['-e', script]);
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
    // This is best-effort — if the toolbar script fails (e.g. the window hasn't
    // fully rendered yet, or Accessibility permissions are not granted), we log a
    // warning and continue rather than aborting session creation.
    const toolbarScript = `
  tell application "System Events"
    tell process "Simulator"
      if exists toolbar 1 of window 1 then
        if visible of toolbar 1 of window 1 then
          set visible of toolbar 1 of window 1 to false
        end if
      end if
    end tell
  end tell
`;
    let toolbarHidden = false;
    try {
      await exec('osascript', ['-e', toolbarScript]);
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
   * Uses AppleScript `keystroke` via Simulator.app — no `xcrun simctl` command
   * exists for typing text.
   *
   * Requires Simulator.app to be running and connected to the device.
   *
   * @param udid - The device UDID (used for logging).
   * @param text - The text string to type.
   */
  async sendText(udid: string, text: string): Promise<void> {
    log(`Sending text to device ${udid}: "${text.substring(0, 50)}${text.length > 50 ? '…' : ''}"`);

    // Escape characters that are special inside an AppleScript double-quoted string.
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "System Events"
        tell process "Simulator"
          set frontmost to true
          keystroke "${escaped}"
        end tell
      end tell
    `;

    await exec('osascript', ['-e', script]);
    log(`Text sent to device ${udid}`);
  }

  /**
   * Send a tap at the given normalised coordinates on the iOS simulator.
   * Uses a Swift / CoreGraphics CGEvent sequence (mouse-down → mouse-up)
   * posted via `post(tap: .cghidEventTap)` after activating Simulator.app.
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
   * @throws If Simulator.app is not running or Swift is unavailable.
   */
  async sendTap(udid: string, normX: number, normY: number): Promise<void> {
    log(`Sending tap to device ${udid} at normalised (${normX.toFixed(3)}, ${normY.toFixed(3)})`);

    const content = await this.getSimulatorContentGeometry();

    const screenX = Math.round(content.windowX + normX * content.windowWidth);
    const screenY = Math.round(content.windowY + normY * content.windowHeight);

    const swiftScript = `
import CoreGraphics
import Foundation
import AppKit

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator")
guard let simulator = apps.first else {
    fputs("ERROR: Simulator.app not running\\n", stderr)
    exit(1)
}

// Bring Simulator to the foreground so HID events are routed to it.
simulator.activate(options: .activateIgnoringOtherApps)
Thread.sleep(forTimeInterval: 0.05)

func post(_ type: CGEventType, _ x: Double, _ y: Double) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

post(.leftMouseDown, ${screenX}, ${screenY})
Thread.sleep(forTimeInterval: 0.05)
post(.leftMouseUp, ${screenX}, ${screenY})
`;

    await exec('swift', ['-e', swiftScript]);
    log(`Tap sent to device ${udid} at screen (${screenX}, ${screenY})`);
  }

  /**
   * Send a swipe gesture on the iOS simulator.
   * Uses a Swift / CoreGraphics CGEvent sequence (mouse-down → drag → mouse-up)
   * posted via `post(tap: .cghidEventTap)` after activating Simulator.app.
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
   * @throws If Simulator.app is not running or Swift is unavailable.
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

    const swiftScript = `
import CoreGraphics
import Foundation
import AppKit

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator")
guard let simulator = apps.first else {
    fputs("ERROR: Simulator.app not running\\n", stderr)
    exit(1)
}

// Bring Simulator to the foreground so HID events are routed to it.
simulator.activate(options: .activateIgnoringOtherApps)
Thread.sleep(forTimeInterval: 0.1)

func post(_ type: CGEventType, _ x: Double, _ y: Double) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

let steps = ${steps}
let stepDelay: Double = ${stepDelaySecs}

post(.leftMouseDown, ${startX}, ${startY})
Thread.sleep(forTimeInterval: 0.02)

for i in 1...steps {
    let t = Double(i) / Double(steps)
    let ix = ${startX} + (${endX} - ${startX}) * t
    let iy = ${startY} + (${endY} - ${startY}) * t
    post(.leftMouseDragged, ix, iy)
    Thread.sleep(forTimeInterval: stepDelay)
}

post(.leftMouseUp, ${endX}, ${endY})
`;

    await exec('swift', ['-e', swiftScript]);
    log(`Swipe sent to device ${udid} from (${startX}, ${startY}) to (${endX}, ${endY})`);
  }

  /**
   * Send a key event to the iOS simulator via AppleScript.
   *
   * - Special keys (Enter, Backspace, arrows, etc.) are sent using
   *   `key code <macVirtualKeyCode>`.
   * - Single printable characters are sent using `keystroke "<char>"`.
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
    let script: string;

    if (macKeyCode !== undefined) {
      script = `
        tell application "System Events"
          tell process "Simulator"
            set frontmost to true
            key code ${macKeyCode}
          end tell
        end tell
      `;
    } else if (key.length === 1) {
      // Escape characters that are special inside an AppleScript double-quoted string.
      const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `
        tell application "System Events"
          tell process "Simulator"
            set frontmost to true
            keystroke "${escaped}"
          end tell
        end tell
      `;
    } else {
      // Multi-character keys not in the map (Shift, Control, Alt, Meta, etc.) — ignore.
      log(`Ignoring unsupported key: "${key}" (code: "${code}")`);
      return;
    }

    await exec('osascript', ['-e', script]);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get the Simulator.app **window and content area** geometry via AppleScript.
   *
   * Issues a single batched AppleScript call that fetches both the full window
   * frame (`window 1`) and the device-screen content area (`group 1 of window 1`)
   * in one round-trip, returning 8 comma-separated integers:
   * `winX,winY,winW,winH,contentX,contentY,contentW,contentH`.
   *
   * The full window frame matches the reference frame of the captured screen
   * stream (which includes the macOS title bar and the Simulator toolbar), so
   * normalised coordinates sent from the browser can be mapped directly via:
   *
   *   screenX = windowX + normX × windowWidth
   *   screenY = windowY + normY × windowHeight
   *
   * Each integer returned by AppleScript is explicitly coerced to `text` before
   * `&` concatenation to prevent the `&` operator from building a list instead
   * of a string (which would produce spurious commas in the output).
   *
   * **Fallback**: if the batched query fails (e.g. `group 1 of window 1` is
   * unavailable on older Xcode versions), the method falls back to a single
   * window-frame-only AppleScript query and derives the content area origin
   * using a hardcoded 28 px title-bar offset, emitting a warning so the caller
   * is aware of reduced accuracy.
   *
   * @returns Object with:
   *   - `x`, `y` — content area origin in screen coordinates
   *   - `width`, `height` — content area size (excludes window chrome)
   *   - `windowX`, `windowY` — full window origin in screen coordinates
   *   - `windowWidth`, `windowHeight` — full window size (includes title bar + toolbar)
   * @throws If Simulator.app is not running, has no open windows, or both the
   *         batched and window-frame AppleScript queries fail.
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
    // --- Primary: single batched query — window frame + content area ---
    const batchedScript = `
      tell application "System Events"
        tell process "Simulator"
          set winPos to position of window 1
          set winSize to size of window 1
          set contentArea to group 1 of window 1
          set contentPos to position of contentArea
          set contentSize to size of contentArea
          return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text) & "," & ((item 1 of winSize) as text) & "," & ((item 2 of winSize) as text) & "," & ((item 1 of contentPos) as text) & "," & ((item 2 of contentPos) as text) & "," & ((item 1 of contentSize) as text) & "," & ((item 2 of contentSize) as text)
        end tell
      end tell
    `;

    try {
      const { stdout } = await exec('osascript', ['-e', batchedScript]);
      const parts = stdout.trim().split(',').map(s => parseInt(s.trim(), 10));

      if (parts.length >= 8 && parts.every(n => !isNaN(n))) {
        return {
          windowX: parts[0]!, windowY: parts[1]!, windowWidth: parts[2]!, windowHeight: parts[3]!,
          x: parts[4]!, y: parts[5]!, width: parts[6]!, height: parts[7]!,
        };
      }

      warn(
        `Content-area geometry query returned unexpected output: "${stdout.trim()}". ` +
        'Falling back to window frame with hardcoded title-bar offset.',
      );
    } catch (err) {
      warn(
        `Content-area geometry query failed (${(err as Error).message}). ` +
        'Falling back to window frame with hardcoded title-bar offset.',
      );
    }

    // --- Fallback: window frame only + hardcoded title-bar offset ---
    const windowScript = `
      tell application "System Events"
        tell process "Simulator"
          set winPos to position of window 1
          set winSize to size of window 1
          return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text) & "," & ((item 1 of winSize) as text) & "," & ((item 2 of winSize) as text)
        end tell
      end tell
    `;

    const { stdout: fallbackStdout } = await exec('osascript', ['-e', windowScript]);
    const fallbackParts = fallbackStdout.trim().split(',').map(s => parseInt(s.trim(), 10));

    if (fallbackParts.length < 4 || fallbackParts.some(n => isNaN(n))) {
      throw new Error(
        `Failed to parse Simulator window geometry from AppleScript output: "${fallbackStdout.trim()}"`,
      );
    }

    const titleBarHeight = 28; // Hardcoded fallback offset — less accurate than batched query.
    return {
      windowX: fallbackParts[0]!,
      windowY: fallbackParts[1]!,
      windowWidth: fallbackParts[2]!,
      windowHeight: fallbackParts[3]!,
      x: fallbackParts[0]!,
      y: fallbackParts[1]! + titleBarHeight,
      width: fallbackParts[2]!,
      height: fallbackParts[3]! - titleBarHeight,
    };
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
