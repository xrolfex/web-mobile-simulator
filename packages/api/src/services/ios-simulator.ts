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
  // VNC port discovery
  // -------------------------------------------------------------------------

  /**
   * Discover the VNC port that a booted iOS Simulator is listening on.
   *
   * The Simulator app opens a VNC server when a device is booted.  We discover
   * the port by:
   *   1. Using `lsof -iTCP -sTCP:LISTEN -P` to list all TCP listeners.
   *   2. Filtering lines that reference the Simulator process and the
   *      well-known VNC port range (5900–5999).
   *   3. Falling back to port 5900 (the default VNC port) if no matching
   *      listener is found.
   *
   * Returns `null` if the device is not booted or no VNC listener is detected.
   *
   * @param udid - The UDID of the (booted) device.
   * @returns The VNC TCP port number, or `null` if undiscoverable.
   */
  async getVNCPort(udid: string): Promise<number | null> {
    log(`Discovering VNC port for device: ${udid}`);

    // Confirm the device is actually booted before searching.
    const state = await this.getDeviceState(udid);
    if (state !== 'booted') {
      warn(`getVNCPort: device ${udid} is not booted (state="${state}") — returning null`);
      return null;
    }

    try {
      // List all TCP listeners.  We avoid the shell so we use execFile directly
      // via our exec helper (lsof is at a well-known path on macOS).
      const { stdout } = await exec('/usr/sbin/lsof', [
        '-iTCP',
        '-sTCP:LISTEN',
        '-P',        // numeric ports (no service name substitution)
        '-n',        // numeric hosts
      ]);

      // A typical matching line looks like:
      //   Simulator  12345  eric  …  TCP  *:5900 (LISTEN)
      //   Simulator  12345  eric  …  TCP  127.0.0.1:5901 (LISTEN)
      const vncPortPattern = /\bSimulator\b.*?:(\d+)\s*\(LISTEN\)/i;
      const vncRangeMin = 5900;
      const vncRangeMax = 5999;

      for (const line of stdout.split('\n')) {
        const match = vncPortPattern.exec(line);
        if (!match) continue;

        const port = parseInt(match[1]!, 10);
        if (port >= vncRangeMin && port <= vncRangeMax) {
          log(`Found VNC port ${port} for device ${udid}`);
          return port;
        }
      }

      // No listener found in the VNC range.
      log(`No VNC listener detected in range ${vncRangeMin}–${vncRangeMax} — returning null`);
      return null;
    } catch (error: unknown) {
      warn(`getVNCPort: lsof failed — ${String(error)}`);
      return null;
    }
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
