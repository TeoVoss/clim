import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  run,
  runJson,
  createTempHome,
  cleanupTempHome,
  stopDaemon,
  TEST_EMAIL,
  TEST_PASSWORD,
  PROVISIONING_URL,
} from './helpers.js';

describe('auth commands (E2E)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    home = await createTempHome();
    env = { HOME: home };
    // Point to local Provisioning for E2E tests
    await run(['config', 'set', 'provisioningUrl', PROVISIONING_URL], { env, timeout: 10_000 });
  });

  afterAll(async () => {
    await stopDaemon(home);
    await cleanupTempHome(home);
  });

  it('whoami should fail when not logged in', async () => {
    const result = await run(['whoami'], { env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not logged in/i);
  });

  it('login with valid credentials should succeed', async () => {
    const result = await run(
      ['login', '--email', TEST_EMAIL, '--password', TEST_PASSWORD, '--json'],
      { env, timeout: 30_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/logged in/i);

    const json = JSON.parse(result.stdout);
    expect(json.ok).toBe(true);
    expect(json.email).toBe(TEST_EMAIL);
    expect(json.userId).toBeTruthy();
  });

  it('whoami should show identity after login', async () => {
    const result = await run(['whoami'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain(TEST_EMAIL);
  });

  it('whoami --json should return structured data', async () => {
    const { data } = await runJson<{
      email: string;
      userId: string;
      matrixCredentials: { userId: string };
      gatewayUrl: string;
    }>(['whoami', '--json'], { env });

    expect(data.email).toBe(TEST_EMAIL);
    expect(data.userId).toBeTruthy();
    expect(data.matrixCredentials.userId).toMatch(/@.+:.+/);
    expect(data.gatewayUrl).toMatch(/^ws:\/\//);
  });

  it('login with wrong password should fail', async () => {
    const wrongHome = await createTempHome();
    const result = await run(
      ['login', '--email', TEST_EMAIL, '--password', 'wrong_password'],
      { env: { HOME: wrongHome } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid|failed/i);
    await cleanupTempHome(wrongHome);
  });

  it('login with unreachable server should fail', async () => {
    const badHome = await createTempHome();
    // Write config that points to unreachable provisioning URL
    const climDir = join(badHome, '.clim');
    await mkdir(climDir, { recursive: true });
    await writeFile(
      join(climDir, 'config.json'),
      JSON.stringify({ provisioningUrl: 'http://localhost:19999' }),
    );
    const result = await run(
      ['login', '--email', TEST_EMAIL, '--password', TEST_PASSWORD],
      { env: { HOME: badHome }, timeout: 15_000 },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/cannot reach|network/i);
    await cleanupTempHome(badHome);
  });

  it('logout should succeed', async () => {
    const result = await run(['logout'], { env });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/logged out/i);
  });

  it('whoami should fail after logout', async () => {
    const result = await run(['whoami'], { env });
    expect(result.exitCode).not.toBe(0);
  });
});
