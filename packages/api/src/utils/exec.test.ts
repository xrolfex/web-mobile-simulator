import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock node:child_process so that promisify(execFile) wraps our vi.fn()
// We do NOT mock node:util — promisify must do its real callback→Promise work.
// Our execFile mock must accept (cmd, args, opts, callback) so promisify can
// attach a callback and convert the call to a Promise.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { exec, execJSON } from './exec.js';
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

type ExecCallback = (
  err: null | (Error & { stderr?: string }),
  result?: { stdout: string | undefined; stderr: string | undefined },
) => void;

/**
 * Make `execFile` invoke its callback as if the command succeeded.
 * promisify will have added the 4th `callback` arg automatically.
 */
function mockSuccess(stdout: string, stderr = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: ExecFileOptions,
      callback: ExecCallback,
    ) => {
      callback(null, { stdout, stderr });
    },
  );
}

/**
 * Make `execFile` invoke its callback as if the command failed (non-zero exit).
 */
function mockFailure(stderr: string, message = 'Command failed'): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: ExecFileOptions,
      callback: ExecCallback,
    ) => {
      const err = Object.assign(new Error(message), { stderr });
      callback(err);
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exec()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stdout and stderr on successful execution', async () => {
    mockSuccess('hello world', 'some warning');

    const result = await exec('echo', ['hello', 'world']);

    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('some warning');
  });

  it('returns empty strings for stdout/stderr when not provided', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: ExecFileOptions,
        callback: ExecCallback,
      ) => {
        callback(null, { stdout: undefined, stderr: undefined });
      },
    );

    const result = await exec('true', []);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('throws a descriptive error including command name and args on failure', async () => {
    mockFailure('xcrun: error: invalid active developer path', 'Command failed with exit code 1');

    await expect(exec('xcrun', ['simctl', 'list'])).rejects.toThrow(
      'Command failed: xcrun simctl list',
    );
  });

  it('includes stderr in the thrown error message', async () => {
    const stderrMsg = 'permission denied: /dev/null';
    mockFailure(stderrMsg);

    await expect(exec('cat', ['/dev/null'])).rejects.toThrow(stderrMsg);
  });

  it('falls back to err.message when stderr is absent', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: ExecFileOptions,
        callback: ExecCallback,
      ) => {
        callback(new Error('ENOENT: no such file or directory'));
      },
    );

    await expect(exec('nonexistent-bin', [])).rejects.toThrow(
      'ENOENT: no such file or directory',
    );
  });

  it('passes options through to execFile', async () => {
    mockSuccess('output');

    const options: ExecFileOptions = { cwd: '/tmp', timeout: 5000 };
    await exec('ls', ['-la'], options);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ls',
      ['-la'],
      expect.objectContaining({ cwd: '/tmp', timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('always applies 10 MB maxBuffer option', async () => {
    mockSuccess('big output');

    await exec('xcrun', ['simctl', 'list', '-j']);

    expect(mockExecFile).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'list', '-j'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------

describe('execJSON()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses and returns valid JSON stdout', async () => {
    const payload = { devicetypes: [{ name: 'iPhone 15', identifier: 'com.apple.dt.iPhone15' }] };
    mockSuccess(JSON.stringify(payload));

    const result = await execJSON<typeof payload>('xcrun', ['simctl', 'list', 'devicetypes', '-j']);

    expect(result).toEqual(payload);
  });

  it('handles nested JSON structures', async () => {
    const payload = {
      runtimes: [
        { name: 'iOS 17.5', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', isAvailable: true },
      ],
    };
    mockSuccess(JSON.stringify(payload));

    const result = await execJSON<typeof payload>('xcrun', ['simctl', 'list', 'runtimes', '-j']);

    expect(result.runtimes).toHaveLength(1);
    expect(result.runtimes[0]!.name).toBe('iOS 17.5');
  });

  it('throws when stdout is not valid JSON', async () => {
    mockSuccess('this is not json { bad ]');

    await expect(
      execJSON('xcrun', ['simctl', 'list', '-j']),
    ).rejects.toThrow('Failed to parse JSON output from: xcrun simctl list -j');
  });

  it('includes partial stdout in the parse-failure error message', async () => {
    const invalidOutput = 'Error: xcrun command not found\n' + 'some more output';
    mockSuccess(invalidOutput);

    await expect(
      execJSON('xcrun', ['simctl', 'list', '-j']),
    ).rejects.toThrow('Output: Error: xcrun command not found');
  });

  it('propagates exec() errors when the command itself fails', async () => {
    mockFailure('xcrun not found');

    await expect(
      execJSON('xcrun', ['simctl', 'list', '-j']),
    ).rejects.toThrow('Command failed: xcrun simctl list -j');
  });

  it('returns a plain object for a minimal JSON object payload', async () => {
    mockSuccess('{}');

    const result = await execJSON<Record<string, unknown>>('echo', ['{}']);

    expect(result).toEqual({});
  });

  it('returns an array when JSON stdout is an array', async () => {
    mockSuccess('[1, 2, 3]');

    const result = await execJSON<number[]>('echo', ['[1,2,3]']);

    expect(result).toEqual([1, 2, 3]);
  });
});
