import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson, printSuccess } from '../shared/output.js';
import { ProvisioningClient, ProvisioningError, isNetworkError } from '../client/provisioning.js';
import { loadConfig } from '../shared/config.js';
import { ProfileManager } from '../shared/profile.js';

interface RoomInfo {
  roomId: string;
  name: string;
  type: 'agent' | 'human' | 'unknown';
  unreadCount: number;
  members: Array<{ userId: string; displayName: string }>;
  lastMessage?: {
    sender: string;
    body: string;
    timestamp: number;
    eventId: string;
  };
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}


export function registerRoomsCommand(program: Command): void {
  const rooms = program
    .command('rooms')
    .description('Manage chat rooms');


  rooms
    .command('list', { isDefault: true })
    .description('List chat rooms')
    .option('--json', 'JSON output')
    .option('--unread', 'Only show rooms with unread messages')
    .action(listRoomsAction);


  rooms
    .command('create <members...>')
    .description('Create a group chat (pass contact/agent names)')
    .option('--json', 'JSON output')
    .action(createGroupAction);


  rooms
    .command('invite <room> <members...>')
    .description('Invite members to a group (by contact/agent name)')
    .option('--json', 'JSON output')
    .action(inviteAction);


  rooms
    .command('kick <room> <member>')
    .description('Remove a member from a group')
    .option('--json', 'JSON output')
    .action(kickAction);


  rooms
    .command('members <room>')
    .description('List members of a room')
    .option('--json', 'JSON output')
    .action(membersAction);
}




function resolveNameToMatrixId(
  name: string,
  allRooms: RoomInfo[],
): { matrixUserId: string; displayName: string } | null {
  const lower = name.toLowerCase();

  for (const room of allRooms) {
    for (const member of room.members) {
      if (member.displayName.toLowerCase() === lower) {
        return { matrixUserId: member.userId, displayName: member.displayName };
      }
    }
  }


  for (const room of allRooms) {
    for (const member of room.members) {
      if (member.displayName.toLowerCase().includes(lower)) {
        return { matrixUserId: member.userId, displayName: member.displayName };
      }
    }
  }

  return null;
}


function resolveRoom(nameOrId: string, allRooms: RoomInfo[]): RoomInfo | null {
  if (nameOrId.startsWith('!')) {
    return allRooms.find((r) => r.roomId === nameOrId) ?? null;
  }
  const lower = nameOrId.toLowerCase();
  return (
    allRooms.find((r) => r.name.toLowerCase() === lower) ??
    allRooms.find((r) => r.name.toLowerCase().includes(lower)) ??
    null
  );
}

async function getProvisioningClient(): Promise<{
  client: ProvisioningClient;
  accessToken: string;
}> {
  const config = await loadConfig();
  const profileManager = new ProfileManager();
  const credentials = await profileManager.loadCredentials();
  return {
    client: new ProvisioningClient(config.provisioningUrl),
    accessToken: credentials.accessToken,
  };
}



