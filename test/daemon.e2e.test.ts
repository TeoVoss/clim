import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  run,
  runJson,
  createTempHome,
  cleanupTempHome,
  loginTestUser,
  stopDaemon,
} from './helpers.js';

describe('daemon commands (E2E)', () => {
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

  it('daemon start should launch the daemon process', async () => {
    const result = await run(['daemon', 'start'], { env, timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/started|running|pid/i);
  }, 30_000);

  it('daemon status should show running', async () => {
    const result = await run(['daemon', 'status', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.running).toBe(true);
    expect(json.pid).toBeGreaterThan(0);
  });

  it('daemon stop should terminate the daemon', async () => {
    const result = await run(['daemon', 'stop'], { env, timeout: 10_000 });
    expect(result.exitCode).toBe(0);
  });

  it('daemon status should show not running after stop', async () => {
    const result = await run(['daemon', 'status', '--json'], { env });
    const json = JSON.parse(result.stdout);
    expect(json.running).toBe(false);
  });

  it('daemon stop+start should work as manual restart', async () => {
    await run(['daemon', 'start'], { env, timeout: 30_000 });

    const stopResult = await run(['daemon', 'stop'], { env, timeout: 10_000 });
    expect(stopResult.exitCode).toBe(0);

    const startResult = await run(['daemon', 'start'], { env, timeout: 30_000 });
    expect(startResult.exitCode).toBe(0);
    expect(startResult.stderr).toMatch(/started|running|pid/i);
  }, 60_000);
});
