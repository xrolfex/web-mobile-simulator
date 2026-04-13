import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock exec utilities before importing the service
// ---------------------------------------------------------------------------

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execJSON: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process to allow testing setClipboard (which uses spawn)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

import { IOSSimulatorService } from './ios-simulator.js';
import { exec, execJSON } from '../utils/exec.js';
import { spawn } from 'node:child_process';

const mockExec = exec as ReturnType<typeof vi.fn>;
const mockExecJSON = execJSON as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Realistic sample data mirroring xcrun simctl output
// ---------------------------------------------------------------------------

const SAMPLE_DEVICE_TYPES = {
  devicetypes: [
    {
      name: 'iPhone 15',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
      minRuntimeVersion: 851968,
      maxRuntimeVersion: 4294967295,
      productFamily: 'iPhone',
    },
    {
      name: 'iPhone 15 Pro',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
      minRuntimeVersion: 918528,
      maxRuntimeVersion: 4294967295,
      productFamily: 'iPhone',
    },
    {
      name: 'iPad Air 11-inch (M2)',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2',
      minRuntimeVersion: 1048576,
      maxRuntimeVersion: 4294967295,
      productFamily: 'iPad',
    },
    {
      name: 'Apple Watch Series 9 - 41mm',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-9-41mm',
      minRuntimeVersion: 1048576,
      maxRuntimeVersion: 4294967295,
      productFamily: 'Apple Watch',
    },
    {
      name: 'Apple TV 4K (3rd generation) (at 1080p)',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-1080p',
      minRuntimeVersion: 983040,
      maxRuntimeVersion: 4294967295,
      productFamily: 'Apple TV',
    },
    {
      name: 'Apple Vision Pro',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro',
      minRuntimeVersion: 1441792,
      maxRuntimeVersion: 4294967295,
      productFamily: 'Apple Vision',
    },
  ],
};

