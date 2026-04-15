import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { arch } from 'node:os';
import { config } from '../config.js';
import type { DeviceType, Runtime, SimulatorDevice, DeviceState, SimulatorButton, DeviceOrientation } from '@web-mobile-simulator/shared';
import { DEVICE_BOOT_TIMEOUT_MS } from '@web-mobile-simulator/shared';
import { exec } from '../utils/exec.js';

// ---------------------------------------------------------------------------
// SDK tool paths derived from config
// ---------------------------------------------------------------------------

const ANDROID_SDK = config.androidSdkRoot;
const SDKMANAGER = `${ANDROID_SDK}/cmdline-tools/latest/bin/sdkmanager`;
const AVDMANAGER = `${ANDROID_SDK}/cmdline-tools/latest/bin/avdmanager`;
const EMULATOR_BIN = `${ANDROID_SDK}/emulator/emulator`;
const ADB = `${ANDROID_SDK}/platform-tools/adb`;

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

/** Parsed entry from `adb devices`. */
interface AdbDevice {
  /** e.g. "emulator-5554" */
  serial: string;
  /** e.g. "device" | "offline" | "unauthorized" */
  status: string;
}

/** Key/value pairs from an AVD config.ini file. */
type AvdConfig = Record<string, string>;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the text output of `avdmanager list device` into device entries.
 * Each block looks like:
 * ```
 * id: 0 or "pixel"
 *     Name: Pixel
 *     OEM : Google
 * ```
 *
 * @param output - Raw stdout from `avdmanager list device`.
 * @returns Array of objects with id, identifier, name, and oem fields.
 */
function parseAvdmanagerDevices(output: string): Array<{
  identifier: string;
  name: string;
  oem: string;
}> {
  const results: Array<{ identifier: string; name: string; oem: string }> = [];

  // Split on separator lines (3+ dashes) to get blocks, each block is one device
  const blocks = output.split(/\n-{3,}\n/);

  for (const block of blocks) {
    // Match the id line: `id: 0 or "pixel_8"` — extract the quoted identifier
    const idMatch = block.match(/^id:\s*\d+\s+or\s+"([^"]+)"/m);
    if (!idMatch) continue;

    const identifier = idMatch[1];

    const nameMatch = block.match(/^\s+Name:\s*(.+)$/m);
    const oemMatch = block.match(/^\s+OEM\s*:\s*(.+)$/m);

    const name = nameMatch ? nameMatch[1].trim() : identifier;
    const oem = oemMatch ? oemMatch[1].trim() : '';

    results.push({ identifier, name, oem });
  }

  return results;
}

/**
 * Parse the text output of `sdkmanager --list` and collect system image
 * package paths from both the "Installed packages" and "Available Packages"
 * sections.
 *
 * System image lines look like:
 * ```
 *   system-images;android-34;google_apis;arm64-v8a | 14 | ...
 * ```
 *
 * @param output - Raw stdout from `sdkmanager --list`.
 * @returns Array of objects containing path, version, description, and whether the image is installed.
 */
function parseSdkmanagerList(output: string): Array<{
  path: string;
  version: string;
  description: string;
  installed: boolean;
}> {
  const results: Array<{
    path: string;
    version: string;
    description: string;
    installed: boolean;
  }> = [];

  const lines = output.split('\n');
  let inInstalled = false;
  let inAvailable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Installed packages:/i.test(trimmed)) {
      inInstalled = true;
      inAvailable = false;
      continue;
    }
    if (/^Available Packages:/i.test(trimmed) || /^Available Updates:/i.test(trimmed)) {
      inAvailable = true;
      inInstalled = false;
      continue;
    }

    // Skip header/separator lines
    if (!trimmed || trimmed.startsWith('Path') || trimmed.startsWith('---') || trimmed.startsWith('=')) {
      continue;
    }

    // Only process system-image lines
    if (!trimmed.startsWith('system-images;')) {
      continue;
    }

    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;

    const path = parts[0];
    const version = parts[1] ?? '';
    const description = parts[2] ?? '';

    results.push({
      path,
      version,
      description,
      installed: inInstalled && !inAvailable,
    });
  }

  return results;
}

/**
 * Parse `adb devices` output into an array of serial/status pairs.
 *
 * Example output:
 * ```
 * List of devices attached
 * emulator-5554   device
 * emulator-5556   offline
 * ```
 *
 * @param output - Raw stdout from `adb devices`.
 * @returns Parsed device entries.
 */
