import { IpcClient } from '../ipc/client.js';

export interface ResolvedTarget {
  roomId: string;
  displayName: string;
  type: 'agent' | 'human' | 'unknown';
}

interface RoomMember {
  userId: string;
  displayName: string;
}

interface RoomInfo {
  roomId: string;
  name: string;
  type: 'agent' | 'human' | 'unknown';
  unreadCount: number;
  members: RoomMember[];
  lastMessage?: {
    sender: string;
    body: string;
    timestamp: number;
    eventId: string;
  };
}

function extractAgentId(member: RoomMember): string | null {
  const localpart = member.userId.startsWith('@')
    ? member.userId.slice(1).split(':')[0]
    : member.userId;
  if (localpart.startsWith('agent.')) {
    const parts = localpart.split('.');
    return parts[1] ?? null;
  }
  return null;
}

export async function resolveTarget(target: string, ipc: IpcClient): Promise<ResolvedTarget> {
  if (target.startsWith('!')) {
    const rooms = (await ipc.call('get_rooms', {})) as RoomInfo[];
    const room = rooms.find((r) => r.roomId === target);
    return {
      roomId: target,
      displayName: room?.name ?? target,
      type: room?.type ?? 'unknown',
    };
  }

  const rooms = (await ipc.call('get_rooms', {})) as RoomInfo[];
  const normalizedTarget = target.toLowerCase().replace(/^@/, '');

  const agentRoomByName = rooms.find(
    (r) => r.type === 'agent' && r.name.toLowerCase() === normalizedTarget,
  );
  if (agentRoomByName) {
    return { roomId: agentRoomByName.roomId, displayName: agentRoomByName.name, type: 'agent' };
  }

  const agentRoomById = rooms.find(
    (r) =>
      r.type === 'agent' &&
      r.members.some((m) => extractAgentId(m) === normalizedTarget),
  );
  if (agentRoomById) {
    return { roomId: agentRoomById.roomId, displayName: agentRoomById.name, type: 'agent' };
  }

  const humanRoom = rooms.find(
    (r) => r.type === 'human' && r.name.toLowerCase() === normalizedTarget,
  );
  if (humanRoom) {
    return { roomId: humanRoom.roomId, displayName: humanRoom.name, type: 'human' };
  }

  const fuzzy = rooms.find((r) => r.name.toLowerCase().includes(normalizedTarget));
  if (fuzzy) {
    return { roomId: fuzzy.roomId, displayName: fuzzy.name, type: fuzzy.type };
  }

  const agentFuzzy = rooms.find(
    (r) =>
      r.type === 'agent' &&
      r.members.some((m) => {
        const agentId = extractAgentId(m);
        return agentId?.includes(normalizedTarget) || m.displayName.toLowerCase().includes(normalizedTarget);
      }),
  );
  if (agentFuzzy) {
    return { roomId: agentFuzzy.roomId, displayName: agentFuzzy.name, type: 'agent' };
  }

  const agentRooms = rooms.filter((r) => r.type === 'agent');
  if (agentRooms.length === 1) {
    return { roomId: agentRooms[0].roomId, displayName: agentRooms[0].name, type: 'agent' };
  }

  throw new Error(
    `Cannot resolve target "${target}". Available rooms: ${rooms.map((r) => r.name).join(', ') || '(none)'}`,
  );
}