async function listRoomsAction(opts: { json?: boolean; unread?: boolean }): Promise<void> {
  let ipc = null;

  try {
    const profileDir = await requireProfileDir();
    ipc = await ensureDaemonAndConnect(profileDir);

    let roomList = (await ipc.call('get_rooms', {})) as RoomInfo[];

    if (opts.unread) {
      roomList = roomList.filter((r) => r.unreadCount > 0);
    }

    if (opts.json) {
      printJson(roomList);
      return;
    }

    if (roomList.length === 0) {
      printData(opts.unread ? 'No unread rooms' : 'No rooms');
      return;
    }

    for (const room of roomList) {
      const typeIcon = room.type === 'agent' ? '🤖' : room.type === 'human' ? '👤' : '💬';
      const unreadBadge = room.unreadCount > 0 ? ` (${room.unreadCount} unread)` : '';
      const lastMsg = room.lastMessage
        ? ` — ${truncate(room.lastMessage.body, 50)} [${formatTimestamp(room.lastMessage.timestamp)}]`
        : '';

      printData(`${typeIcon} ${room.name}${unreadBadge}${lastMsg}`);
    }
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    fail(EXIT_CODES.ERROR);
  } finally {
    if (ipc) {
      await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

async function createGroupAction(members: string[], opts: { json?: boolean }): Promise<void> {
  let ipc = null;

  try {
    const profileDir = await requireProfileDir();
    ipc = await ensureDaemonAndConnect(profileDir);

    const allRooms = (await ipc.call('get_rooms', {})) as RoomInfo[];


    const resolved: Array<{ name: string; matrixUserId: string }> = [];
    const failed: string[] = [];

    for (const name of members) {
      const match = resolveNameToMatrixId(name, allRooms);
      if (match) {
        resolved.push({ name, matrixUserId: match.matrixUserId });
      } else {
        failed.push(name);
      }
    }

    if (failed.length > 0) {
      printError(`Cannot resolve: ${failed.join(', ')}. Use "clim contacts list" to see available names.`);
      fail(EXIT_CODES.NOT_FOUND);
    }

    if (resolved.length < 2) {
      printError('Need at least 2 members to create a group.');
      fail(EXIT_CODES.INVALID_ARGS);
    }

    const { client, accessToken } = await getProvisioningClient();
    const result = await client.createGroup(
      accessToken,
      resolved.map((r) => r.matrixUserId),
    );

    if (opts.json) {
      printJson(result);
      return;
    }

    printSuccess(`Group created: ${result.roomName}`);
    printData(`  Room ID: ${result.roomId}`);
    if (result.failedMembers.length > 0) {
      printError(`  Failed to add: ${result.failedMembers.join(', ')}`);
    }
  } catch (error) {
    handleProvisioningError(error);
  } finally {
    if (ipc) {
      await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

async function inviteAction(
  room: string,
  members: string[],
  opts: { json?: boolean },
): Promise<void> {
  let ipc = null;

  try {
    const profileDir = await requireProfileDir();
    ipc = await ensureDaemonAndConnect(profileDir);

    const allRooms = (await ipc.call('get_rooms', {})) as RoomInfo[];

    const targetRoom = resolveRoom(room, allRooms);
    if (!targetRoom) {
      printError(`Room not found: ${room}`);
      fail(EXIT_CODES.NOT_FOUND);
    }

    const resolved: Array<{ name: string; matrixUserId: string }> = [];
    const failed: string[] = [];

    for (const name of members) {
      const match = resolveNameToMatrixId(name, allRooms);
      if (match) {
        resolved.push({ name, matrixUserId: match.matrixUserId });
      } else {
        failed.push(name);
      }
    }

    if (failed.length > 0) {
      printError(`Cannot resolve: ${failed.join(', ')}`);
      fail(EXIT_CODES.NOT_FOUND);
    }

    const { client, accessToken } = await getProvisioningClient();
    const result = await client.inviteGroupMembers(
      accessToken,
      targetRoom.roomId,
      resolved.map((r) => r.matrixUserId),
    );

    if (opts.json) {
      printJson(result);
      return;
    }

    if (result.invited.length > 0) {
      printSuccess(`Invited ${result.invited.length} member(s) to ${targetRoom.name}`);
    }
    if (result.failed.length > 0) {
      printError(`Failed to invite: ${result.failed.join(', ')}`);
    }
  } catch (error) {
    handleProvisioningError(error);
  } finally {
    if (ipc) {
      await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

async function kickAction(
  room: string,
  member: string,
  opts: { json?: boolean },
): Promise<void> {
  let ipc = null;

  try {
    const profileDir = await requireProfileDir();
    ipc = await ensureDaemonAndConnect(profileDir);

    const allRooms = (await ipc.call('get_rooms', {})) as RoomInfo[];

    const targetRoom = resolveRoom(room, allRooms);
    if (!targetRoom) {
      printError(`Room not found: ${room}`);
      fail(EXIT_CODES.NOT_FOUND);
    }


    const lower = member.toLowerCase();
    const roomMember =
      targetRoom.members.find((m) => m.displayName.toLowerCase() === lower) ??
      targetRoom.members.find((m) => m.displayName.toLowerCase().includes(lower));

    if (!roomMember) {
      printError(`Member not found in ${targetRoom.name}: ${member}`);
      fail(EXIT_CODES.NOT_FOUND);
    }

    const { client, accessToken } = await getProvisioningClient();
    await client.removeGroupMember(accessToken, targetRoom.roomId, roomMember.userId);

    if (opts.json) {
      printJson({ success: true, removed: roomMember.displayName, roomId: targetRoom.roomId });
      return;
    }

    printSuccess(`Removed ${roomMember.displayName} from ${targetRoom.name}`);
  } catch (error) {
    handleProvisioningError(error);
  } finally {
    if (ipc) {
      await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

async function membersAction(room: string, opts: { json?: boolean }): Promise<void> {
  let ipc = null;

  try {
    const profileDir = await requireProfileDir();
    ipc = await ensureDaemonAndConnect(profileDir);

    const allRooms = (await ipc.call('get_rooms', {})) as RoomInfo[];

    const targetRoom = resolveRoom(room, allRooms);
    if (!targetRoom) {
      printError(`Room not found: ${room}`);
      fail(EXIT_CODES.NOT_FOUND);
    }

    if (opts.json) {
      printJson({
        roomId: targetRoom.roomId,
        name: targetRoom.name,
        members: targetRoom.members,
      });
      return;
    }

    printData(`${targetRoom.name} (${targetRoom.members.length} members)`);
    for (const m of targetRoom.members) {
      const isAgent = m.userId.includes('agent.');
      const icon = isAgent ? '🤖' : '👤';
      printData(`  ${icon} ${m.displayName}  ${m.userId}`);
    }
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    fail(EXIT_CODES.ERROR);
  } finally {
    if (ipc) {
      await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

function handleProvisioningError(error: unknown): never {
  if (isNetworkError(error)) {
    printError('Network error: cannot reach Provisioning service');
    fail(EXIT_CODES.NETWORK_ERROR);
  }

  if (error instanceof ProvisioningError) {
    printError(error.message);
    fail(EXIT_CODES.ERROR);
  }

  printError(error instanceof Error ? error.message : String(error));
  fail(EXIT_CODES.ERROR);
}
