import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock exec utilities before importing the service
// ---------------------------------------------------------------------------

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execJSON: vi.fn(),
}));

import { IOSSimulatorService } from './ios-simulator.js';
import { exec, execJSON } from '../utils/exec.js';

const mockExec = exec as ReturnType<typeof vi.fn>;
const mockExecJSON = execJSON as ReturnType<typeof vi.fn>;

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
      );
    });
  });

  // -------------------------------------------------------------------------
  // createDevice()
  // -------------------------------------------------------------------------

  describe('createDevice()', () => {
    macosOnly('returns the UDID from stdout (trimmed)', async () => {
      const udid = 'FFFFFFFF-0000-0000-0000-FFFFFFFFFFFF';
      mockExec.mockResolvedValue({ stdout: `${udid}\n`, stderr: '' });

      const result = await service.createDevice(
        'Test iPhone',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
      );

      expect(result).toBe(udid);
    });

    macosOnly('calls exec with correct simctl create arguments', async () => {
      const udid = 'AAAAAAAA-1111-1111-1111-AAAAAAAAAAAA';
      mockExec.mockResolvedValue({ stdout: udid, stderr: '' });

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
      ]);
    });

    macosOnly('throws if stdout is empty', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      await expect(
        service.createDevice(
          'Empty Output Device',
          'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        ),
      ).rejects.toThrow('simctl create returned empty output');
    });

    macosOnly('throws if stdout is only whitespace', async () => {
      mockExec.mockResolvedValue({ stdout: '   \n  ', stderr: '' });

      await expect(
        service.createDevice(
          'Whitespace Device',
          'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        ),
      ).rejects.toThrow('simctl create returned empty output');
    });

    macosOnly('propagates exec() failures', async () => {
      mockExec.mockRejectedValue(new Error('Command failed: xcrun simctl create'));

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
});
