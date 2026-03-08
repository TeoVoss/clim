import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  run,
  runJson,
  createTempHome,
  cleanupTempHome,
  loginTestUser,
  stopDaemon,
  startDaemonAndWaitForSync,
  getFirstAgentRoomName,
} from './helpers.js';

describe('chat commands (E2E)', () => {
  let home: string;
  let env: Record<string, string>;
  let agentName: string;

  beforeAll(async () => {
    home = await createTempHome();
    env = await loginTestUser(home);
    await startDaemonAndWaitForSync(env);
    agentName = await getFirstAgentRoomName(env);
  }, 60_000);

  afterAll(async () => {
    await stopDaemon(home);
    await cleanupTempHome(home);
  });

  it('chat to agent should send message successfully', async () => {
    const result = await run(
      ['chat', agentName, 'say hello in one short sentence', '--no-wait', '--json'],
      { env, timeout: 30_000 },
    );
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.sent).toBe(true);
    expect(json.eventId).toBeTruthy();
  }, 30_000);

  // This test depends on Gateway AI actually responding within timeout.
  // Skip by default: requires full-reset to clear device platform-pinning.
  // Run manually with: npx vitest run test/chat.e2e.test.ts -t 'chat --wait'
  it.skip('chat --wait should receive a reply from agent', async () => {
    const result = await run(
      ['chat', agentName, 'reply with exactly: pong', '--wait', '--timeout', '60', '--json'],
      { env, timeout: 90_000 },
    );
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.sent).toBe(true);
    expect(json.reply).toBeTruthy();
    expect(json.reply.body).toBeTruthy();
    expect(json.reply.body.length).toBeGreaterThan(0);
  }, 90_000);

  it('chat --no-wait should send without waiting', async () => {
    const result = await run(
      ['chat', agentName, 'ping', '--no-wait', '--json'],
      { env, timeout: 30_000 },
    );
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.sent).toBe(true);
    expect(json.reply).toBeNull();
  }, 30_000);

  it('chat with stdin pipe should work', async () => {
    const result = await run(
      ['chat', agentName, '--no-wait', '--json'],
      { env, timeout: 30_000, stdin: 'hello from stdin' },
    );
    expect(result.exitCode).toBe(0);

    const json = JSON.parse(result.stdout);
    expect(json.sent).toBe(true);
  }, 30_000);

  it('chat to nonexistent target should fail with NOT_FOUND', async () => {
    const result = await run(
      ['chat', 'nonexistent_agent_xyz_99', 'ping', '--no-wait', '--json'],
      { env, timeout: 30_000 },
    );
    // With multiple agent rooms, resolveTarget cannot fall back to a single agent
    // so this should fail with NOT_FOUND (exit code 6)
    expect(result.exitCode).toBe(6);
  }, 30_000);
});
