import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config before importing the service so ADB_PATH is deterministic
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  config: {
    androidSdkRoot: '/mock/android/sdk',
  },
}));

// ---------------------------------------------------------------------------
// Mock exec utilities before importing the service
// ---------------------------------------------------------------------------

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execJSON: vi.fn(),
}));

import { AppInstallService } from './app-install.js';
import { exec } from '../utils/exec.js';

const mockExec = vi.mocked(exec);

// ---------------------------------------------------------------------------
// Constants derived from the mocked config
// ---------------------------------------------------------------------------

const ADB_PATH = '/mock/android/sdk/platform-tools/adb';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppInstallService', () => {
  let service: AppInstallService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AppInstallService();
  });

  // -------------------------------------------------------------------------
  // validateExtension()
  // -------------------------------------------------------------------------

  describe('validateExtension()', () => {
    it('returns true for .app on iOS', () => {
      expect(service.validateExtension('MyApp.app', 'ios')).toBe(true);
    });

    it('returns true for .ipa on iOS', () => {
      expect(service.validateExtension('MyApp.ipa', 'ios')).toBe(true);
    });

    it('returns false for .apk on iOS', () => {
      expect(service.validateExtension('MyApp.apk', 'ios')).toBe(false);
    });

    it('returns true for .apk on Android', () => {
      expect(service.validateExtension('MyApp.apk', 'android')).toBe(true);
    });

    it('returns false for .app on Android', () => {
      expect(service.validateExtension('MyApp.app', 'android')).toBe(false);
    });

    it('returns false for .ipa on Android', () => {
      expect(service.validateExtension('MyApp.ipa', 'android')).toBe(false);
    });

    it('returns true for .APP (uppercase) on iOS — case insensitive', () => {
      expect(service.validateExtension('MyApp.APP', 'ios')).toBe(true);
    });

    it('returns true for .IPA (uppercase) on iOS — case insensitive', () => {
      expect(service.validateExtension('MyApp.IPA', 'ios')).toBe(true);
    });

    it('returns true for .APK (uppercase) on Android — case insensitive', () => {
      expect(service.validateExtension('MyApp.APK', 'android')).toBe(true);
    });

    it('returns false for .txt on iOS', () => {
      expect(service.validateExtension('document.txt', 'ios')).toBe(false);
    });

    it('returns false for .txt on Android', () => {
      expect(service.validateExtension('document.txt', 'android')).toBe(false);
    });

    it('returns false for a file with no extension on iOS', () => {
      expect(service.validateExtension('MyApp', 'ios')).toBe(false);
    });

    it('returns false for a file with no extension on Android', () => {
      expect(service.validateExtension('MyApp', 'android')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // installApp() — iOS
  // -------------------------------------------------------------------------

  describe('installApp() — iOS', () => {
    const IOS_UDID = 'AAAAAAAA-0000-0000-0000-000000000001';
    const FILE_PATH = '/tmp/uploads/MyApp.app';

    it('successfully installs a .app file and returns success: true', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(result.success).toBe(true);
    });

    it('calls exec with correct xcrun simctl install arguments for .app', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(mockExec).toHaveBeenCalledOnce();
      expect(mockExec).toHaveBeenCalledWith('xcrun', ['simctl', 'install', IOS_UDID, FILE_PATH]);
    });

    it('successfully installs a .ipa file and calls exec with correct args', async () => {
      // Arrange
      const ipaPath = '/tmp/uploads/MyApp.ipa';
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.installApp(ipaPath, 'ios', IOS_UDID, 'MyApp.ipa');

      // Assert
      expect(result.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith('xcrun', ['simctl', 'install', IOS_UDID, ipaPath]);
    });

    it('returns installDurationMs >= 0 on successful install', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns correct fileName and platform on success', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(result.fileName).toBe('MyApp.app');
      expect(result.platform).toBe('ios');
    });

    it('does NOT throw when exec fails — returns success: false with error message', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('simctl install failed: device not found'));

      // Act — must not throw
      const result = await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain('simctl install failed: device not found');
    });

    it('returns installDurationMs on exec failure', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('Command failed'));

      // Act
      const result = await service.installApp(FILE_PATH, 'ios', IOS_UDID, 'MyApp.app');

      // Assert
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns success: false and does NOT call exec for invalid extension (.apk on iOS)', async () => {
      // Arrange — no mock needed since exec should never be called

      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.apk',
        'ios',
        IOS_UDID,
        'MyApp.apk',
      );

      // Assert
      expect(result.success).toBe(false);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('includes a descriptive error message when extension is invalid for iOS', async () => {
      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.apk',
        'ios',
        IOS_UDID,
        'MyApp.apk',
      );

      // Assert — message should mention the platform and allowed extensions
      expect(result.message).toMatch(/ios/i);
      expect(result.message.toLowerCase()).toMatch(/\.app|\.ipa/);
    });
  });

  // -------------------------------------------------------------------------
  // installApp() — Android
  // -------------------------------------------------------------------------

  describe('installApp() — Android', () => {
    const ADB_SERIAL = 'emulator-5554';
    const APK_PATH = '/tmp/uploads/MyApp.apk';

    it('successfully installs a .apk file and returns success: true', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: 'Success', stderr: '' });

      // Act
      const result = await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(result.success).toBe(true);
    });

    it('calls exec with correct adb install arguments for .apk', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: 'Success', stderr: '' });

      // Act
      await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(mockExec).toHaveBeenCalledOnce();
      expect(mockExec).toHaveBeenCalledWith(ADB_PATH, [
        '-s',
        ADB_SERIAL,
        'install',
        '-r',
        APK_PATH,
      ]);
    });

    it('returns correct fileName and platform on success', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: 'Success', stderr: '' });

      // Act
      const result = await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(result.fileName).toBe('MyApp.apk');
      expect(result.platform).toBe('android');
    });

    it('returns installDurationMs >= 0 on successful install', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: 'Success', stderr: '' });

      // Act
      const result = await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('does NOT throw when exec fails — returns success: false with error message', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('adb: device offline'));

      // Act — must not throw
      const result = await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain('adb: device offline');
    });

    it('returns installDurationMs on exec failure', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('Command failed'));

      // Act
      const result = await service.installApp(APK_PATH, 'android', ADB_SERIAL, 'MyApp.apk');

      // Assert
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns success: false and does NOT call exec for invalid extension (.ipa on Android)', async () => {
      // Arrange — no mock needed since exec should never be called

      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.ipa',
        'android',
        ADB_SERIAL,
        'MyApp.ipa',
      );

      // Assert
      expect(result.success).toBe(false);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('returns success: false and does NOT call exec for .app on Android', async () => {
      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.app',
        'android',
        ADB_SERIAL,
        'MyApp.app',
      );

      // Assert
      expect(result.success).toBe(false);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('includes a descriptive error message when extension is invalid for Android', async () => {
      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.ipa',
        'android',
        ADB_SERIAL,
        'MyApp.ipa',
      );

      // Assert — message should mention the platform and allowed extensions
      expect(result.message).toMatch(/android/i);
      expect(result.message.toLowerCase()).toContain('.apk');
    });
  });

  // -------------------------------------------------------------------------
  // installApp() — edge cases
  // -------------------------------------------------------------------------

  describe('installApp() — edge cases', () => {
    it('returns success: false when exec throws a non-Error string value', async () => {
      // Arrange — throw a raw string, not an Error instance
      mockExec.mockRejectedValueOnce('INSTALL_FAILED_INSUFFICIENT_STORAGE');

      // Act — must not throw
      const result = await service.installApp(
        '/tmp/MyApp.apk',
        'android',
        'emulator-5554',
        'MyApp.apk',
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE');
    });

    it('installDurationMs is always a non-negative number on success', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.installApp(
        '/tmp/MyApp.app',
        'ios',
        'BBBBBBBB-0000-0000-0000-000000000002',
        'MyApp.app',
      );

      // Assert
      expect(typeof result.installDurationMs).toBe('number');
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('installDurationMs is always a non-negative number on failure', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('network error'));

      // Act
      const result = await service.installApp(
        '/tmp/MyApp.apk',
        'android',
        'emulator-5554',
        'MyApp.apk',
      );

      // Assert
      expect(typeof result.installDurationMs).toBe('number');
      expect(result.installDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('preserves original fileName in the result even when exec fails', async () => {
      // Arrange
      const originalFileName = 'MySpecialApp_v2.3.1.apk';
      mockExec.mockRejectedValueOnce(new Error('install failed'));

      // Act
      const result = await service.installApp(
        '/tmp/uploads/MySpecialApp_v2.3.1.apk',
        'android',
        'emulator-5554',
        originalFileName,
      );

      // Assert
      expect(result.fileName).toBe(originalFileName);
    });

    it('preserves original fileName in the result when extension validation fails', async () => {
      // Arrange
      const originalFileName = 'MyApp.exe';

      // Act
      const result = await service.installApp(
        '/tmp/uploads/MyApp.exe',
        'ios',
        'AAAAAAAA-0000-0000-0000-000000000001',
        originalFileName,
      );

      // Assert
      expect(result.fileName).toBe(originalFileName);
    });

    it('exec is called exactly once per successful install (no retries)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: 'Success', stderr: '' });

      // Act
      await service.installApp('/tmp/MyApp.apk', 'android', 'emulator-5554', 'MyApp.apk');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('exec is called exactly once per failed install (no retries)', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('install failed'));

      // Act
      await service.installApp('/tmp/MyApp.apk', 'android', 'emulator-5554', 'MyApp.apk');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('installDurationMs is absent when extension validation fails (no timing started)', async () => {
      // Arrange — extension is invalid, so timing should not be measured
      const result = await service.installApp(
        '/tmp/MyApp.apk',
        'ios',
        'AAAAAAAA-0000-0000-0000-000000000001',
        'MyApp.apk',
      );

      // Assert — per the source, installDurationMs is not set on early validation exit
      expect(result.installDurationMs).toBeUndefined();
    });

    it('returns platform field matching the requested platform on validation failure', async () => {
      // Arrange — .txt is invalid for both platforms
      const iosResult = await service.installApp('/tmp/file.txt', 'ios', 'some-udid', 'file.txt');
      const androidResult = await service.installApp(
        '/tmp/file.txt',
        'android',
        'emulator-5554',
        'file.txt',
      );

      // Assert
      expect(iosResult.platform).toBe('ios');
      expect(androidResult.platform).toBe('android');
    });
  });
});