const SAMPLE_RUNTIMES = {
  runtimes: [
    {
      name: 'iOS 17.5',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      version: '17.5',
      isAvailable: true,
      buildversion: '21F79',
      platform: 'iOS',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 17.5.simruntime',
      supportedDeviceTypes: [
        { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', name: 'iPhone 15' },
      ],
    },
    {
      name: 'iOS 16.4',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4',
      version: '16.4',
      isAvailable: false,
      buildversion: '20E247',
      platform: 'iOS',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 16.4.simruntime',
      supportedDeviceTypes: [],
    },
    {
      name: 'watchOS 10.5',
      identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-10-5',
      version: '10.5',
      isAvailable: true,
      buildversion: '21T575',
      platform: 'watchOS',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/Runtimes/watchOS 10.5.simruntime',
      supportedDeviceTypes: [],
    },
    {
      name: 'tvOS 17.5',
      identifier: 'com.apple.CoreSimulator.SimRuntime.tvOS-17-5',
      version: '17.5',
      isAvailable: true,
      buildversion: '21L569',
      platform: 'tvOS',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/Runtimes/tvOS 17.5.simruntime',
      supportedDeviceTypes: [],
    },
  ],
};

const SAMPLE_FULL_LIST = {
  devicetypes: SAMPLE_DEVICE_TYPES.devicetypes,
  runtimes: SAMPLE_RUNTIMES.runtimes,
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      {
        udid: 'AAAAAAAA-0000-0000-0000-000000000001',
        name: 'iPhone 15',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        dataPath: '/Users/test/Library/Developer/CoreSimulator/Devices/AAA.../data',
        logPath: '/Users/test/Library/Logs/CoreSimulator/AAA...',
      },
      {
        udid: 'BBBBBBBB-0000-0000-0000-000000000002',
        name: 'iPhone 15 Pro',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        dataPath: '/Users/test/Library/Developer/CoreSimulator/Devices/BBB.../data',
        logPath: '/Users/test/Library/Logs/CoreSimulator/BBB...',
      },
      {
        udid: 'CCCCCCCC-0000-0000-0000-000000000003',
        name: 'Unavailable Phone',
        state: 'Shutdown',
        isAvailable: false, // Should be filtered out
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        dataPath: '',
        logPath: '',
        availabilityError: 'Runtime not installed',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-10-5': [
      {
        udid: 'DDDDDDDD-0000-0000-0000-000000000004',
        name: 'Apple Watch Series 9 - 41mm',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-9-41mm',
        dataPath: '',
        logPath: '',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IOSSimulatorService', () => {
  let service: IOSSimulatorService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a default resolved value for exec() so that assertSimctlAvailable()'s
    // `exec('xcrun', ['--find', 'simctl'])` call succeeds in every test. Tests that need
    // exec() to behave differently will override this with mockResolvedValueOnce /
    // mockRejectedValueOnce AFTER the xcrun --find simctl call completes.
    mockExec.mockResolvedValue({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' });
    service = new IOSSimulatorService();
  });

  // -------------------------------------------------------------------------
  // Platform guard — assertSimctlAvailable()
  // -------------------------------------------------------------------------

  describe('platform guard', () => {
    it('throws on non-macOS platforms', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      try {
        await expect(service.listDeviceTypes()).rejects.toThrow(
          'IOSSimulatorService requires macOS',
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('throws with the current platform name on non-macOS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        await expect(service.listDeviceTypes()).rejects.toThrow('win32');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  // Skip the rest of the tests if not on macOS
  const macosOnly = process.platform === 'darwin' ? it : it.skip;

  // -------------------------------------------------------------------------
  // listDeviceTypes()
  // -------------------------------------------------------------------------

  describe('listDeviceTypes()', () => {
    macosOnly('returns only iPhone and iPad device types', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      const families = result.map((dt) => {
        // Determine family from the original data
        const original = SAMPLE_DEVICE_TYPES.devicetypes.find(
          (d) => d.identifier === dt.id,
        );
        return original?.productFamily;
      });

      expect(families.every((f) => f === 'iPhone' || f === 'iPad')).toBe(true);
    });

    macosOnly('filters out Apple Watch, Apple TV, and Apple Vision device types', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      const names = result.map((dt) => dt.name);
      expect(names).not.toContain('Apple Watch Series 9 - 41mm');
      expect(names).not.toContain('Apple TV 4K (3rd generation) (at 1080p)');
      expect(names).not.toContain('Apple Vision Pro');
    });

    macosOnly('maps identifier to id field', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      const iphone15 = result.find((dt) => dt.name === 'iPhone 15');
      expect(iphone15!.id).toBe('com.apple.CoreSimulator.SimDeviceType.iPhone-15');
    });

    macosOnly('sets platform to "ios" for all results', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      expect(result.every((dt) => dt.platform === 'ios')).toBe(true);
    });

    macosOnly('maps name to both name and modelName', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      for (const dt of result) {
        expect(dt.name).toBe(dt.modelName);
      }
    });

    macosOnly('maps identifier to modelIdentifier', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      for (const dt of result) {
        expect(dt.id).toBe(dt.modelIdentifier);
      }
    });

    macosOnly('returns 3 devices when input has 2 iPhones and 1 iPad (and 3 others filtered)', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      const result = await service.listDeviceTypes();

      expect(result).toHaveLength(3); // iPhone 15, iPhone 15 Pro, iPad Air
    });

    macosOnly('calls execJSON with correct simctl arguments', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_DEVICE_TYPES);

      await service.listDeviceTypes();

      expect(mockExecJSON).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'list', 'devicetypes', '-j'],
        expect.objectContaining({
          env: expect.objectContaining({
            DEVELOPER_DIR: expect.stringContaining('Xcode.app/Contents/Developer'),
          }),
        }),
      );
    });

    macosOnly('propagates errors from execJSON', async () => {
      mockExecJSON.mockRejectedValue(new Error('xcrun not found'));

      await expect(service.listDeviceTypes()).rejects.toThrow('xcrun not found');
    });
  });

  // -------------------------------------------------------------------------
  // listRuntimes()
  // -------------------------------------------------------------------------

  describe('listRuntimes()', () => {
    macosOnly('returns only iOS platform runtimes', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      expect(result.every((rt) => rt.platform === 'ios')).toBe(true);
    });

    macosOnly('filters out watchOS and tvOS runtimes', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      const versions = result.map((rt) => rt.version);
      expect(versions).not.toContain('watchOS 10.5');
      expect(versions).not.toContain('tvOS 17.5');
    });

    macosOnly('maps version to the runtime name field', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      const ios175 = result.find((rt) => rt.id === 'com.apple.CoreSimulator.SimRuntime.iOS-17-5');
      expect(ios175!.version).toBe('iOS 17.5');
    });

    macosOnly('maps isAvailable=true to status="installed"', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      const ios175 = result.find((rt) => rt.id === 'com.apple.CoreSimulator.SimRuntime.iOS-17-5');
      expect(ios175!.status).toBe('installed');
    });

    macosOnly('maps isAvailable=false to status="error"', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      const ios164 = result.find((rt) => rt.id === 'com.apple.CoreSimulator.SimRuntime.iOS-16-4');
      expect(ios164!.status).toBe('error');
    });

    macosOnly('returns 2 iOS runtimes from sample data', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      const result = await service.listRuntimes();

      expect(result).toHaveLength(2);
    });

    macosOnly('calls execJSON with correct simctl arguments', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_RUNTIMES);

      await service.listRuntimes();

      expect(mockExecJSON).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'list', 'runtimes', '-j'],
        expect.objectContaining({
          env: expect.objectContaining({
            DEVELOPER_DIR: expect.stringContaining('Xcode.app/Contents/Developer'),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createDevice()
  // -------------------------------------------------------------------------

  describe('createDevice()', () => {
    macosOnly('returns the UDID from stdout (trimmed)', async () => {
      const udid = 'FFFFFFFF-0000-0000-0000-FFFFFFFFFFFF';
      // First call: assertSimctlAvailable() → xcrun --find simctl
      // Second call: simctl create → returns the new UDID
      mockExec
        .mockResolvedValueOnce({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: `${udid}\n`, stderr: '' });

      const result = await service.createDevice(
        'Test iPhone',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      );

      expect(result).toBe(udid);
    });

    macosOnly('calls exec with correct simctl create arguments', async () => {
      const udid = 'AAAAAAAA-1111-1111-1111-AAAAAAAAAAAA';
      // First call: assertSimctlAvailable() → xcrun --find simctl
      // Second call: simctl create → returns the new UDID
      mockExec
        .mockResolvedValueOnce({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: udid, stderr: '' });

      await service.createDevice(
        'My Simulator',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      );

      expect(mockExec).toHaveBeenCalledWith('xcrun', [
        'simctl',
        'create',
        'My Simulator',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      ], expect.objectContaining({
        env: expect.objectContaining({
          DEVELOPER_DIR: expect.stringContaining('Xcode.app/Contents/Developer'),
        }),
      }));
    });

    macosOnly('throws if stdout is empty', async () => {
      // First call: assertSimctlAvailable() → xcrun --find simctl
      // Second call: simctl create → returns empty stdout
      mockExec
        .mockResolvedValueOnce({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        service.createDevice(
          'Empty Output Device',
          'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        ),
      ).rejects.toThrow('simctl create returned empty output');
    });

    macosOnly('throws if stdout is only whitespace', async () => {
      // First call: assertSimctlAvailable() → xcrun --find simctl
      // Second call: simctl create → returns whitespace-only stdout
      mockExec
        .mockResolvedValueOnce({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '   \n  ', stderr: '' });

      await expect(
        service.createDevice(
          'Whitespace Device',
          'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        ),
      ).rejects.toThrow('simctl create returned empty output');
    });

    macosOnly('propagates exec() failures', async () => {
      // First call: assertSimctlAvailable() → xcrun --find simctl succeeds
      // Second call: simctl create → rejects with the expected error
      mockExec
        .mockResolvedValueOnce({ stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n', stderr: '' })
        .mockRejectedValueOnce(new Error('Command failed: xcrun simctl create'));

      await expect(
        service.createDevice(
          'Failed Device',
          'invalid-type',
          'invalid-runtime',
        ),
      ).rejects.toThrow('Command failed');
    });
  });

  // -------------------------------------------------------------------------
  // listDevices()
  // -------------------------------------------------------------------------

  describe('listDevices()', () => {
    macosOnly('returns only available iOS devices', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      // Unavailable device (isAvailable: false) should be filtered out
      const ids = result.map((d) => d.id);
      expect(ids).not.toContain('CCCCCCCC-0000-0000-0000-000000000003');
    });

    macosOnly('filters out devices from non-iOS runtimes (e.g. watchOS)', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      const ids = result.map((d) => d.id);
      expect(ids).not.toContain('DDDDDDDD-0000-0000-0000-000000000004');
    });

    macosOnly('maps state "Booted" to DeviceState "booted"', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      const bootedDevice = result.find((d) => d.id === 'BBBBBBBB-0000-0000-0000-000000000002');
      expect(bootedDevice!.state).toBe('booted');
    });

    macosOnly('maps state "Shutdown" to DeviceState "shutdown"', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      const shutdownDevice = result.find((d) => d.id === 'AAAAAAAA-0000-0000-0000-000000000001');
      expect(shutdownDevice!.state).toBe('shutdown');
    });

    macosOnly('sets platform to "ios" for all results', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      expect(result.every((d) => d.platform === 'ios')).toBe(true);
    });

    macosOnly('resolves deviceType from the devicetypes lookup map', async () => {
      mockExecJSON.mockResolvedValue(SAMPLE_FULL_LIST);

      const result = await service.listDevices();

      const device = result.find((d) => d.id === 'AAAAAAAA-0000-0000-0000-000000000001');
      expect(device!.deviceType.name).toBe('iPhone 15');
      expect(device!.deviceType.id).toBe(
        'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDeviceState()
  // -------------------------------------------------------------------------

  describe('getDeviceState()', () => {
    macosOnly('returns "booted" when simctl reports Booted', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'TEST-UDID', state: 'Booted', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('TEST-UDID');

      expect(state).toBe('booted');
    });

    macosOnly('returns "shutdown" when simctl reports Shutdown', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'TEST-UDID', state: 'Shutdown', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('TEST-UDID');

      expect(state).toBe('shutdown');
    });

    macosOnly('returns "booting" when simctl reports Booting', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'TEST-UDID', state: 'Booting', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('TEST-UDID');

      expect(state).toBe('booting');
    });

    macosOnly('returns "shutting_down" when simctl reports "Shutting Down"', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'TEST-UDID', state: 'Shutting Down', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('TEST-UDID');

      expect(state).toBe('shutting_down');
    });

    macosOnly('returns "error" when the device is not found in any runtime', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'DIFFERENT-UDID', state: 'Shutdown', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('NONEXISTENT-UDID');

      expect(state).toBe('error');
    });

    macosOnly('returns "error" for unknown state strings', async () => {
      mockExecJSON.mockResolvedValue({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
            { udid: 'TEST-UDID', state: 'UnknownWeirdState', isAvailable: true },
          ],
        },
      });

      const state = await service.getDeviceState('TEST-UDID');

      expect(state).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // pressButton()
  // -------------------------------------------------------------------------

  describe('pressButton(udid, button)', () => {
    macosOnly('calls osascript with Cmd+Shift+H for home button', async () => {
      // Arrange — pressButton does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — exec called with osascript and a script containing the home shortcut
      expect(mockExec.mock.calls[0]).toEqual([
        'osascript',
        ['-e', expect.stringContaining('keystroke "h" using {command down, shift down}')],
      ]);
    });

    macosOnly('calls osascript with Device menu click for lock button', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'lock');

      // Assert — script contains the Lock Screen menu item click (not a keyboard shortcut)
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('click menu item "Lock Screen"');
      expect(scriptArg[1]).toContain('menu bar item "Device"');
    });

    macosOnly('calls osascript with menu click for volumeUp', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'volumeUp');

      // Assert — script contains a click on the Volume Up menu item
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('Volume Up');
    });

    macosOnly('calls osascript with menu click for volumeDown', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'volumeDown');

      // Assert — script contains a click on the Volume Down menu item
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('Volume Down');
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — exactly 1 exec call: just the osascript invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('the AppleScript targets System Events and Simulator process', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — the script references both System Events and the Simulator process
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('System Events');
      expect(scriptArg[1]).toContain('process "Simulator"');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — make the single osascript call reject
      mockExec.mockRejectedValueOnce(new Error('osascript: execution error'));

      // Act & Assert
      await expect(service.pressButton('TEST-UDID', 'home')).rejects.toThrow(
        'osascript: execution error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // setOrientation()
  // -------------------------------------------------------------------------

  describe('setOrientation(udid, orientation)', () => {
    macosOnly('clicks "Rotate Left" for landscapeLeft', async () => {
      // Arrange — setOrientation does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — script contains the "Rotate Left" menu item click
      expect(mockExec.mock.calls[0]).toEqual([
        'osascript',
        ['-e', expect.stringContaining('Rotate Left')],
      ]);
    });

    macosOnly('clicks "Rotate Right" for landscapeRight', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeRight');

      // Assert — script contains the "Rotate Right" menu item click
      expect(mockExec.mock.calls[0]).toEqual([
        'osascript',
        ['-e', expect.stringContaining('Rotate Right')],
      ]);
    });

    macosOnly('clicks "Rotate Right" for portrait (best-effort)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'portrait');

      // Assert — portrait maps to a best-effort "Rotate Right" click
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('Rotate Right');
    });

    macosOnly('clicks "Rotate Left" for portraitUpsideDown (best-effort)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'portraitUpsideDown');

      // Assert — portraitUpsideDown maps to a best-effort "Rotate Left" click
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('Rotate Left');
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — exactly 1 exec call: just the osascript invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('the AppleScript clicks via the Device menu bar item', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — the script references the Device menu bar item
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('menu bar item "Device"');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — make the single osascript call reject
      mockExec.mockRejectedValueOnce(new Error('osascript: execution error'));

      // Act & Assert
      await expect(service.setOrientation('TEST-UDID', 'landscapeLeft')).rejects.toThrow(
        'osascript: execution error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // shake()
  // -------------------------------------------------------------------------

  describe('shake(udid)', () => {
    macosOnly('calls osascript with Ctrl+Cmd+Z for Device > Shake', async () => {
      // Arrange — shake does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — exec called with osascript and the Ctrl+Cmd+Z shake shortcut
      expect(mockExec.mock.calls[0]).toEqual([
        'osascript',
        ['-e', expect.stringContaining('keystroke "z" using {command down, control down}')],
      ]);
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — exactly 1 exec call: just the osascript invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('propagates exec failures directly (no custom error message)', async () => {
      // Arrange — make the single osascript call reject with a raw error
      mockExec.mockRejectedValueOnce(new Error('osascript error'));

      // Act — capture the thrown error
      let thrownError: unknown;
      try {
        await service.shake('TEST-UDID');
      } catch (err) {
        thrownError = err;
      }

      // Assert — error propagates as-is: message is 'osascript error',
      // NOT wrapped in "Shake gesture is not supported"
      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe('osascript error');
      expect((thrownError as Error).message).not.toContain('Shake gesture is not supported');
    });

    macosOnly('the AppleScript targets System Events and Simulator process', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — the script references both System Events and the Simulator process
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('System Events');
      expect(scriptArg[1]).toContain('process "Simulator"');
    });
  });

  // -------------------------------------------------------------------------
  // takeScreenshot()
  // -------------------------------------------------------------------------

  describe('takeScreenshot(udid, outputPath)', () => {
    macosOnly('calls xcrun simctl io <udid> screenshot --type=png <outputPath>', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await service.takeScreenshot('TEST-UDID', '/tmp/screenshot.png');

      expect(mockExec.mock.calls[1]).toEqual([
        'xcrun',
        ['simctl', 'io', 'TEST-UDID', 'screenshot', '--type=png', '/tmp/screenshot.png'],
        expect.any(Object),
      ]);
    });

    macosOnly('exec is called exactly twice (simctl check + screenshot command)', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await service.takeScreenshot('TEST-UDID', '/tmp/screenshot.png');

      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockRejectedValueOnce(new Error('Command failed: xcrun simctl io'));

      await expect(
        service.takeScreenshot('TEST-UDID', '/tmp/screenshot.png'),
      ).rejects.toThrow('Command failed');
    });
  });

  // -------------------------------------------------------------------------
  // setClipboard()
  // -------------------------------------------------------------------------

  describe('setClipboard(udid, text)', () => {
    macosOnly('spawns xcrun simctl pbcopy and writes text to stdin', async () => {
      // Arrange — assertSimctlAvailable calls exec once
      mockExec.mockResolvedValue({ stdout: '/usr/bin/simctl\n', stderr: '' });

      const mockStdin = { write: vi.fn(), end: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockChild = {
        stdin: mockStdin,
        stderr: mockStderr,
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') {
            // Simulate successful close immediately
            setTimeout(() => cb(0), 0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      // Act
      await service.setClipboard('TEST-UDID', 'Clipboard text');

      // Assert — spawn called with the correct command/args
      expect(mockSpawn).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'pbcopy', 'TEST-UDID'],
        expect.objectContaining({ stdio: ['pipe', 'ignore', 'pipe'] }),
      );
      // Text piped to stdin
      expect(mockStdin.write).toHaveBeenCalledWith('Clipboard text');
      expect(mockStdin.end).toHaveBeenCalled();
    });

    macosOnly('rejects when pbcopy exits with a non-zero code', async () => {
      // Arrange
      mockExec.mockResolvedValue({ stdout: '/usr/bin/simctl\n', stderr: '' });

      const mockStdin = { write: vi.fn(), end: vi.fn() };
      const mockStderr = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'data') cb(Buffer.from('some stderr error'));
        }),
      };
      const mockChild = {
        stdin: mockStdin,
        stderr: mockStderr,
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') {
            setTimeout(() => cb(1), 0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      // Act & Assert
      await expect(service.setClipboard('TEST-UDID', 'text')).rejects.toThrow(
        /pbcopy exited with code 1/,
      );
    });

    macosOnly('resolves without error when text is an empty string', async () => {
      // Arrange
      mockExec.mockResolvedValue({ stdout: '/usr/bin/simctl\n', stderr: '' });

      const mockStdin = { write: vi.fn(), end: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockChild = {
        stdin: mockStdin,
        stderr: mockStderr,
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') setTimeout(() => cb(0), 0);
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      // Act & Assert — empty string is a valid "clear clipboard" operation
      await expect(service.setClipboard('TEST-UDID', '')).resolves.toBeUndefined();
      expect(mockStdin.write).toHaveBeenCalledWith('');
    });
  });

  // -------------------------------------------------------------------------
  // getClipboard()
  // -------------------------------------------------------------------------

  describe('getClipboard(udid)', () => {
    macosOnly('calls xcrun simctl pbpaste with the correct UDID', async () => {
      // Arrange — first call is assertSimctlAvailable, second is pbpaste
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'Hello World', stderr: '' });

      // Act
      const result = await service.getClipboard('TEST-UDID');

      // Assert
      expect(result).toBe('Hello World');
      expect(mockExec.mock.calls[1]).toEqual([
        'xcrun',
        ['simctl', 'pbpaste', 'TEST-UDID'],
        expect.any(Object),
      ]);
    });

    macosOnly('returns the stdout string unchanged (including trailing newline)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'line1\nline2\n', stderr: '' });

      // Act
      const result = await service.getClipboard('TEST-UDID');

      // Assert — service returns stdout as-is (callers trim if needed)
      expect(result).toBe('line1\nline2\n');
    });

    macosOnly('returns empty string when clipboard is empty', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      const result = await service.getClipboard('TEST-UDID');

      // Assert
      expect(result).toBe('');
    });

    macosOnly('exec is called exactly twice (simctl check + pbpaste command)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'some text', stderr: '' });

      // Act
      await service.getClipboard('TEST-UDID');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockRejectedValueOnce(new Error('pbpaste failed'));

      // Act & Assert
      await expect(service.getClipboard('TEST-UDID')).rejects.toThrow('pbpaste failed');
    });
  });

  // -------------------------------------------------------------------------
  // openUrl()
  // -------------------------------------------------------------------------

  describe('openUrl(udid, url)', () => {
    macosOnly('calls xcrun simctl openurl with the correct UDID and URL', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.openUrl('TEST-UDID', 'https://example.com');

      // Assert
      expect(mockExec.mock.calls[1]).toEqual([
        'xcrun',
        ['simctl', 'openurl', 'TEST-UDID', 'https://example.com'],
        expect.any(Object),
      ]);
    });

    macosOnly('works with deep-link URL schemes', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.openUrl('TEST-UDID', 'myapp://home');

      // Assert
      expect(mockExec.mock.calls[1]).toEqual([
        'xcrun',
        ['simctl', 'openurl', 'TEST-UDID', 'myapp://home'],
        expect.any(Object),
      ]);
    });

    macosOnly('exec is called exactly twice (simctl check + openurl command)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.openUrl('TEST-UDID', 'https://example.com');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: '/usr/bin/simctl\n', stderr: '' })
        .mockRejectedValueOnce(new Error('Command failed: xcrun simctl openurl'));

      // Act & Assert
      await expect(service.openUrl('TEST-UDID', 'https://example.com')).rejects.toThrow(
        'Command failed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // sendText()
  // -------------------------------------------------------------------------

  describe('sendText(udid, text)', () => {
    macosOnly('calls osascript with a keystroke script (not xcrun simctl)', async () => {
      // Arrange — sendText does NOT call assertSimctlAvailable, so only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'Hello World');

      // Assert — first (and only) call is osascript with -e and a keystroke script
      expect(mockExec.mock.calls[0]).toEqual([
        'osascript',
        ['-e', expect.stringContaining('keystroke')],
      ]);
    });

    macosOnly('the AppleScript contains the text embedded inside keystroke (preserving spaces)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'hello world test');

      // Assert — the script passed to -e contains the text as a keystroke argument
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('keystroke "hello world test"');
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable, just osascript)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'hello');

      // Assert — only 1 exec call: the osascript keystroke
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('escapes backslash characters in the AppleScript string', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'path\\to\\file');

      // Assert — single backslash → double backslash inside AppleScript string
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('keystroke "path\\\\to\\\\file"');
    });

    macosOnly('escapes double-quote characters in the AppleScript string', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'say "hello"');

      // Assert — " → \" inside AppleScript string
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('keystroke "say \\"hello\\""');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — sendText makes exactly 1 exec call; make it reject
      mockExec.mockRejectedValueOnce(new Error('osascript: execution error'));

      // Act & Assert
      await expect(service.sendText('TEST-UDID', 'hello')).rejects.toThrow('osascript');
    });
  });

  // -------------------------------------------------------------------------
  // openSimulatorApp()
  // -------------------------------------------------------------------------

  describe('openSimulatorApp(udid)', () => {
    macosOnly('calls exec with "defaults write" to disable bezels, then "open" with the correct Simulator.app arguments', async () => {
      // Arrange — use fake timers to skip the 2-second wait
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — first call disables bezels via defaults write
      expect(mockExec).toHaveBeenCalledWith(
        'defaults',
        ['write', 'com.apple.iphonesimulator', 'ShowChrome', '-int', '0'],
      );

      // Assert — second call launches Simulator.app
      expect(mockExec).toHaveBeenCalledWith(
        'open',
        ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', 'TEST-UDID'],
      );

      // Assert — third call hides the Simulator toolbar
      expect(mockExec).toHaveBeenCalledWith(
        'osascript',
        ['-e', expect.stringContaining('set visible of toolbar 1 of window 1 to false')],
      );

      vi.useRealTimers();
    });

    macosOnly('exec is called exactly twice: once for defaults write and once for open', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — 3 exec calls: defaults write, open, osascript (toolbar hide)
      expect(mockExec).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    macosOnly('does NOT pass XCRUN_EXEC_OPTIONS to the open command', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — open call is calls[1] (calls[0] is `defaults write`)
      expect(mockExec).toHaveBeenCalledWith(
        'open',
        ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', 'TEST-UDID'],
      );
      // Specifically, the `open` call should NOT have a 3rd argument (no options)
      expect(mockExec.mock.calls[1]).toHaveLength(2);

      vi.useRealTimers();
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' })           // defaults write succeeds
        .mockRejectedValueOnce(new Error('open: cannot find application Simulator')); // open fails

      // Act & Assert
      await expect(service.openSimulatorApp('TEST-UDID')).rejects.toThrow(
        'cannot find application Simulator',
      );

      vi.useRealTimers();
    });

    macosOnly('passes the UDID to -CurrentDeviceUDID argument', async () => {
      // Arrange
      const customUdid = 'CUSTOM-DEVICE-UDID-12345';
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp(customUdid);
      await vi.runAllTimersAsync();
      await promise;

      // Assert — UDID appears as the last argument of the `open` call (calls[1])
      const callArgs = mockExec.mock.calls[1]![1] as string[];
      expect(callArgs[callArgs.length - 1]).toBe(customUdid);

      vi.useRealTimers();
    });

    macosOnly('hides the Simulator toolbar via osascript after launch', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — third call is osascript to hide toolbar
      expect(mockExec.mock.calls[2]![0]).toBe('osascript');
      const osascriptArgs = mockExec.mock.calls[2]![1] as string[];
      expect(osascriptArgs[0]).toBe('-e');
      expect(osascriptArgs[1]).toContain('set visible of toolbar 1 of window 1 to false');

      vi.useRealTimers();
    });

    macosOnly('resolves successfully even when the toolbar osascript call throws (best-effort)', async () => {
      // Arrange — defaults write and open succeed; osascript (toolbar) throws
      vi.useFakeTimers();
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' })  // defaults write
        .mockResolvedValueOnce({ stdout: '', stderr: '' })  // open -a Simulator
        .mockRejectedValueOnce(new Error('osascript: execution error: System Events got an error: Can\'t get window 1 of process "Simulator".'));  // toolbar hide fails

      // Act — should resolve, not reject
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // sendTap()
  // -------------------------------------------------------------------------

  describe('sendTap(udid, normX, normY)', () => {
    // Window geometry (used for normalization): x=100, y=150, width=400, height=880
    // Content geometry (informational only):    x=100, y=230, width=400, height=800
    // Window: x=100, y=150, w=400, h=880  (full window including title bar + toolbar)
    // Content: x=100, y=230, w=400, h=800  (content area inside window)
    const GEO_STDOUT = '100,150,400,880,100,230,400,800';

    macosOnly('calls exec exactly 2 times: geometry + swift CGEvent tap', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // getSimulatorContentGeometry
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // swift CGEvent tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    macosOnly('computes correct screen coords for center point (0.5, 0.5)', async () => {
      // Arrange
      // screenX = 100 + 0.5 * 400 = 300
      // screenY = 150 + 0.5 * 880 = 590
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — second exec call is swift CGEvent tap with computed screen coords
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 300, 590)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 300, 590)');
    });

    macosOnly('computes correct screen coords for top-left corner (0, 0)', async () => {
      // Arrange
      // screenX = 100 + 0 * 400 = 100
      // screenY = 150 + 0 * 880 = 150
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendTap('TEST-UDID', 0, 0);

      // Assert
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 100, 150)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 100, 150)');
    });

    macosOnly('computes correct screen coords for bottom-right corner (1, 1)', async () => {
      // Arrange
      // screenX = 100 + 1 * 400 = 500
      // screenY = 150 + 1 * 880 = 1030
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendTap('TEST-UDID', 1, 1);

      // Assert
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 500, 1030)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 500, 1030)');
    });

    macosOnly('second exec call uses swift CGEvent (not osascript click)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — second call is swift (not osascript), and the script activates
      // Simulator.app and posts events via .cghidEventTap
      expect(mockExec.mock.calls[1]![0]).toBe('swift');
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[1]).toContain('activate(options:');
      expect(swiftArgs[1]).toContain('post(tap: .cghidEventTap)');
    });

    macosOnly('throws when getSimulatorContentGeometry returns unparseable output on both primary and fallback paths', async () => {
      // Arrange — primary content-area query returns invalid output → falls back to window frame
      //           fallback window-frame query also returns invalid output → throws
      mockExec
        .mockResolvedValueOnce({ stdout: 'invalid output', stderr: '' })  // content area query fails to parse → falls back
        .mockResolvedValueOnce({ stdout: 'invalid output', stderr: '' }); // window frame query also fails to parse → throws

      // Act & Assert
      await expect(service.sendTap('TEST-UDID', 0.5, 0.5)).rejects.toThrow(
        'Failed to parse Simulator window geometry',
      );
    });

    macosOnly('throws when both the primary and fallback geometry exec calls fail', async () => {
      // Arrange — primary content-area query throws → falls back to window frame
      //           fallback window-frame query also throws → error propagates
      mockExec
        .mockRejectedValueOnce(new Error('osascript: Simulator is not running'))  // content area query throws → falls back
        .mockRejectedValueOnce(new Error('osascript: Simulator is not running')); // window frame query also throws → propagates

      // Act & Assert
      await expect(service.sendTap('TEST-UDID', 0.5, 0.5)).rejects.toThrow(
        'Simulator is not running',
      );
    });

    macosOnly('falls back to window frame + 28px offset when content-area query fails', async () => {
      // Arrange: first exec (content-area query) rejects; second exec (window frame) succeeds;
      // third exec is the swift CGEvent tap call.
      mockExec
        .mockRejectedValueOnce(new Error('group 1 not found'))            // content area query fails
        .mockResolvedValueOnce({ stdout: '100,200,400,800', stderr: '' }) // fallback window frame
        .mockResolvedValueOnce({ stdout: '', stderr: '' });               // swift CGEvent tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // With fallback window frame (100, 200, 400, 800):
      // windowX=100, windowY=200, windowWidth=400, windowHeight=800
      // screenX = 100 + 0.5 * 400 = 300
      // screenY = 200 + 0.5 * 800 = 600
      const swiftArgs = mockExec.mock.calls[2]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 300, 600)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 300, 600)');
    });
  });

  // -------------------------------------------------------------------------
  // sendSwipe()
  // -------------------------------------------------------------------------

  describe('sendSwipe(udid, normX1, normY1, normX2, normY2, durationMs)', () => {
    // Window: x=100, y=150, w=400, h=880
    // Content: x=100, y=230, w=400, h=800
    const GEO_STDOUT = '100,150,400,880,100,230,400,800';

    macosOnly('calls exec exactly 2 times: geometry + swift CGEvent swipe', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // getSimulatorContentGeometry
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // swift CGEvent swipe

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    macosOnly('second exec call uses swift -e CGEvent drag', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0);

      // Assert — second call is swift (no intermediate activate)
      expect(mockExec.mock.calls[1]![0]).toBe('swift');
    });

    macosOnly('embeds correct screen coordinates in the swift swipe script', async () => {
      // Arrange
      // startX = round(100 + 0.0 * 400) = 100
      // startY = round(150 + 0.0 * 880) = 150
      // endX   = round(100 + 1.0 * 400) = 500
      // endY   = round(150 + 1.0 * 880) = 1030
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert — second exec call is swift -e with computed screen coords in the script
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 100, 150)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 500, 1030)');
      expect(swiftArgs[1]).toContain('post(tap: .cghidEventTap)');
      expect(swiftArgs[1]).not.toContain('postToPid');
    });

    macosOnly('swift swipe script activates Simulator before posting events', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert — script activates Simulator so HID events are routed to it
      const swiftArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swiftArgs[1]).toContain('activate(options:');
    });

    macosOnly('falls back to window frame + 28px offset for swipe when content-area query fails', async () => {
      // Arrange: content-area query rejects → falls back to window-frame query → succeeds
      // Fallback window frame: x=100, y=200, w=400, h=800
      // windowX=100, windowY=200, windowWidth=400, windowHeight=800
      // startX = round(100 + 0.0 * 400) = 100
      // startY = round(200 + 0.0 * 800) = 200
      // endX   = round(100 + 1.0 * 400) = 500
      // endY   = round(200 + 1.0 * 800) = 1000
      mockExec
        .mockRejectedValueOnce(new Error('group 1 not found'))            // content-area query fails
        .mockResolvedValueOnce({ stdout: '100,200,400,800', stderr: '' }) // window frame fallback
        .mockResolvedValueOnce({ stdout: '', stderr: '' });               // swift CGEvent swipe

      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      const swiftArgs = mockExec.mock.calls[2]![1] as string[];
      expect(swiftArgs[0]).toBe('-e');
      expect(swiftArgs[1]).toContain('post(.leftMouseDown, 100, 200)');
      expect(swiftArgs[1]).toContain('post(.leftMouseUp, 500, 1000)');
    });

    macosOnly('propagates geometry exec failure as thrown error', async () => {
      // Arrange — primary content-area query throws → falls back to window frame
      //           fallback window-frame query also throws → error propagates
      mockExec
        .mockRejectedValueOnce(new Error('osascript: Simulator not found'))  // content area query
        .mockRejectedValueOnce(new Error('osascript: Simulator not found')); // window frame query

      // Act & Assert
      await expect(
        service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0),
      ).rejects.toThrow('Simulator not found');
    });
  });

  // -------------------------------------------------------------------------
  // sendKeyEvent()
  // -------------------------------------------------------------------------

  describe('sendKeyEvent(udid, key, code)', () => {
    macosOnly('sends "key code 36" for the Enter key', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(1);
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('key code 36');
    });

    macosOnly('sends "key code 51" for the Backspace key', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Backspace', 'Backspace');

      // Assert
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('key code 51');
    });

    macosOnly('sends "key code 126" for the ArrowUp key', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'ArrowUp', 'ArrowUp');

      // Assert
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('key code 126');
    });

    macosOnly('sends "key code 125" for the ArrowDown key', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'ArrowDown', 'ArrowDown');

      // Assert
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('key code 125');
    });

    macosOnly('sends "key code 53" for the Escape key', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Escape', 'Escape');

      // Assert
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('key code 53');
    });

    macosOnly('sends keystroke for a single printable character', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'a', 'KeyA');

      // Assert — uses keystroke, not key code
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('keystroke "a"');
      expect(scriptArg[1]).not.toContain('key code');
    });

    macosOnly('exec is called exactly once for valid keys (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter');

      // Assert — exactly 1 exec call
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('does NOT call exec for multi-character unsupported keys like "Shift"', async () => {
      // Arrange — no mockResolvedValueOnce needed; exec should never be called

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Shift', 'ShiftLeft');

      // Assert — zero exec calls because 'Shift' is not in the special key map and has length > 1
      expect(mockExec).toHaveBeenCalledTimes(0);
    });

    macosOnly('does NOT call exec for "Control" modifier key', async () => {
      // Act
      await service.sendKeyEvent('TEST-UDID', 'Control', 'ControlLeft');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(0);
    });

    macosOnly('does NOT call exec for "Meta" modifier key', async () => {
      // Act
      await service.sendKeyEvent('TEST-UDID', 'Meta', 'MetaLeft');

      // Assert
      expect(mockExec).toHaveBeenCalledTimes(0);
    });

    macosOnly('the AppleScript wraps the key event in a System Events tell block targeting Simulator', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter');

      // Assert
      const scriptArg = mockExec.mock.calls[0]![1] as string[];
      expect(scriptArg[1]).toContain('tell application "System Events"');
      expect(scriptArg[1]).toContain('tell process "Simulator"');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange
      mockExec.mockRejectedValueOnce(new Error('osascript: application not running'));

      // Act & Assert
      await expect(
        service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter'),
      ).rejects.toThrow('application not running');
    });
  });
});
