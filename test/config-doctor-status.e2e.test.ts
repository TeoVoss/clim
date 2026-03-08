import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  run,
  createTempHome,
  cleanupTempHome,
  loginTestUser,
  stopDaemon,
} from './helpers.js';

describe('config & doctor & status (E2E)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    home = await createTempHome();
    env = await loginTestUser(home);
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(home);
    await cleanupTempHome(home);
  });

  it('config (default) should display settings as text', async () => {
    const result = await run(['config'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('provisioningUrl');
    expect(result.stdout).toContain('localhost:3000');
  });

  it('config set and get should round-trip', async () => {
    await run(['config', 'set', 'timeout', '60'], { env });

    const result = await run(['config', 'get', 'timeout'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('60');
  });

  it('config set with --json should return structured output', async () => {
    const result = await run(['config', 'set', 'defaultAgent', 'Shadow', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.key).toBe('defaultAgent');
    expect(json.value).toBe('Shadow');
  });

  it('config set with invalid key should fail', async () => {
    const result = await run(['config', 'set', 'invalidKey', 'value'], { env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid config key/i);
  });

  it('status should check system components (--json)', async () => {
    const result = await run(['status', '--json'], { env });
    const checks = JSON.parse(result.stdout);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);

    const profileCheck = checks.find((c: { label: string }) => c.label === 'Profile');
    expect(profileCheck).toBeTruthy();
    expect(profileCheck.ok).toBe(true);
  });

  it('status with daemon should show Daemon and Matrix', async () => {
    await run(['daemon', 'start'], { env, timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 3000));

    const result = await run(['status', '--json'], { env });
    const checks = JSON.parse(result.stdout) as Array<{ label: string; ok: boolean }>;

    const daemonCheck = checks.find((c) => c.label === 'Daemon');
    expect(daemonCheck).toBeTruthy();
    expect(daemonCheck!.ok).toBe(true);

    const matrixCheck = checks.find((c) => c.label === 'Matrix Sync');
    expect(matrixCheck).toBeTruthy();
    expect(matrixCheck!.ok).toBe(true);
  }, 30_000);

  it('doctor --json should return structured diagnostics', async () => {
    const result = await run(['doctor', '--json'], { env, timeout: 30_000 });
    expect(result.exitCode).toBe(0);

    const data = JSON.parse(result.stdout) as {
      version: string;
      checks: Array<{ name: string; status: string }>;
      summary: { passed: number; warnings: number; failed: number };
    };

    expect(data.version).toBeTruthy();
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.checks.length).toBeGreaterThan(0);
    expect(data.summary.passed).toBeGreaterThan(0);
  }, 30_000);
});
