import { describe, it, expect, vi, beforeEach } from 'vitest';
import { arch } from 'node:os';

// ---------------------------------------------------------------------------
// Mock the exec utilities before importing the service
// ---------------------------------------------------------------------------

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execJSON: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process to prevent real process spawning in createAVD / bootEmulator
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      killed: false,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      unref: vi.fn(),
    }),
  };
});

import { AndroidEmulatorService } from './android-emulator.js';
import { exec } from '../utils/exec.js';

const mockExec = exec as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Sample CLI output — realistic data from real Android SDK tools
// ---------------------------------------------------------------------------

// The parseAvdmanagerDevices parser splits on blank lines (\n\s*\n), so device
// blocks must be separated by blank lines — NOT by "--------" separators.
const SAMPLE_AVDMANAGER_DEVICE_LIST = `id: 0 or "pixel"
    Name: Pixel
    OEM : Google

id: 1 or "pixel_2"
    Name: Pixel 2
    OEM : Google

id: 2 or "pixel_5"
    Name: Pixel 5
    OEM : Google

id: 3 or "nexus_5"
    Name: Nexus 5
    OEM : Google

id: 4 or "pixel_8"
    Name: Pixel 8
    OEM : Google

id: 5 or "pixel_tablet"
    Name: Pixel Tablet
    OEM : Google

id: 6 or "automotive_1024p_landscape"
    Name: Automotive (1024p landscape)
    OEM : Generic

id: 7 or "tv_1080p"
    Name: Android TV (1080p)
    OEM : Generic

id: 8 or "wear_round"
    Name: Android Wear Round
    OEM : Generic
`;

const SAMPLE_SDKMANAGER_LIST_OUTPUT = `Installed packages:
  Path                                                | Version | Description
  -------                                             | ------- | -------
  system-images;android-34;google_apis;arm64-v8a      | 14      | Google APIs ARM 64 v8a System Image
  system-images;android-33;google_apis;arm64-v8a      | 7       | Google APIs ARM 64 v8a System Image
  system-images;android-34;google_apis;x86_64         | 14      | Google APIs Intel x86_64 Atom System Image

Available Packages:
  Path                                                | Version | Description
  -------                                             | ------- | -------
  system-images;android-35;google_apis;arm64-v8a      | 1       | Google APIs ARM 64 v8a System Image
  system-images;android-35;google_apis;x86_64         | 1       | Google APIs Intel x86_64 Atom System Image
  system-images;android-28;google_apis;arm64-v8a      | 4       | Google APIs ARM 64 v8a System Image
`;

