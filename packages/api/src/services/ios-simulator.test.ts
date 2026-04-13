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

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { IOSSimulatorService } from './ios-simulator.js';
import { exec, execJSON } from '../utils/exec.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const mockExec = exec as ReturnType<typeof vi.fn>;
const mockExecJSON = execJSON as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;

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
    // Prevent cached geometry from leaking between tests.
    service.invalidateGeometryCache();
    // Make ensureInputBinary() believe the binary is already compiled so it
    // doesn't add an extra exec('swiftc', …) call in tests that don't need it.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('4'); // Current version matches INPUT_BINARY_VERSION
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
    macosOnly('calls precompiled binary with shortcut cmd,shift+H for home button', async () => {
      // Arrange — pressButton does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — exec called with binary and shortcut args for home (kVK_ANSI_H = 4, cmd+shift)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '4', 'cmd,shift']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+L for lock button', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'lock');

      // Assert — binary called with shortcut for Lock Screen (kVK_ANSI_L = 37, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '37', 'cmd']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+Up for volumeUp', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'volumeUp');

      // Assert — binary called with shortcut for Volume Up (kVK_UpArrow = 126, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '126', 'cmd']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+Down for volumeDown', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'volumeDown');

      // Assert — binary called with shortcut for Volume Down (kVK_DownArrow = 125, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '125', 'cmd']);
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — exactly 1 exec call: just the binary shortcut invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('uses precompiled binary with shortcut command', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.pressButton('TEST-UDID', 'home');

      // Assert — the binary path contains 'wms-ios-input' and first arg is 'shortcut'
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args[0]).toBe('shortcut');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — make the single binary call reject
      mockExec.mockRejectedValueOnce(new Error('binary: execution error'));

      // Act & Assert
      await expect(service.pressButton('TEST-UDID', 'home')).rejects.toThrow(
        'binary: execution error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // setOrientation()
  // -------------------------------------------------------------------------

  describe('setOrientation(udid, orientation)', () => {
    macosOnly('calls precompiled binary with shortcut cmd+Left (123) for landscapeLeft', async () => {
      // Arrange — setOrientation does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — binary called with shortcut for Rotate Left (kVK_LeftArrow = 123, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '123', 'cmd']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+Right (124) for landscapeRight', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeRight');

      // Assert — binary called with shortcut for Rotate Right (kVK_RightArrow = 124, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '124', 'cmd']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+Right (124) for portrait (best-effort)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'portrait');

      // Assert — portrait maps to a best-effort Rotate Right (kVK_RightArrow = 124, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '124', 'cmd']);
    });

    macosOnly('calls precompiled binary with shortcut cmd+Left (123) for portraitUpsideDown (best-effort)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'portraitUpsideDown');

      // Assert — portraitUpsideDown maps to a best-effort Rotate Left (kVK_LeftArrow = 123, cmd)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '123', 'cmd']);
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — exactly 1 exec call: just the binary shortcut invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('uses precompiled binary with shortcut command and cmd modifier', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.setOrientation('TEST-UDID', 'landscapeLeft');

      // Assert — the binary path contains 'wms-ios-input', first arg is 'shortcut', third is 'cmd'
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args[0]).toBe('shortcut');
      expect(args[2]).toBe('cmd');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — make the single binary call reject
      mockExec.mockRejectedValueOnce(new Error('binary: execution error'));

      // Act & Assert
      await expect(service.setOrientation('TEST-UDID', 'landscapeLeft')).rejects.toThrow(
        'binary: execution error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // shake()
  // -------------------------------------------------------------------------

  describe('shake(udid)', () => {
    macosOnly('calls precompiled binary with shortcut cmd,ctrl+Z (6) for Device > Shake', async () => {
      // Arrange — shake does NOT call assertSimctlAvailable; only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — binary called with shortcut for Shake (kVK_ANSI_Z = 6, cmd+ctrl)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['shortcut', '6', 'cmd,ctrl']);
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — exactly 1 exec call: just the binary shortcut invocation
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('propagates exec failures directly (no custom error message)', async () => {
      // Arrange — make the single binary call reject with a raw error
      mockExec.mockRejectedValueOnce(new Error('binary error'));

      // Act — capture the thrown error
      let thrownError: unknown;
      try {
        await service.shake('TEST-UDID');
      } catch (err) {
        thrownError = err;
      }

      // Assert — error propagates as-is: message is 'binary error',
      // NOT wrapped in "Shake gesture is not supported"
      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe('binary error');
      expect((thrownError as Error).message).not.toContain('Shake gesture is not supported');
    });

    macosOnly('uses precompiled binary with shortcut command', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.shake('TEST-UDID');

      // Assert — the binary path contains 'wms-ios-input' and first arg is 'shortcut'
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args[0]).toBe('shortcut');
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
    macosOnly('calls precompiled binary with type command (not xcrun simctl)', async () => {
      // Arrange — sendText does NOT call assertSimctlAvailable, so only 1 exec call needed
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'Hello World');

      // Assert — first (and only) call is the precompiled binary with 'type' command
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['type', 'Hello World']);
    });

    macosOnly('passes the full text as a single argument to the binary type command (preserving spaces)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'hello world test');

      // Assert — the binary is called with ['type', 'hello world test']
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['type', 'hello world test']);
    });

    macosOnly('exec is called exactly once (no assertSimctlAvailable, just binary type)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'hello');

      // Assert — only 1 exec call: the binary type command
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    macosOnly('passes text with backslashes raw to the binary (no escaping needed)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'path\\to\\file');

      // Assert — text is passed as-is to the binary (no AppleScript escaping)
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['type', 'path\\to\\file']);
    });

    macosOnly('passes text with double-quotes raw to the binary (no escaping needed)', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendText('TEST-UDID', 'say "hello"');

      // Assert — text is passed as-is to the binary (no AppleScript escaping)
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['type', 'say "hello"']);
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — sendText makes exactly 1 exec call; make it reject
      mockExec.mockRejectedValueOnce(new Error('binary: execution error'));

      // Act & Assert
      await expect(service.sendText('TEST-UDID', 'hello')).rejects.toThrow('binary: execution error');
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

      // Assert — third call hides the Simulator toolbar via the precompiled binary
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('wms-ios-input'),
        ['toolbar-hide'],
        { timeout: 5_000 },
      );

      vi.useRealTimers();
    });

    macosOnly('exec is called exactly three times: defaults write, open, and binary toolbar hide', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — 3 exec calls: defaults write, open, binary (toolbar hide)
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

    macosOnly('hides the Simulator toolbar via precompiled binary after launch', async () => {
      // Arrange
      vi.useFakeTimers();
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      // Act
      const promise = service.openSimulatorApp('TEST-UDID');
      await vi.runAllTimersAsync();
      await promise;

      // Assert — third call is the precompiled binary with toolbar-hide command
      expect(mockExec.mock.calls[2]![0]).toContain('wms-ios-input');
      const toolbarArgs = mockExec.mock.calls[2]![1] as string[];
      expect(toolbarArgs).toEqual(['toolbar-hide']);

      vi.useRealTimers();
    });

    macosOnly('resolves successfully even when the toolbar binary call throws (best-effort)', async () => {
      // Arrange — defaults write and open succeed; binary (toolbar) throws
      vi.useFakeTimers();
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' })  // defaults write
        .mockResolvedValueOnce({ stdout: '', stderr: '' })  // open -a Simulator
        .mockRejectedValueOnce(new Error('binary: execution error: Simulator window not ready'));  // toolbar hide fails

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
    // Window geometry returned by binary: windowX=100, windowY=150, windowWidth=400, windowHeight=880
    // screenX = windowX + normX * windowWidth
    // screenY = windowY + normY * windowHeight
    const GEO_STDOUT = '100,150,400,880';

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

      // Assert — second exec call is the precompiled binary with computed screen coords
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const tapArgs = mockExec.mock.calls[1]![1] as string[];
      expect(tapArgs).toEqual(['tap', '300', '590']);
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

      // Assert — second exec call is the precompiled binary with computed screen coords
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const tapArgs = mockExec.mock.calls[1]![1] as string[];
      expect(tapArgs).toEqual(['tap', '100', '150']);
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

      // Assert — second exec call is the precompiled binary with computed screen coords
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const tapArgs = mockExec.mock.calls[1]![1] as string[];
      expect(tapArgs).toEqual(['tap', '500', '1030']);
    });

    macosOnly('second exec call uses precompiled CGEvent binary (not osascript click)', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — second call is the precompiled binary (not swift -e or osascript)
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const tapArgs = mockExec.mock.calls[1]![1] as string[];
      expect(tapArgs[0]).toBe('tap');
    });

    macosOnly('throws when geometry binary returns unparseable output', async () => {
      // Arrange — geometry call returns invalid output → throws immediately (no fallback)
      mockExec
        .mockResolvedValueOnce({ stdout: 'invalid output', stderr: '' }); // geometry fails to parse → throws

      // Act & Assert
      await expect(service.sendTap('TEST-UDID', 0.5, 0.5)).rejects.toThrow(
        'Failed to parse Simulator window geometry',
      );
    });

    macosOnly('throws when the geometry exec call fails', async () => {
      // Arrange — geometry query rejects → error propagates (no fallback)
      mockExec
        .mockRejectedValueOnce(new Error('binary: Simulator is not running')); // geometry throws → propagates

      // Act & Assert
      await expect(service.sendTap('TEST-UDID', 0.5, 0.5)).rejects.toThrow(
        'Simulator is not running',
      );
    });

    macosOnly('correctly uses 4-value geometry output (windowX, windowY, windowWidth, windowHeight)', async () => {
      // Arrange: geometry returns 4 values; verify coordinate mapping
      // screenX = windowX + normX * windowWidth = 100 + 0.5 * 400 = 300
      // screenY = windowY + normY * windowHeight = 150 + 0.5 * 880 = 590
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // precompiled binary tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — the tap call uses coordinates derived from the 4-value geometry
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const tapArgs = mockExec.mock.calls[1]![1] as string[];
      expect(tapArgs).toEqual(['tap', '300', '590']);
    });

    macosOnly('compiles the input binary when it is not cached', async () => {
      // Arrange — binary does not exist; flow: swiftc → geometry → tap
      mockExistsSync.mockReturnValue(false);
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' })         // swiftc compilation
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry
        .mockResolvedValueOnce({ stdout: '', stderr: '' });        // binary tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — swiftc was called to compile (first exec call)
      expect(mockExec).toHaveBeenCalledTimes(3);
      expect(mockExec.mock.calls[0]![0]).toBe('swiftc');
      // writeFileSync was called to write source and version
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    macosOnly('recompiles when binary exists but version is stale', async () => {
      // Arrange — binary exists but version doesn't match; flow: swiftc → geometry → tap
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('0'); // stale version (current is '2')
      mockExec
        .mockResolvedValueOnce({ stdout: '', stderr: '' })          // swiftc recompilation
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // binary tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — swiftc was called to recompile (first exec call)
      expect(mockExec).toHaveBeenCalledTimes(3);
      expect(mockExec.mock.calls[0]![0]).toBe('swiftc');
      expect(mockWriteFileSync).toHaveBeenCalled();

      // Restore defaults for other tests
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('4');
    });
  });

  // -------------------------------------------------------------------------
  // sendSwipe()
  // -------------------------------------------------------------------------

  describe('sendSwipe(udid, normX1, normY1, normX2, normY2, durationMs)', () => {
    // Window: x=100, y=150, w=400, h=880
    const GEO_STDOUT = '100,150,400,880';

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

    macosOnly('second exec call uses precompiled CGEvent binary', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0);

      // Assert — second call is the precompiled binary (not swift -e)
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
    });

    macosOnly('passes correct screen coordinates to the precompiled binary', async () => {
      // Arrange
      // startX = round(100 + 0.0 * 400) = 100
      // startY = round(150 + 0.0 * 880) = 150
      // endX   = round(100 + 1.0 * 400) = 500
      // endY   = round(150 + 1.0 * 880) = 1030
      // steps     = Math.max(5, Math.round(300 / 30)) = 10
      // stepDelay = (300 / 1000) / 10 = 0.03
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert — second exec call is precompiled binary with correct args
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const swipeArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swipeArgs).toEqual(['swipe', '100', '150', '500', '1030', '10', '0.03']);
    });

    macosOnly('calls precompiled binary with swipe command', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert — binary is called with 'swipe' as the first argument.
      // (Simulator activation is baked into the precompiled binary itself.)
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const swipeArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swipeArgs[0]).toBe('swipe');
    });

    macosOnly('correctly uses 4-value geometry output for swipe coordinate mapping', async () => {
      // Arrange: geometry returns 4 values; verify coordinate mapping for swipe
      // startX = round(100 + 0.0 * 400) = 100
      // startY = round(150 + 0.0 * 880) = 150
      // endX   = round(100 + 1.0 * 400) = 500
      // endY   = round(150 + 1.0 * 880) = 1030
      // steps     = Math.max(5, Math.round(300 / 30)) = 10
      // stepDelay = (300 / 1000) / 10 = 0.03
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry (4 values)
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // precompiled binary swipe

      // Act
      await service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0, 300);

      // Assert — binary is called with swipe args derived from 4-value geometry
      const binaryPath = mockExec.mock.calls[1]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const swipeArgs = mockExec.mock.calls[1]![1] as string[];
      expect(swipeArgs).toEqual(['swipe', '100', '150', '500', '1030', '10', '0.03']);
    });

    macosOnly('propagates geometry exec failure as thrown error', async () => {
      // Arrange — geometry query rejects → error propagates (no fallback)
      mockExec
        .mockRejectedValueOnce(new Error('binary: Simulator not found')); // geometry throws → propagates

      // Act & Assert
      await expect(
        service.sendSwipe('TEST-UDID', 0.0, 0.0, 1.0, 1.0),
      ).rejects.toThrow('Simulator not found');
    });
  });

  // -------------------------------------------------------------------------
  // geometry caching (getSimulatorContentGeometry TTL)
  // -------------------------------------------------------------------------

  describe('geometry caching (getSimulatorContentGeometry TTL)', () => {
    const GEO_STDOUT = '100,150,400,880';

    macosOnly('reuses cached geometry on consecutive taps without re-querying', async () => {
      // Arrange — provide geometry once, then binary calls
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry (first tap)
        .mockResolvedValueOnce({ stdout: '', stderr: '' })         // binary tap (first tap)
        .mockResolvedValueOnce({ stdout: '', stderr: '' });        // binary tap (second tap — no geometry query!)

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);
      await service.sendTap('TEST-UDID', 0.3, 0.7);

      // Assert — only 3 exec calls total (1 geometry + 2 taps), NOT 4 (2 geometry + 2 taps)
      expect(mockExec).toHaveBeenCalledTimes(3);
      // First call is geometry (precompiled binary)
      expect(mockExec.mock.calls[0]![0]).toContain('wms-ios-input');
      // Second call is first tap
      const tap1Args = mockExec.mock.calls[1]![1] as string[];
      expect(tap1Args[0]).toBe('tap');
      // Third call is second tap (no geometry query before it!)
      const tap2Args = mockExec.mock.calls[2]![1] as string[];
      expect(tap2Args[0]).toBe('tap');
    });

    macosOnly('invalidateGeometryCache() forces re-query on next interaction', async () => {
      // Arrange
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry (first tap)
        .mockResolvedValueOnce({ stdout: '', stderr: '' })         // binary tap
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // geometry (re-query after invalidation)
        .mockResolvedValueOnce({ stdout: '', stderr: '' });        // binary tap

      // Act
      await service.sendTap('TEST-UDID', 0.5, 0.5);
      service.invalidateGeometryCache();
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // Assert — 4 exec calls: geometry + tap + geometry + tap
      expect(mockExec).toHaveBeenCalledTimes(4);
      expect(mockExec.mock.calls[0]![0]).toContain('wms-ios-input');
      expect(mockExec.mock.calls[2]![0]).toContain('wms-ios-input');
    });

    macosOnly('re-queries geometry after TTL expires (2 s)', async () => {
      vi.useFakeTimers();
      mockExec
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // first geometry query
        .mockResolvedValueOnce({ stdout: '', stderr: '' })          // tap 1 (binary call)
        .mockResolvedValueOnce({ stdout: GEO_STDOUT, stderr: '' }) // second geometry query (post-TTL)
        .mockResolvedValueOnce({ stdout: '', stderr: '' });         // tap 2 (binary call)

      await service.sendTap('TEST-UDID', 0.5, 0.5);
      vi.advanceTimersByTime(2001);                                 // TTL expired
      await service.sendTap('TEST-UDID', 0.5, 0.5);

      // 4 exec calls: geometry + tap + geometry + tap (geometry re-queried after TTL)
      expect(mockExec).toHaveBeenCalledTimes(4);
      expect(mockExec.mock.calls[0]![0]).toContain('wms-ios-input'); // first geometry
      expect(mockExec.mock.calls[2]![0]).toContain('wms-ios-input'); // second geometry (re-queried)

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // sendKeyEvent()
  // -------------------------------------------------------------------------

  describe('sendKeyEvent(udid, key, code)', () => {
    macosOnly('sends key code 36 for the Enter key via precompiled binary', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter');

      // Assert — binary called with ['key', '36']
      expect(mockExec).toHaveBeenCalledTimes(1);
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['key', '36']);
    });

    macosOnly('sends key code 51 for the Backspace key via precompiled binary', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Backspace', 'Backspace');

      // Assert — binary called with ['key', '51']
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['key', '51']);
    });

    macosOnly('sends key code 126 for the ArrowUp key via precompiled binary', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'ArrowUp', 'ArrowUp');

      // Assert — binary called with ['key', '126']
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['key', '126']);
    });

    macosOnly('sends key code 125 for the ArrowDown key via precompiled binary', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'ArrowDown', 'ArrowDown');

      // Assert — binary called with ['key', '125']
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['key', '125']);
    });

    macosOnly('sends key code 53 for the Escape key via precompiled binary', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Escape', 'Escape');

      // Assert — binary called with ['key', '53']
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['key', '53']);
    });

    macosOnly('sends keystroke command for a single printable character', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'a', 'KeyA');

      // Assert — binary called with ['keystroke', 'a'] (not key code)
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args).toEqual(['keystroke', 'a']);
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

    macosOnly('uses precompiled binary with key command for special keys', async () => {
      // Arrange
      mockExec.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Act
      await service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter');

      // Assert — binary path contains 'wms-ios-input' and first arg is 'key'
      const binaryPath = mockExec.mock.calls[0]![0] as string;
      expect(binaryPath).toContain('wms-ios-input');
      const args = mockExec.mock.calls[0]![1] as string[];
      expect(args[0]).toBe('key');
    });

    macosOnly('propagates exec failures as thrown errors', async () => {
      // Arrange — the binary call rejects
      mockExec.mockRejectedValueOnce(new Error('binary: application not running'));

      // Act & Assert
      await expect(
        service.sendKeyEvent('TEST-UDID', 'Enter', 'Enter'),
      ).rejects.toThrow('application not running');
    });
  });
});
