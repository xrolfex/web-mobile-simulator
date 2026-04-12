import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Result of a successful shell command execution. */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute a CLI command safely using `execFile` (no shell injection risk).
 * Resolves with stdout/stderr on success; throws with a descriptive message
 * on non-zero exit code.
 *
 * @param command - The executable to run (e.g. "xcrun").
 * @param args    - Argument list passed directly to the process.
 * @param options - Optional `execFile` options (env, cwd, timeout, …).
 * @returns Resolved stdout and stderr as plain strings.
 */
export async function exec(
  command: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<ExecResult> {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024, // 10 MB — simctl JSON can be large
      ...options,
    });
    return {
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? '',
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${err.stderr ?? err.message ?? String(error)}`,
    );
  }
}

/**
 * Execute a CLI command and parse its stdout as JSON.
 * Throws if the command fails or stdout is not valid JSON.
 *
 * @param command - The executable to run.
 * @param args    - Argument list passed directly to the process.
 * @param options - Optional `execFile` options.
 * @returns The parsed JSON value cast to `T`.
 */
export async function execJSON<T>(
  command: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<T> {
  const { stdout } = await exec(command, args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(
      `Failed to parse JSON output from: ${command} ${args.join(' ')}\n` +
        `Output: ${stdout.slice(0, 500)}`,
    );
  }
}
