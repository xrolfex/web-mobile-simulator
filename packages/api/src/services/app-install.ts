import { extname } from 'node:path';
import { exec } from '../utils/exec.js';
import { config } from '../config.js';
import type { Platform, AppInstallResult } from '@web-mobile-simulator/shared';
import { ALLOWED_APP_EXTENSIONS } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// SDK tool paths derived from config
// ---------------------------------------------------------------------------

const ADB_PATH = `${config.androidSdkRoot}/platform-tools/adb`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[AppInstallService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Installs app files (.app / .ipa / .apk) onto running iOS Simulators or
 * Android Emulators.
 *
 * All public methods are `async`.  `installApp` never throws — errors are
 * captured and returned as `{ success: false }` results.  Export the
 * singleton `appInstallService` rather than constructing instances directly.
 */
export class AppInstallService {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Install an app file onto a running simulator or emulator.
   *
   * Validates the file extension for the given platform, delegates to the
   * platform-specific install method, and measures installation duration.
   *
   * @param filePath         - Absolute path to the uploaded file on disk.
   * @param platform         - Target platform: `'ios'` or `'android'`.
   * @param platformDeviceId - iOS simulator UDID or Android ADB serial
   *                           (e.g. `"emulator-5554"`).
   * @param fileName         - Original filename used for display and logging.
   * @returns A resolved `AppInstallResult` — never throws.
   */
  async installApp(
    filePath: string,
    platform: Platform,
    platformDeviceId: string,
    fileName: string,
  ): Promise<AppInstallResult> {
    log(`Installing "${fileName}" on ${platform} device "${platformDeviceId}"…`);

    // Validate file extension before attempting install
    if (!this.validateExtension(fileName, platform)) {
      const allowed = ALLOWED_APP_EXTENSIONS[platform].join(', ');
      const message = `Invalid file extension for platform "${platform}". Allowed: ${allowed}`;
      warn(message);
      return { success: false, fileName, platform, message };
    }

    const startMs = Date.now();

    try {
      if (platform === 'ios') {
        await this.installIOSApp(filePath, platformDeviceId);
      } else {
        await this.installAndroidApp(filePath, platformDeviceId);
      }

      const installDurationMs = Date.now() - startMs;
      const message = `Successfully installed "${fileName}" on ${platform} device "${platformDeviceId}" in ${installDurationMs}ms`;
      log(message);

      return { success: true, fileName, platform, message, installDurationMs };
    } catch (error: unknown) {
      const installDurationMs = Date.now() - startMs;
      const message = `Failed to install "${fileName}" on ${platform} device "${platformDeviceId}": ${String(error)}`;
      warn(message);

      return { success: false, fileName, platform, message, installDurationMs };
    }
  }

  /**
   * Validate that a filename's extension is allowed for the given platform.
   *
   * @param fileName - Original filename (e.g. `"MyApp.ipa"`).
   * @param platform - Target platform: `'ios'` or `'android'`.
   * @returns `true` if the extension is permitted; `false` otherwise.
   */
  validateExtension(fileName: string, platform: Platform): boolean {
    const ext = extname(fileName).toLowerCase();
    return ALLOWED_APP_EXTENSIONS[platform].includes(ext);
  }

  // -------------------------------------------------------------------------
  // Private platform-specific install methods
  // -------------------------------------------------------------------------

  /**
   * Install an iOS app bundle onto a running simulator using `xcrun simctl`.
   * Runs: `xcrun simctl install <udid> <filePath>`
   *
   * @param filePath - Absolute path to the `.app` or `.ipa` file.
   * @param udid     - UDID of the target iOS simulator.
   * @throws If `simctl install` exits with a non-zero code.
   */
  private async installIOSApp(filePath: string, udid: string): Promise<void> {
    log(`Running: xcrun simctl install ${udid} ${filePath}`);
    await exec('xcrun', ['simctl', 'install', udid, filePath]);
    log(`xcrun simctl install completed for UDID: ${udid}`);
  }

  /**
   * Install an Android APK onto a running emulator using `adb`.
   * Runs: `adb -s <adbSerial> install -r <filePath>`
   *
   * The `-r` flag allows replacing an already-installed version of the app.
   *
   * @param filePath  - Absolute path to the `.apk` file.
   * @param adbSerial - ADB device serial (e.g. `"emulator-5554"`).
   * @throws If `adb install` exits with a non-zero code.
   */
  private async installAndroidApp(filePath: string, adbSerial: string): Promise<void> {
    log(`Running: adb -s ${adbSerial} install -r ${filePath}`);
    await exec(ADB_PATH, ['-s', adbSerial, 'install', '-r', filePath]);
    log(`adb install completed for serial: ${adbSerial}`);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const appInstallService = new AppInstallService();
