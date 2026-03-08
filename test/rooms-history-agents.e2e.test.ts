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

describe('rooms & history & agents (E2E)', () => {
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

  // --- rooms ---

  it('rooms should list at least one room', async () => {
    const result = await run(['rooms', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const rooms = JSON.parse(result.stdout);
    expect(Array.isArray(rooms)).toBe(true);
    expect(rooms.length).toBeGreaterThan(0);

    // Every room should have roomId and name
    for (const room of rooms) {
      expect(room.roomId).toBeTruthy();
      expect(room.name).toBeTruthy();
    }
  });

  it('rooms should show agent rooms', async () => {
    const result = await run(['rooms', '--json'], { env });
    const rooms = JSON.parse(result.stdout) as Array<{ type: string }>;
    const agentRooms = rooms.filter((r) => r.type === 'agent');
    expect(agentRooms.length).toBeGreaterThan(0);
  });

  // --- history ---

  it('history should show messages for an agent', async () => {
    // First send a message to ensure there's history
    await run(
      ['chat', agentName, 'test message for history', '--no-wait'],
      { env, timeout: 30_000 },
    );
    await new Promise((r) => setTimeout(r, 1000));

    const result = await run(
      ['history', agentName, '--limit', '5', '--json'],
      { env, timeout: 15_000 },
    );
    expect(result.exitCode).toBe(0);

    const data = JSON.parse(result.stdout);
    expect(data.target).toBeTruthy();
    expect(data.roomId).toBeTruthy();
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);
  }, 30_000);

  it('history for invalid room ID should fail gracefully', async () => {
    // Use a raw room ID that doesn't exist in the daemon's Matrix state.
    // resolveTarget with ! prefix returns immediately (treating it as a room ID),
    // but get_messages will fail because the room doesn't exist.
    const result = await run(
      ['history', '!invalid_room:localhost', '--json'],
      { env },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // --- agents ---

  it('agents list should return agents', async () => {
    const result = await run(['agents', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const data = JSON.parse(result.stdout);
    expect(data.agents).toBeTruthy();
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.agents.length).toBeGreaterThan(0);
  });

  it('agents models should return available models', async () => {
    const result = await run(['agents', 'models', '--json'], { env });
    expect(result.exitCode).toBe(0);

    const data = JSON.parse(result.stdout);
    expect(data.models).toBeTruthy();
    expect(Array.isArray(data.models)).toBe(true);
  });
});