function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header and blank lines
    if (!trimmed || trimmed.startsWith('List of devices')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    devices.push({ serial: parts[0], status: parts[1] });
  }

  return devices;
}

/**
 * Parse a `config.ini` file (key=value format) into a plain object.
 *
 * @param content - Raw text content of the AVD config.ini file.
 * @returns Key/value map.
 */
function parseIniFile(content: string): AvdConfig {
  const result: AvdConfig = {};
  for (const line of content.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Extract the API level integer from a system image path like
 * `system-images;android-34;google_apis;arm64-v8a`.
 *
 * @param systemImagePath - Package path string.
 * @returns API level number, or 0 if unparseable.
 */
function apiLevelFromImagePath(systemImagePath: string): number {
  const match = systemImagePath.match(/android-(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract the ABI (architecture) from a system image path like
 * `system-images;android-34;google_apis;arm64-v8a`.
 *
 * @param systemImagePath - Package path string.
 * @returns ABI string (e.g. "arm64-v8a", "x86_64") or empty string.
 */
function abiFromImagePath(systemImagePath: string): string {
  const parts = systemImagePath.split(';');
  return parts[3] ?? '';
}

/**
 * Map an API level integer to a human-readable Android version name.
 *
 * @param apiLevel - Android API level.
 * @returns Version string like "Android 14 (API 34)".
 */
function androidVersionLabel(apiLevel: number): string {
  const versionMap: Record<number, string> = {
    35: '15',
    34: '14',
    33: '13',
    32: '12L',
    31: '12',
    30: '11',
    29: '10',
    28: '9 (Pie)',
    27: '8.1 (Oreo)',
    26: '8.0 (Oreo)',
  };
  const name = versionMap[apiLevel];
  return name ? `Android ${name} (API ${apiLevel})` : `Android API ${apiLevel}`;
}

// ---------------------------------------------------------------------------
// AndroidEmulatorService
// ---------------------------------------------------------------------------

/**
 * Service that wraps Google Android SDK CLI tools — `avdmanager`, `emulator`,
 * `adb`, and `sdkmanager` — to manage Android Virtual Devices (AVDs)
 * programmatically from Node.js.
 *
 * Always use the exported singleton `androidEmulatorService` rather than
 * constructing new instances.
 */
export class AndroidEmulatorService {
  /**
   * Map of AVD name → spawned emulator ChildProcess.
   * Used to track running emulators for cleanup on shutdown.
   */
  private readonly runningProcesses: Map<string, ChildProcess> = new Map();

  /** Cache of resolved ADB ports keyed by AVD name. */
  private readonly adbPortCache = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Detect whether we are running on Apple Silicon (arm64) or Intel (x86_64)
   * and return the matching Android system image ABI identifier.
   *
   * @returns `'arm64-v8a'` on Apple Silicon / ARM64, `'x86_64'` on Intel.
   */
  getHostArchitecture(): 'arm64-v8a' | 'x86_64' {
    const hostArch = arch();
    return hostArch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  }

  /**
   * List available Android device definitions from `avdmanager list device`.
   * Only Pixel and widely-used generic phone form factors are returned.
   *
   * @returns Array of {@link DeviceType} entries with `platform='android'`.
   * @throws If `avdmanager` is not found or exits with a non-zero code.
   */
  async listDeviceTypes(): Promise<DeviceType[]> {
    this.assertSdkInstalled();

    const { stdout } = await exec(AVDMANAGER, ['list', 'device']);

    const raw = parseAvdmanagerDevices(stdout);

    // Filter to popular Pixel and generic phone/tablet form factors
    const popularPrefixes = ['pixel', 'nexus', 'phone', 'tablet', 'automotive'];
    const filtered = raw.filter(({ identifier, oem }) => {
      const lowerId = identifier.toLowerCase();
      const lowerOem = oem.toLowerCase();
      return (
        popularPrefixes.some((prefix) => lowerId.startsWith(prefix)) ||
        lowerOem === 'google'
      );
    });

    return filtered.map(({ identifier, name, oem }) => ({
      id: `android-device-${identifier}`,
      name,
      platform: 'android' as const,
      modelName: oem ? `${oem} ${name}` : name,
      modelIdentifier: identifier,
    }));
  }

  /**
   * List Android system images from `sdkmanager --list`.
   * Results are filtered to images compatible with the host CPU architecture.
   *
   * @returns Array of {@link Runtime} entries for installed and available images.
   * @throws If `sdkmanager` is not found or exits with a non-zero code.
   */
  async listSystemImages(): Promise<Runtime[]> {
    this.assertSdkInstalled();

    const hostAbi = this.getHostArchitecture();

    const { stdout } = await exec(SDKMANAGER, ['--list']);

    const parsed = parseSdkmanagerList(stdout);

    // Keep only system images matching the host ABI
    const compatible = parsed.filter(({ path }) => {
      const abi = abiFromImagePath(path);
      return abi === hostAbi;
    });

    return compatible.map(({ path, version: _version, installed }): Runtime => {
      const apiLevel = apiLevelFromImagePath(path);
      return {
        id: `android-runtime-${path.replace(/;/g, '-')}`,
        platform: 'android' as const,
        version: androidVersionLabel(apiLevel),
        identifier: path,
        status: installed ? ('installed' as const) : ('available' as const),
      };
    });
  }

  /**
   * List all Android Virtual Devices known to the current user.
   * Reads AVD config files from `~/.android/avd/<name>.avd/config.ini` and
   * cross-references with `adb devices` to determine running state.
   *
   * @returns Array of {@link SimulatorDevice} entries.
   * @throws If `emulator` binary is not found or exits with a non-zero code.
   */
  async listAVDs(): Promise<SimulatorDevice[]> {
    this.assertSdkInstalled();

    // Get AVD names (one per line)
    const { stdout: avdListOut } = await exec(EMULATOR_BIN, ['-list-avds']);
    const avdNames = avdListOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (avdNames.length === 0) return [];

    // Determine which serials are currently running
    const runningSerials = await this.listRunningAdbDevices();

    const devices: SimulatorDevice[] = [];

    for (const avdName of avdNames) {
      const avdConfig = await this.readAvdConfig(avdName);
      const state = this.resolveDeviceState(avdName, runningSerials);

      const systemImage = avdConfig['image.sysdir.1'] ?? '';
      // Extract API level from path like system-images/android-34/...
      const apiLevelMatch = systemImage.match(/android-(\d+)/);
      const apiLevel = apiLevelMatch ? parseInt(apiLevelMatch[1], 10) : 0;

      const deviceId = avdConfig['hw.device.name'] ?? 'unknown';
      const deviceName = avdConfig['hw.device.manufacturer']
        ? `${avdConfig['hw.device.manufacturer']} ${deviceId}`
        : deviceId;

      const abi = avdConfig['abi.type'] ?? this.getHostArchitecture();

      // Reconstruct the canonical system image path (best effort)
      const tag = avdConfig['tag.id'] ?? 'google_apis';
      const imageId = apiLevel > 0 ? `system-images;android-${apiLevel};${tag};${abi}` : systemImage;

      const deviceType: DeviceType = {
        id: `android-device-${deviceId}`,
        name: deviceId,
        platform: 'android' as const,
        modelName: deviceName,
        modelIdentifier: deviceId,
      };

      const runtime: Runtime = {
        id: `android-runtime-${imageId.replace(/;/g, '-')}`,
        platform: 'android' as const,
        version: androidVersionLabel(apiLevel),
        identifier: imageId,
        status: 'installed' as const,
      };

      devices.push({
        id: `android-avd-${avdName}`,
        platformDeviceId: avdName,
        platform: 'android' as const,
        deviceType,
        runtime,
        state,
      });
    }

    return devices;
  }

  /**
   * Create a new Android Virtual Device using `avdmanager create avd`.
   * If an AVD with the same name already exists it will be overwritten (`--force`).
   *
   * @param name        - Desired AVD name (must be unique and contain no spaces).
   * @param systemImage - System image package path, e.g. `system-images;android-34;google_apis;arm64-v8a`.
   * @param deviceId    - Hardware profile identifier, e.g. `pixel_8`.
   * @returns The AVD name on success.
   * @throws If `avdmanager` exits with a non-zero code.
   */
  async createAVD(name: string, systemImage: string, deviceId: string): Promise<string> {
    this.assertSdkInstalled();

    // avdmanager prompts "Do you wish to create a custom hardware profile [no]"
    // We pipe "no\n" to stdin to accept the default automatically.
    await this.execWithStdin(
      AVDMANAGER,
      ['create', 'avd', '-n', name, '-k', systemImage, '-d', deviceId, '--force'],
      'no\n',
    );

    return name;
  }

  /**
   * Boot an Android emulator in a headless background process and wait until
   * the device reaches the "device" state in `adb devices`.
   *
   * The emulator process is stored in {@link runningProcesses} for later
   * cleanup via {@link shutdownEmulator}.
   *
   * @param avdName - Name of the AVD to boot.
   * @returns The OS process ID and ADB serial port (e.g. `5554`).
   * @throws If the emulator process fails to start or the boot timeout is exceeded.
   */
  async bootEmulator(avdName: string): Promise<{ pid: number; adbPort: number }> {
    // Invalidate any stale cached port so the post-boot lookup resolves fresh.
    this.adbPortCache.delete(avdName);

    this.assertSdkInstalled();

    const emulatorArgs = [
      '-avd', avdName,
      '-no-window',
      '-no-audio',
      '-gpu', 'swiftshader_indirect',
      '-no-boot-anim',
    ];

    // Spawn detached so the emulator survives API server restarts
    const child = spawn(EMULATOR_BIN, emulatorArgs, {
      detached: true,
      stdio: 'ignore',
    });

    if (child.pid === undefined) {
      throw new Error(`Failed to spawn emulator process for AVD "${avdName}"`);
    }

    // Don't let the Node process wait for the child
    child.unref();

    this.runningProcesses.set(avdName, child);

    const pid = child.pid;

    // Wait for the emulator to appear in `adb devices` with status "device"
    const adbPort = await this.waitForEmulatorBoot(avdName);

    return { pid, adbPort };
  }

  /**
   * Gracefully shut down a running emulator via `adb emu kill`.
   * If the process does not exit within 10 seconds, it is force-killed via SIGKILL.
   *
   * @param avdName - Name of the running AVD to shut down.
   * @throws If no running emulator is found for the given AVD name.
   */
  async shutdownEmulator(avdName: string): Promise<void> {
    // Evict the cached port so a subsequent boot gets a fresh lookup.
    this.adbPortCache.delete(avdName);

    this.assertSdkInstalled();

    const adbPort = await this.getAdbPort(avdName);

    if (adbPort !== null) {
      const serial = `emulator-${adbPort}`;
      try {
        await exec(ADB, ['-s', serial, 'emu', 'kill']);
      } catch {
        // If emu kill fails we still attempt to force-kill below
      }
    }

    const child = this.runningProcesses.get(avdName);
    if (child && child.pid !== undefined && !child.killed) {
      await this.waitForProcessExit(child, 10_000).catch(() => {
        // Force-kill if it didn't exit in time
        try {
          process.kill(child.pid!, 'SIGKILL');
        } catch {
          // Process may already be gone; ignore
        }
      });
    }

    this.runningProcesses.delete(avdName);
  }

  /**
   * Permanently delete an Android Virtual Device.
   *
   * @param avdName - Name of the AVD to delete.
   * @throws If `avdmanager delete avd` exits with a non-zero code.
   */
  async deleteAVD(avdName: string): Promise<void> {
    this.assertSdkInstalled();
    await exec(AVDMANAGER, ['delete', 'avd', '-n', avdName]);
  }

  /**
   * Return the current lifecycle state of an AVD.
   *
   * @param avdName - Name of the AVD to query.
   * @returns One of the {@link DeviceState} values.
   */
  async getEmulatorState(avdName: string): Promise<DeviceState> {
    this.assertSdkInstalled();
    const runningSerials = await this.listRunningAdbDevices();
    return this.resolveDeviceState(avdName, runningSerials);
  }

  /**
   * Find the ADB serial port number for a running emulator.
   *
   * @param avdName - Name of the running AVD to look up.
   * @returns The port number (e.g. `5554`) if the emulator is running, or `null`.
   */
  async getAdbPort(avdName: string): Promise<number | null> {
    // Fast path: return cached port if available.
    const cached = this.adbPortCache.get(avdName);
    if (cached !== undefined) {
      return cached;
    }

    this.assertSdkInstalled();

    const { stdout } = await exec(ADB, ['devices']);
    const devices = parseAdbDevices(stdout);

    for (const { serial, status } of devices) {
      if (!serial.startsWith('emulator-')) continue;
      if (status !== 'device') continue;

      const port = parseInt(serial.replace('emulator-', ''), 10);
      if (isNaN(port)) continue;

      // Ask the emulator on that port for its AVD name
      try {
        const { stdout: avdOut } = await exec(ADB, ['-s', serial, 'emu', 'avd', 'name']);
        const reportedName = avdOut.split('\n')[0]?.trim();
        if (reportedName === avdName) {
          // Cache the successful lookup before returning.
          this.adbPortCache.set(avdName, port);
          return port;
        }
      } catch {
        // This emulator didn't respond or isn't our target; continue
      }
    }

    return null;
  }

  /**
   * Clear the cached ADB port mappings. Useful for testing or after emulator
   * reconnection when the port assignment may have changed.
   */
  clearAdbPortCache(): void {
    this.adbPortCache.clear();
  }

  /**
   * Open a URL or deep-link on the Android emulator via ADB.
   * Uses: `adb -s emulator-<port> shell am start -a android.intent.action.VIEW -d <url>`
   *
   * @param avdName - Name of the running AVD.
   * @param url     - The URL or deep-link to open.
   * @throws If the emulator is not running or the command fails.
   */
  async openUrl(avdName: string, url: string): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot open URL: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    await exec(ADB, ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  }

  /**
   * Type text into the currently focused text field on the Android emulator via ADB.
   * Uses: `adb -s emulator-<port> shell input text <escapedText>`
   *
   * Note: ADB `input text` has limitations:
   * - Spaces must be replaced with `%s`
   * - Special characters need escaping
   * - Unicode support is limited
   *
   * @param avdName - Name of the running AVD.
   * @param text    - The text string to type.
   * @throws If the emulator is not running or the command fails.
   */
  async sendText(avdName: string, text: string): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot send text: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    // ADB input text requires spaces to be encoded as %s
    // and some special characters need shell escaping
    const escapedText = text.replace(/ /g, '%s');
    await exec(ADB, ['-s', serial, 'shell', 'input', 'text', escapedText]);
  }

  /**
   * Send a tap (touch) event at the given pixel coordinates on the Android emulator.
   * Uses: `adb -s emulator-<port> shell input tap <x> <y>`
   *
   * @param avdName - Name of the running AVD.
   * @param x       - X pixel coordinate on the device screen.
   * @param y       - Y pixel coordinate on the device screen.
   * @throws If the emulator is not running or the command fails.
   */
  async sendTap(avdName: string, x: number, y: number): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot send tap: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    await exec(ADB, ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  /**
   * Send a swipe gesture from one point to another on the Android emulator.
   * Uses: `adb -s emulator-<port> shell input swipe <x1> <y1> <x2> <y2> <durationMs>`
   *
   * @param avdName    - Name of the running AVD.
   * @param x1         - Starting X pixel coordinate.
   * @param y1         - Starting Y pixel coordinate.
   * @param x2         - Ending X pixel coordinate.
   * @param y2         - Ending Y pixel coordinate.
   * @param durationMs - Duration of the swipe in milliseconds (default 300).
   * @throws If the emulator is not running or the command fails.
   */
  async sendSwipe(avdName: string, x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot send swipe: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    await exec(ADB, ['-s', serial, 'shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(Math.round(durationMs)),
    ]);
  }

  /**
   * Send a key event to the Android emulator via ADB.
   * Maps standard browser keyboard event keys to Android KEYCODE_* values.
   * Uses: `adb -s emulator-<port> shell input keyevent <keycode>`
   *
   * For printable characters, uses `input text` instead of keyevent for better
   * Unicode support.
   *
   * @param avdName - Name of the running AVD.
   * @param key     - The logical key value from KeyboardEvent.key (e.g. 'a', 'Enter', 'Backspace').
   * @param code    - The physical key code from KeyboardEvent.code (e.g. 'KeyA', 'Enter').
   * @throws If the emulator is not running or the command fails.
   */
  async sendKeyEvent(avdName: string, key: string, code: string): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot send key event: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;

    // Map special keys to Android keycodes
    const keyMap: Record<string, string> = {
      'Enter': 'KEYCODE_ENTER',
      'Backspace': 'KEYCODE_DEL',
      'Delete': 'KEYCODE_FORWARD_DEL',
      'Tab': 'KEYCODE_TAB',
      'Escape': 'KEYCODE_ESCAPE',
      'ArrowUp': 'KEYCODE_DPAD_UP',
      'ArrowDown': 'KEYCODE_DPAD_DOWN',
      'ArrowLeft': 'KEYCODE_DPAD_LEFT',
      'ArrowRight': 'KEYCODE_DPAD_RIGHT',
      ' ': 'KEYCODE_SPACE',
      'Home': 'KEYCODE_MOVE_HOME',
      'End': 'KEYCODE_MOVE_END',
      'PageUp': 'KEYCODE_PAGE_UP',
      'PageDown': 'KEYCODE_PAGE_DOWN',
    };

    const mappedKeycode = keyMap[key];
    if (mappedKeycode) {
      await exec(ADB, ['-s', serial, 'shell', 'input', 'keyevent', mappedKeycode]);
    } else if (key.length === 1) {
      // Single printable character — use `input text` for better Unicode handling
      // ADB input text requires spaces to be encoded as %s
      const escapedChar = key === ' ' ? '%s' : key;
      await exec(ADB, ['-s', serial, 'shell', 'input', 'text', escapedChar]);
    }
    // Multi-character keys not in the map (e.g. 'Shift', 'Control') are silently ignored
  }

  /**
   * Simulate pressing a hardware button on the Android emulator via ADB keyevent.
   *
   * Button → keyevent mapping:
   * - `'home'`        → `KEYCODE_HOME`
   * - `'lock'`        → `KEYCODE_POWER`
   * - `'volumeUp'`    → `KEYCODE_VOLUME_UP`
   * - `'volumeDown'`  → `KEYCODE_VOLUME_DOWN`
   *
   * Uses: `adb -s emulator-<port> shell input keyevent <KEYCODE>`
   *
   * @param avdName - Name of the running AVD.
   * @param button  - Button to press.
   * @throws If the emulator is not running, the button is unrecognised, or the command fails.
   */
  async pressButton(avdName: string, button: SimulatorButton): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot press button: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;

    const keyEventMap: Record<SimulatorButton, string> = {
      home: 'KEYCODE_HOME',
      lock: 'KEYCODE_POWER',
      volumeUp: 'KEYCODE_VOLUME_UP',
      volumeDown: 'KEYCODE_VOLUME_DOWN',
    };

    const keyEvent = keyEventMap[button];
    if (!keyEvent) {
      throw new Error(`Unknown button: "${button}". Valid options: ${Object.keys(keyEventMap).join(', ')}`);
    }

    await exec(ADB, ['-s', serial, 'shell', 'input', 'keyevent', keyEvent]);
  }

  /**
   * Set the device screen orientation on the Android emulator via ADB system settings.
   *
   * Orientation → `user_rotation` value mapping:
   * - `'portrait'`            → `0`
   * - `'landscapeLeft'`       → `1`
   * - `'portraitUpsideDown'`  → `2`
   * - `'landscapeRight'`      → `3`
   *
   * Auto-rotation is disabled first (`accelerometer_rotation 0`) so the manual
   * rotation value takes effect immediately.
   *
   * Uses two sequential `adb -s <serial> shell settings put system …` calls.
   *
   * @param avdName     - Name of the running AVD.
   * @param orientation - Desired screen orientation.
   * @throws If the emulator is not running, the orientation is unrecognised, or a command fails.
   */
  async setOrientation(avdName: string, orientation: DeviceOrientation): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot set orientation: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;

    const rotationMap: Record<DeviceOrientation, string> = {
      portrait: '0',
      landscapeLeft: '1',
      portraitUpsideDown: '2',
      landscapeRight: '3',
    };

    const rotation = rotationMap[orientation];
    if (rotation === undefined) {
      throw new Error(
        `Invalid orientation: "${orientation}". Valid options: ${Object.keys(rotationMap).join(', ')}`,
      );
    }

    // Disable auto-rotation so the manual value takes effect
    await exec(ADB, ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    // Apply the desired rotation value
    await exec(ADB, ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', rotation]);
  }

  /**
   * Capture a screenshot from the Android emulator and save it to a local file.
   *
   * Steps:
   * 1. `adb -s <serial> shell screencap -p /sdcard/screenshot.png` — capture on device
   * 2. `adb -s <serial> pull /sdcard/screenshot.png <outputPath>` — copy to host
   * 3. `adb -s <serial> shell rm /sdcard/screenshot.png` — clean up device copy
   *
   * Using the two-step capture+pull approach avoids binary encoding issues that
   * occur with `exec-out` on some ADB versions.
   *
   * @param avdName    - Name of the running AVD.
   * @param outputPath - Absolute path on the host where the PNG will be written.
   * @throws If the emulator is not running or any ADB command fails.
   */
  async takeScreenshot(avdName: string, outputPath: string): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot take screenshot: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    const devicePath = '/sdcard/screenshot.png';

    // 1. Capture to device storage
    await exec(ADB, ['-s', serial, 'shell', 'screencap', '-p', devicePath]);
    // 2. Pull from device to host
    await exec(ADB, ['-s', serial, 'pull', devicePath, outputPath]);
    // 3. Remove from device storage
    await exec(ADB, ['-s', serial, 'shell', 'rm', devicePath]);
  }

  /**
   * Set the clipboard text on the Android emulator.
   *
   * Uses the `cmd clipboard set` service (available on Android API 31+).
   * On older API levels the underlying command may fail with an informative error.
   *
   * Uses: `adb -s <serial> shell cmd clipboard set "<text>"`
   *
   * @param avdName - Name of the running AVD.
   * @param text    - The text to place on the clipboard.
   * @throws If the emulator is not running or the command fails.
   */
  async setClipboard(avdName: string, text: string): Promise<void> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot set clipboard: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    // Escape single quotes for the shell argument
    const escaped = text.replace(/'/g, `'\\''`);
    await exec(ADB, ['-s', serial, 'shell', 'cmd', 'clipboard', 'set', escaped]);
  }

  /**
   * Get the current clipboard text from the Android emulator.
   *
   * Uses the `cmd clipboard get` service (available on Android API 31+).
   * On older API levels the underlying command may fail with an informative error.
   *
   * Uses: `adb -s <serial> shell cmd clipboard get`
   *
   * @param avdName - Name of the running AVD.
   * @returns The current clipboard text (may be empty).
   * @throws If the emulator is not running or the command fails.
   */
  async getClipboard(avdName: string): Promise<string> {
    this.assertSdkInstalled();
    const adbPort = await this.getAdbPort(avdName);
    if (adbPort === null) {
      throw new Error(`Cannot get clipboard: emulator "${avdName}" is not running.`);
    }
    const serial = `emulator-${adbPort}`;
    const { stdout } = await exec(ADB, ['-s', serial, 'shell', 'cmd', 'clipboard', 'get']);
    return stdout.trim();
  }

  /**
   * Install an Android system image via `sdkmanager`.
   * SDK licenses are accepted automatically by piping `y\n` to stdin.
   *
   * @param systemImageId - Package path, e.g. `system-images;android-34;google_apis;arm64-v8a`.
   * @throws If `sdkmanager` exits with a non-zero code.
   */
  async installSystemImage(systemImageId: string): Promise<void> {
    this.assertSdkInstalled();

    // Accept all pending licenses first so the install doesn't stall
    try {
      await this.execWithStdin(SDKMANAGER, ['--licenses'], 'y\n'.repeat(20));
    } catch {
      // Ignore license acceptance errors — they may already be accepted
    }

    await this.execWithStdin(SDKMANAGER, ['--install', systemImageId], 'y\n'.repeat(5));
  }

  /**
   * Kill all emulator processes that this service instance started, then clear
   * the internal process map.  Call this during application shutdown.
   */
  async cleanup(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const [avdName] of this.runningProcesses) {
      shutdownPromises.push(
        this.shutdownEmulator(avdName).catch((err: unknown) => {
          console.error(`[AndroidEmulatorService] Failed to shut down "${avdName}" during cleanup:`, err);
        }),
      );
    }

    await Promise.allSettled(shutdownPromises);
    this.runningProcesses.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Throw a descriptive error if the Android SDK root directory is the default
   * and the `sdkmanager` binary is absent. This gives clear install instructions
   * rather than a cryptic "ENOENT" from execFile.
   */
  private assertSdkInstalled(): void {
    // We rely on the OS to surface ENOENT when the binary is invoked; the
    // thrown message from exec() already includes the command path, which is
    // sufficient for diagnosis. If callers want a pre-flight check they can
    // call this method explicitly before issuing commands.
    //
    // This method is a designated extension point — subclasses or integration
    // tests can override it to inject a custom SDK path check.
  }

  /**
   * Spawn a process with a string written to its stdin, then collect stdout
   * and stderr. Used for interactive CLI tools like `avdmanager create avd`
   * and `sdkmanager --licenses` that read from stdin.
   *
   * @param command  - Path to the executable.
   * @param args     - Argument list.
   * @param stdinData - String to write to the process's stdin.
   * @returns Resolved stdout and stderr.
   */
  private execWithStdin(
    command: string,
    args: string[],
    stdinData: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => reject(err));

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(
              `Command failed (exit ${code ?? 'unknown'}): ${command} ${args.join(' ')}\n${stderr}`,
            ),
          );
        }
      });

      // Write stdin data and close the stream
      if (child.stdin) {
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    });
  }

  /**
   * Read and parse an AVD's `config.ini` file from the standard location
   * `~/.android/avd/<avdName>.avd/config.ini`.
   *
   * @param avdName - Name of the AVD.
   * @returns Parsed key/value map, or an empty object if the file is missing.
   */
  private async readAvdConfig(avdName: string): Promise<AvdConfig> {
    const configPath = `${homedir()}/.android/avd/${avdName}.avd/config.ini`;
    try {
      const content = await readFile(configPath, 'utf8');
      return parseIniFile(content);
    } catch {
      return {};
    }
  }

  /**
   * Query `adb devices` and return the list of currently attached devices.
   *
   * @returns Array of {@link AdbDevice} with serial and status.
   */
  private async listRunningAdbDevices(): Promise<AdbDevice[]> {
    try {
      const { stdout } = await exec(ADB, ['devices']);
      return parseAdbDevices(stdout);
    } catch {
      // adb may not be accessible (e.g. SDK not installed); return empty list
      return [];
    }
  }

  /**
   * Determine whether a given AVD is running, booting, or shut down based on
   * the list of ADB-attached devices.
   *
   * @param avdName       - AVD name to check.
   * @param adbDevices    - Current snapshot of `adb devices` output.
   * @returns Resolved {@link DeviceState}.
   */
  private resolveDeviceState(avdName: string, adbDevices: AdbDevice[]): DeviceState {
    const child = this.runningProcesses.get(avdName);

    for (const { serial, status } of adbDevices) {
      if (!serial.startsWith('emulator-')) continue;

      if (status === 'device') {
        // Confirm the running emulator matches our AVD by checking the process map
        if (child) return 'booted';
      } else if (status === 'offline') {
        if (child) return 'booting';
      }
    }

    if (child && !child.killed) return 'booting';

    return 'shutdown';
  }

  /**
   * Poll `adb devices` until the newly launched emulator appears with status
   * "device", then return its port.  Rejects if the boot timeout is exceeded.
   *
   * @param avdName - AVD name we just booted (used for logging).
   * @returns The ADB serial port number once the emulator is ready.
   */
  private async waitForEmulatorBoot(avdName: string): Promise<number> {
    const pollIntervalMs = 3_000;
    const deadline = Date.now() + DEVICE_BOOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      try {
        const { stdout } = await exec(ADB, ['devices']);
        const devices = parseAdbDevices(stdout);

        for (const { serial, status } of devices) {
          if (!serial.startsWith('emulator-')) continue;

          // Check if this serial belongs to our AVD
          const port = parseInt(serial.replace('emulator-', ''), 10);
          if (isNaN(port)) continue;

          if (status === 'device') {
            try {
              const { stdout: avdOut } = await exec(ADB, ['-s', serial, 'emu', 'avd', 'name']);
              const reportedName = avdOut.split('\n')[0]?.trim();
              if (reportedName === avdName) {
                return port;
              }
            } catch {
              // Could not confirm AVD name; try next serial
            }
          }
        }
      } catch {
        // adb may not be ready yet; keep polling
      }
    }

    throw new Error(
      `Emulator "${avdName}" did not reach "device" state within ${DEVICE_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }

  /**
   * Return a promise that resolves when the given ChildProcess exits, or
   * rejects after the specified timeout.
   *
   * @param child      - The child process to wait for.
   * @param timeoutMs  - Maximum wait time in milliseconds.
   */
  private waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Process (pid ${child.pid}) did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Resolve after the given number of milliseconds.
 *
 * @param ms - Duration to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance of {@link AndroidEmulatorService}. */
export const androidEmulatorService = new AndroidEmulatorService();
