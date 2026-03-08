import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  run,
  createTempHome,
  cleanupTempHome,
  loginTestUser,
  stopDaemon,
  TEST_EMAIL,
} from './helpers.js';

/**
 * Contacts E2E test.
 *
 * NOTE: contacts add/accept/reject require two separate user accounts.
 * We test listing requests and error handling with a single account.
 * Full friend-request flow requires the second test account (liuhaoyooc@gmail.com).
 */
describe('contacts commands (E2E)', () => {
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

  it('contacts requests should return list (possibly empty)', async () => {
    const result = await run(['contacts', 'requests', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const data = JSON.parse(result.stdout);
    expect(data.requests).toBeDefined();
    expect(Array.isArray(data.requests)).toBe(true);
  });

  it('contacts add to nonexistent user should fail', async () => {
    const result = await run(
      ['contacts', 'add', 'nonexistent_user_xyz_999@example.com', '--json'],
      { env },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('contacts accept with invalid id should fail', async () => {
    const result = await run(
      ['contacts', 'accept', 'invalid-request-id-00000', '--json'],
      { env },
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('contacts reject with invalid id should fail', async () => {
    const result = await run(
      ['contacts', 'reject', 'invalid-request-id-00000'],
      { env },
    );
    expect(result.exitCode).not.toBe(0);
  });
});