const SAMPLE_ADB_DEVICES = `List of devices attached
emulator-5554\tdevice
emulator-5556\toffline
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AndroidEmulatorService', () => {
  let service: AndroidEmulatorService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AndroidEmulatorService();
  });

  // -------------------------------------------------------------------------
  // getHostArchitecture()
  // -------------------------------------------------------------------------

  describe('getHostArchitecture()', () => {
    it('returns "arm64-v8a" on Apple Silicon (arm64)', () => {
      // The real arch() on M-series Macs returns 'arm64'
      if (arch() === 'arm64') {
        const result = service.getHostArchitecture();
        expect(result).toBe('arm64-v8a');
      } else {
        // On x86_64 hosts, skip this specific assertion
        expect(['arm64-v8a', 'x86_64']).toContain(service.getHostArchitecture());
      }
    });

    it('returns "x86_64" on Intel (x86_64)', () => {
      if (arch() !== 'arm64') {
        const result = service.getHostArchitecture();
        expect(result).toBe('x86_64');
      } else {
        expect(['arm64-v8a', 'x86_64']).toContain(service.getHostArchitecture());
      }
    });

    it('returns one of the two known ABI strings regardless of host', () => {
      const result = service.getHostArchitecture();
      expect(['arm64-v8a', 'x86_64']).toContain(result);
    });
  });

  // -------------------------------------------------------------------------
  // listDeviceTypes() — tests the parseAvdmanagerDevices parser indirectly
  // -------------------------------------------------------------------------

  describe('listDeviceTypes()', () => {
    it('parses avdmanager output and returns DeviceType entries', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      expect(result.length).toBeGreaterThan(0);
    });

    it('filters results to popular Pixel/Nexus/phone/tablet/automotive devices', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      const names = result.map((d) => d.name);

      // TV and Wear should be excluded (not popular Pixel/Google devices by prefix)
      // TV and Wear pass through if OEM is Google — let's check what actually comes back
      // The filter checks: starts with popular prefix OR oem === 'google'
      // Both TV and Wear have OEM: Generic — so they should be excluded
      expect(names).not.toContain('Android TV (1080p)');
      expect(names).not.toContain('Android Wear Round');
    });

    it('includes Pixel devices', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      const names = result.map((d) => d.name);
      expect(names).toContain('Pixel 8');
    });

    it('includes Nexus devices', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      const names = result.map((d) => d.name);
      expect(names).toContain('Nexus 5');
    });

    it('sets platform to "android" for all results', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      expect(result.every((d) => d.platform === 'android')).toBe(true);
    });

    it('constructs id as "android-device-<identifier>"', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      const pixel8 = result.find((d) => d.modelIdentifier === 'pixel_8');
      expect(pixel8!.id).toBe('android-device-pixel_8');
    });

    it('sets modelName as "OEM Name" when OEM is present', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      const pixel = result.find((d) => d.modelIdentifier === 'pixel');
      expect(pixel!.modelName).toBe('Google Pixel');
    });

    it('handles empty avdmanager output gracefully', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.listDeviceTypes();

      expect(result).toHaveLength(0);
    });

    it('falls back to verbose listing when compact listing fails', async () => {
      // First call (compact -c) fails; second call (verbose) succeeds
      mockExec
        .mockRejectedValueOnce(new Error('unknown flag: -c'))
        .mockResolvedValueOnce({ stdout: SAMPLE_AVDMANAGER_DEVICE_LIST, stderr: '' });

      const result = await service.listDeviceTypes();

      expect(result.length).toBeGreaterThan(0);
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it('propagates errors from exec when both compact and verbose fail', async () => {
      mockExec
        .mockRejectedValueOnce(new Error('avdmanager not found'))
        .mockRejectedValueOnce(new Error('avdmanager not found'));

      await expect(service.listDeviceTypes()).rejects.toThrow('avdmanager not found');
    });
  });

  // -------------------------------------------------------------------------
  // listSystemImages() — tests parseSdkmanagerList, apiLevelFromImagePath,
  //                      abiFromImagePath, androidVersionLabel indirectly
  // -------------------------------------------------------------------------

  describe('listSystemImages()', () => {
    it('returns only system images matching the host ABI', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const hostAbi = service.getHostArchitecture();
      const result = await service.listSystemImages();

      // Every returned runtime identifier should contain the host ABI
      for (const rt of result) {
        expect(rt.identifier).toContain(hostAbi);
      }
    });

    it('sets platform to "android" for all results', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const result = await service.listSystemImages();

      expect(result.every((rt) => rt.platform === 'android')).toBe(true);
    });

    it('maps installed images to status "installed"', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const _hostAbi = service.getHostArchitecture();
      const result = await service.listSystemImages();

      // arm64-v8a android-34 and android-33 are in the Installed section
      const installed = result.filter((rt) => rt.status === 'installed');
      expect(installed.length).toBeGreaterThan(0);
    });

    it('maps available-only images to status "available"', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const result = await service.listSystemImages();

      const available = result.filter((rt) => rt.status === 'available');
      expect(available.length).toBeGreaterThan(0);
    });

    it('uses the androidVersionLabel mapping for known API levels', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const result = await service.listSystemImages();

      const android34 = result.find((rt) => rt.identifier.includes('android-34'));
      // API 34 maps to "Android 14 (API 34)"
      if (android34) {
        expect(android34.version).toBe('Android 14 (API 34)');
      }
    });

    it('constructs runtime id as "android-runtime-<path-with-dashes>"', async () => {
      mockExec.mockResolvedValue({ stdout: SAMPLE_SDKMANAGER_LIST_OUTPUT, stderr: '' });

      const hostAbi = service.getHostArchitecture();
      const result = await service.listSystemImages();

      const android34Arm = result.find(
        (rt) => rt.identifier === `system-images;android-34;google_apis;${hostAbi}`,
      );
      if (android34Arm) {
        expect(android34Arm.id).toBe(
          `android-runtime-system-images-android-34-google_apis-${hostAbi}`,
        );
      }
    });

    it('handles empty sdkmanager output gracefully', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.listSystemImages();

      expect(result).toHaveLength(0);
    });

    it('propagates errors from exec', async () => {
      mockExec.mockRejectedValue(new Error('sdkmanager not found'));

      await expect(service.listSystemImages()).rejects.toThrow('sdkmanager not found');
    });
  });

  // -------------------------------------------------------------------------
  // createAVD() — checks that the correct args are built and passed through
  // -------------------------------------------------------------------------

  describe('createAVD()', () => {
    it('returns the AVD name on success', async () => {
      const { spawn } = await import('node:child_process');
      const mockSpawn = spawn as ReturnType<typeof vi.fn>;

      // Wire up a spawn mock that immediately calls 'close' with exit code 0
      mockSpawn.mockImplementationOnce(() => {
        const child = {
          pid: 99999,
          killed: false,
          stdin: { write: vi.fn(), end: vi.fn() },
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (code: number) => void) => {
            if (event === 'close') setTimeout(() => cb(0), 0);
          }),
          unref: vi.fn(),
        };
        return child;
      });

      const result = await service.createAVD(
        'test_avd',
        'system-images;android-34;google_apis;arm64-v8a',
        'pixel_8',
      );

      expect(result).toBe('test_avd');
    });

    it('passes the correct arguments to the avdmanager command', async () => {
      const { spawn } = await import('node:child_process');
      const mockSpawn = spawn as ReturnType<typeof vi.fn>;

      mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
        // Verify args immediately when spawn is called
        expect(args).toEqual([
          'create', 'avd',
          '-n', 'my_avd',
          '-k', 'system-images;android-34;google_apis;arm64-v8a',
          '-d', 'pixel_8',
          '--force',
        ]);

        return {
          pid: 88888,
          killed: false,
          stdin: { write: vi.fn(), end: vi.fn() },
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (code: number) => void) => {
            if (event === 'close') setTimeout(() => cb(0), 0);
          }),
          unref: vi.fn(),
        };
      });

      await service.createAVD(
        'my_avd',
        'system-images;android-34;google_apis;arm64-v8a',
        'pixel_8',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getAdbPort() — indirectly tests parseAdbDevices
  // -------------------------------------------------------------------------

  describe('getAdbPort() — indirectly tests parseAdbDevices', () => {
    it('returns null when no matching emulator is running', async () => {
      mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'devices') {
          return { stdout: SAMPLE_ADB_DEVICES, stderr: '' };
        }
        // For emu avd name queries, return a different AVD name
        return { stdout: 'different_avd\n', stderr: '' };
      });

      const port = await service.getAdbPort('my_avd');
      expect(port).toBeNull();
    });

    it('returns the port when the correct emulator AVD is found', async () => {
      mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
        const argsArr = args as string[];
        if (argsArr[0] === 'devices') {
          return { stdout: SAMPLE_ADB_DEVICES, stderr: '' };
        }
        // For any emu avd name query on emulator-5554 (device, not offline), return our AVD
        if (argsArr.includes('5554') || (argsArr.includes('-s') && argsArr.includes('emulator-5554'))) {
          return { stdout: 'my_target_avd\nOK\n', stderr: '' };
        }
        return { stdout: 'other_avd\nOK\n', stderr: '' };
      });

      const port = await service.getAdbPort('my_target_avd');
      // emulator-5554 is "device" status, should return 5554
      expect(port).toBe(5554);
    });

    it('skips offline emulators when searching for the AVD', async () => {
      // Only emulator-5554 is "device"; emulator-5556 is "offline"
      mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'devices') {
          return { stdout: SAMPLE_ADB_DEVICES, stderr: '' };
        }
        return { stdout: 'some_avd\nOK\n', stderr: '' };
      });

      // We look for an AVD that is only on the offline emulator
      // Since offline emulators are skipped in getAdbPort, this returns null
      const port = await service.getAdbPort('offline_only_avd');
      // This AVD won't be matched since emulator-5556 is offline and the device emulator is "some_avd"
      expect(port).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // deleteAVD()
  // -------------------------------------------------------------------------

  describe('deleteAVD()', () => {
    it('calls exec with the correct avdmanager delete arguments', async () => {
      mockExec.mockResolvedValue({ stdout: 'AVD deleted.\n', stderr: '' });

      await service.deleteAVD('my_avd_to_delete');

      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('avdmanager'),
        ['delete', 'avd', '-n', 'my_avd_to_delete'],
      );
    });

    it('propagates errors from exec', async () => {
      mockExec.mockRejectedValue(new Error('AVD does not exist'));

      await expect(service.deleteAVD('nonexistent_avd')).rejects.toThrow('AVD does not exist');
    });
  });

  // -------------------------------------------------------------------------
  // Android version label mapping (via listSystemImages)
  // -------------------------------------------------------------------------

  describe('androidVersionLabel mapping (via listSystemImages)', () => {
    const cases: Array<{ apiLevel: number; expected: string }> = [
      { apiLevel: 35, expected: 'Android 15 (API 35)' },
      { apiLevel: 34, expected: 'Android 14 (API 34)' },
      { apiLevel: 33, expected: 'Android 13 (API 33)' },
      { apiLevel: 30, expected: 'Android 11 (API 30)' },
      { apiLevel: 26, expected: 'Android 8.0 (Oreo) (API 26)' },
      { apiLevel: 99, expected: 'Android API 99' }, // unknown API level
    ];

    for (const { apiLevel, expected } of cases) {
      it(`maps API level ${apiLevel} to "${expected}"`, async () => {
        const hostAbi = service.getHostArchitecture();
        const imagePath = `system-images;android-${apiLevel};google_apis;${hostAbi}`;
        const sdkOutput = `Installed packages:
  Path                                                | Version | Description
  -------                                             | ------- | -------
  ${imagePath}      | 1       | Test Image\n`;

        mockExec.mockResolvedValue({ stdout: sdkOutput, stderr: '' });

        const result = await service.listSystemImages();

        expect(result[0]!.version).toBe(expected);
      });
    }
  });

  // -------------------------------------------------------------------------
  // openUrl()
  // -------------------------------------------------------------------------

  describe('openUrl(avdName, url)', () => {
    it('calls adb shell am start with the correct serial and URL', async () => {
      // Arrange — getAdbPort calls: (1) adb devices, (2) adb emu avd name for emulator-5554
      // Then openUrl issues the am start command as call (3)
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' }) // adb devices
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })  // adb emu avd name
        .mockResolvedValueOnce({ stdout: '', stderr: '' });              // adb shell am start

      // Act
      await service.openUrl('my_avd', 'https://example.com');

      // Assert — the third exec call is the am start command
      expect(mockExec.mock.calls[2]![1]).toEqual([
        '-s', 'emulator-5554',
        'shell', 'am', 'start',
        '-a', 'android.intent.action.VIEW',
        '-d', 'https://example.com',
      ]);
    });

    it('uses the correct ADB serial derived from the port number', async () => {
      // Arrange — emulator on port 5556
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5556\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.openUrl('my_avd', 'https://example.com');

      // Assert — serial contains the port number
      expect(mockExec.mock.calls[2]![1]).toContain('-s');
      const serialIdx = (mockExec.mock.calls[2]![1] as string[]).indexOf('-s');
      expect((mockExec.mock.calls[2]![1] as string[])[serialIdx + 1]).toBe('emulator-5556');
    });

    it('throws when the emulator is not running (no devices in adb output)', async () => {
      // Arrange — adb devices returns no emulators
      mockExec.mockResolvedValueOnce({ stdout: 'List of devices attached\n', stderr: '' });

      // Act & Assert
      await expect(service.openUrl('missing_avd', 'https://example.com')).rejects.toThrow(
        /not running/,
      );
    });

    it('throws when the running emulator has a different AVD name', async () => {
      // Arrange — a device is running but it belongs to a different AVD
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'other_avd\nOK\n', stderr: '' }); // wrong AVD

      // Act & Assert
      await expect(service.openUrl('my_avd', 'https://example.com')).rejects.toThrow(
        /not running/,
      );
    });

    it('works with deep-link URL schemes', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.openUrl('my_avd', 'myapp://home');

      // Assert — deep-link passed directly
      const amStartArgs = mockExec.mock.calls[2]![1] as string[];
      expect(amStartArgs[amStartArgs.length - 1]).toBe('myapp://home');
    });
  });

  // -------------------------------------------------------------------------
  // sendText()
  // -------------------------------------------------------------------------

  describe('sendText(avdName, text)', () => {
    it('calls adb shell input text with space-escaped text', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('my_avd', 'Hello World');

      // Assert — spaces replaced with %s per ADB requirement
      expect(mockExec.mock.calls[2]![1]).toEqual([
        '-s', 'emulator-5554',
        'shell', 'input', 'text', 'Hello%sWorld',
      ]);
    });

    it('preserves text without spaces unchanged', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('my_avd', 'hello');

      // Assert — no change to text without spaces
      const inputArgs = mockExec.mock.calls[2]![1] as string[];
      expect(inputArgs[inputArgs.length - 1]).toBe('hello');
    });

    it('replaces multiple spaces correctly (each space becomes %s)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('my_avd', 'a b c');

      // Assert
      const inputArgs = mockExec.mock.calls[2]![1] as string[];
      expect(inputArgs[inputArgs.length - 1]).toBe('a%sb%sc');
    });

    it('throws when the emulator is not running', async () => {
      // Arrange — adb devices returns no emulators
      mockExec.mockResolvedValueOnce({ stdout: 'List of devices attached\n', stderr: '' });

      // Act & Assert
      await expect(service.sendText('missing_avd', 'hello')).rejects.toThrow(/not running/);
    });

    it('throws when the running emulator belongs to a different AVD', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'wrong_avd\nOK\n', stderr: '' });

      // Act & Assert
      await expect(service.sendText('my_avd', 'hello')).rejects.toThrow(/not running/);
    });

    it('passes empty string to adb input text (valid edge case)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('my_avd', '');

      // Assert — empty string is passed through (no spaces to escape)
      const inputArgs = mockExec.mock.calls[2]![1] as string[];
      expect(inputArgs[inputArgs.length - 1]).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // sendTap()
  // -------------------------------------------------------------------------

  describe('sendTap(avdName, x, y)', () => {
    it('calls adb shell input tap with the correct serial and coordinates', async () => {
      // Arrange — getAdbPort calls: (1) adb devices, (2) adb emu avd name for emulator-5554
      // Then sendTap issues the input tap command as call (3)
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' }) // adb devices
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })  // adb emu avd name
        .mockResolvedValueOnce({ stdout: '', stderr: '' });              // adb shell input tap

      // Act
      await service.sendTap('my_avd', 100, 200);

      // Assert — the third exec call is the input tap command
      expect(mockExec.mock.calls[2]![1]).toEqual([
        '-s', 'emulator-5554',
        'shell', 'input', 'tap', '100', '200',
      ]);
    });

    it('rounds floating-point coordinates to integers', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act — x=100.7 rounds to 101, y=200.3 rounds to 200
      await service.sendTap('my_avd', 100.7, 200.3);

      // Assert — coordinates are rounded integer strings
      const tapArgs = mockExec.mock.calls[2]![1] as string[];
      expect(tapArgs[tapArgs.indexOf('tap') + 1]).toBe('101');
      expect(tapArgs[tapArgs.indexOf('tap') + 2]).toBe('200');
    });

    it('throws when the emulator is not running (no devices)', async () => {
      // Arrange — adb devices returns no emulators
      mockExec.mockResolvedValueOnce({ stdout: 'List of devices attached\n', stderr: '' });

      // Act & Assert
      await expect(service.sendTap('missing_avd', 100, 200)).rejects.toThrow(/not running/);
    });

    it('throws when the running emulator has a different AVD name', async () => {
      // Arrange — a device is running but it belongs to a different AVD
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'other_avd\nOK\n', stderr: '' }); // wrong AVD

      // Act & Assert
      await expect(service.sendTap('my_avd', 100, 200)).rejects.toThrow(/not running/);
    });
  });

  // -------------------------------------------------------------------------
  // sendSwipe()
  // -------------------------------------------------------------------------

  describe('sendSwipe(avdName, x1, y1, x2, y2, durationMs)', () => {
    it('calls adb shell input swipe with the correct serial and coordinates', async () => {
      // Arrange — getAdbPort calls: (1) adb devices, (2) adb emu avd name for emulator-5554
      // Then sendSwipe issues the input swipe command as call (3)
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' }) // adb devices
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })  // adb emu avd name
        .mockResolvedValueOnce({ stdout: '', stderr: '' });              // adb shell input swipe

      // Act
      await service.sendSwipe('my_avd', 100, 200, 300, 400);

      // Assert — the third exec call is the input swipe command with default 300ms duration
      expect(mockExec.mock.calls[2]![1]).toEqual([
        '-s', 'emulator-5554',
        'shell', 'input', 'swipe', '100', '200', '300', '400', '300',
      ]);
    });

    it('uses the provided duration', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act — explicit duration of 500ms
      await service.sendSwipe('my_avd', 0, 0, 100, 100, 500);

      // Assert — last arg is the custom duration
      const swipeArgs = mockExec.mock.calls[2]![1] as string[];
      expect(swipeArgs[swipeArgs.length - 1]).toBe('500');
    });

    it('defaults duration to 300ms when not provided', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act — no duration argument; default should be 300
      await service.sendSwipe('my_avd', 0, 0, 100, 100);

      // Assert — last arg is the default 300ms duration
      const swipeArgs = mockExec.mock.calls[2]![1] as string[];
      expect(swipeArgs[swipeArgs.length - 1]).toBe('300');
    });

    it('rounds floating-point coordinates to integers', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'my_avd\nOK\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act — all coordinates are floats; duration is also a float
      await service.sendSwipe('my_avd', 10.9, 20.1, 30.5, 40.4, 250.7);

      // Assert — x1=11, y1=20, x2=31, y2=40, duration=251
      const swipeArgs = mockExec.mock.calls[2]![1] as string[];
      const swipeIdx = swipeArgs.indexOf('swipe');
      expect(swipeArgs[swipeIdx + 1]).toBe('11');
      expect(swipeArgs[swipeIdx + 2]).toBe('20');
      expect(swipeArgs[swipeIdx + 3]).toBe('31');
      expect(swipeArgs[swipeIdx + 4]).toBe('40');
      expect(swipeArgs[swipeIdx + 5]).toBe('251');
    });

    it('throws when the emulator is not running', async () => {
      // Arrange — adb devices returns no emulators
      mockExec.mockResolvedValueOnce({ stdout: 'List of devices attached\n', stderr: '' });

      // Act & Assert
      await expect(service.sendSwipe('missing_avd', 0, 0, 100, 100)).rejects.toThrow(/not running/);
    });
  });
});
