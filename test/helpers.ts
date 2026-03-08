/**
 * E2E test helpers — runs the compiled CLI binary and parses output.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli.mjs');

export const TEST_EMAIL = 'cong@wepie.com';
export const TEST_PASSWORD = '123456';
export const PROVISIONING_URL = 'http://localhost:3000';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run clim CLI with given args. Returns stdout, stderr, exitCode.
 * Sets CLIM_HOME to an isolated temp dir unless overridden via env.
 */
export function run(
  args: string[],
  opts?: { env?: Record<string, string>; timeout?: number; stdin?: string },
): Promise<RunResult> {
  const timeout = opts?.timeout ?? 30_000;
  const env = {
    ...process.env,
    ...opts?.env,
  };

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { env, timeout, maxBuffer: 4 * 1024 * 1024 } satisfies ExecFileOptions,
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error && typeof error.code === 'number'
          ? error.code
          : error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );

    if (opts?.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else if (child.stdin) {
      // Close stdin immediately so readStdin() in the CLI doesn't hang
      // waiting for EOF on a pipe that never closes.
      child.stdin.end();
    }
  });
}

/** Run clim and parse --json stdout output */
export async function runJson<T = unknown>(
  args: string[],
  opts?: { env?: Record<string, string>; timeout?: number },
): Promise<{ data: T; stderr: string; exitCode: number }> {
  const result = await run(args, opts);
  let data: T;
  try {
    data = JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `Failed to parse JSON output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nexitCode: ${result.exitCode}`,
    );
  }
  return { data, stderr: result.stderr, exitCode: result.exitCode };
}

/** Create a fresh isolated CLIM_HOME in /tmp for test isolation */
export async function createTempHome(): Promise<string> {
  const dir = join(tmpdir(), `clim-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a temp CLIM_HOME */
export async function cleanupTempHome(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Login with test credentials into a specific CLIM_HOME.
 * Returns the env dict to pass to subsequent commands.
 */
export async function loginTestUser(home: string): Promise<Record<string, string>> {
  const env = { HOME: home };
  // Override provisioningUrl to localhost for E2E tests (default is now cloud)
  await run(
    ['config', 'set', 'provisioningUrl', PROVISIONING_URL],
    { env, timeout: 10_000 },
  );
  const result = await run(
    ['login', '--email', TEST_EMAIL, '--password', TEST_PASSWORD, '--json'],
    { env, timeout: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Login failed: ${result.stderr}\n${result.stdout}`);
  }
  return env;
}

/**
 * Ensure daemon is stopped for a given home.
 */
export async function stopDaemon(home: string): Promise<void> {
  await run(['daemon', 'stop'], { env: { HOME: home }, timeout: 10_000 });
}

/**
 * Start daemon and poll `rooms --json` until at least one room appears.
 * Needed because Matrix sync takes a few seconds after daemon launch.
 */
export async function startDaemonAndWaitForSync(
  env: Record<string, string>,
  maxWaitMs = 30_000,
): Promise<void> {
  await run(['daemon', 'start'], { env, timeout: 30_000 });

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await run(['rooms', '--json'], { env, timeout: 5_000 });
    if (result.exitCode === 0) {
      try {
        const rooms = JSON.parse(result.stdout) as unknown[];
        if (rooms.length > 0) return;
      } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Daemon did not sync any rooms within timeout');
}

/**
 * Get the name of the first agent room from daemon.
 * Must be called after startDaemonAndWaitForSync.
 */
export async function getFirstAgentRoomName(env: Record<string, string>): Promise<string> {
  const result = await run(['rooms', '--json'], { env, timeout: 5_000 });
  if (result.exitCode !== 0) throw new Error(`rooms --json failed: ${result.stderr}`);
  const rooms = JSON.parse(result.stdout) as Array<{ name: string; type: string }>;
  const agent = rooms.find((r) => r.type === 'agent');
  if (!agent) throw new Error('No agent room found');
  return agent.name;
}
