import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson, printSuccess } from '../shared/output.js';

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

export function registerUnreadCommand(program: Command): void {
  program
    .command('unread')
    .description('Show unread message summary')
    .option('--json', 'JSON output')
    .option('--mark-read', 'Mark all messages as read')
    .action(async (opts: { json?: boolean; markRead?: boolean }) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const allRooms = (await ipc.call('get_rooms', {})) as RoomInfo[];
        const unreadRooms = allRooms.filter((r) => r.unreadCount > 0);

        if (opts.markRead) {
          for (const room of unreadRooms) {
            if (room.lastMessage) {
              await ipc.call(
                'send_read_receipt',
                { roomId: room.roomId, eventId: room.lastMessage.eventId },
                5000,
              ).catch(() => undefined);
            }
          }
          printSuccess(`Marked ${unreadRooms.length} room(s) as read`);

          if (opts.json) {
            printJson({ markedRead: unreadRooms.length, rooms: unreadRooms.map((r) => r.name) });
          }
          return;
        }

        if (opts.json) {
          printJson(
            unreadRooms.map((r) => ({
              name: r.name,
              roomId: r.roomId,
              type: r.type,
              unreadCount: r.unreadCount,
              lastMessage: r.lastMessage,
            })),
          );
          return;
        }

        if (unreadRooms.length === 0) {
          printData('No unread messages');
          return;
        }

        const totalUnread = unreadRooms.reduce((sum, r) => sum + r.unreadCount, 0);
        printData(`${totalUnread} unread message(s) in ${unreadRooms.length} room(s):\n`);

        for (const room of unreadRooms) {
          const typeIcon = room.type === 'agent' ? '🤖' : room.type === 'human' ? '👤' : '💬';
          const lastPreview = room.lastMessage
            ? `: ${room.lastMessage.body.slice(0, 60)}`
            : '';
          printData(`  ${typeIcon} ${room.name} (${room.unreadCount})${lastPreview}`);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      } finally {
        if (ipc) {
          await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
        }
      }
    });
}
