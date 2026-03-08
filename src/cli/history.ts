import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';

interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Show message history for a room')
    .argument('<target>', 'Agent name, @username, or room ID')
    .option('--limit <count>', 'Number of messages to show', '20')
    .option('--json', 'JSON output')
    .action(async (target: string, opts: { limit?: string; json?: boolean }) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const resolved = await resolveTarget(target, ipc);
        const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 200));

        const messages = (await ipc.call(
          'get_messages',
          { roomId: resolved.roomId, limit },
          30000,
        )) as MessageInfo[];

        // Mark as read: send read receipt for the last message
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          await ipc.call('send_read_receipt', { roomId: resolved.roomId, eventId: lastMsg.eventId }, 5000).catch(() => undefined);
        }

        if (opts.json) {
          printJson({ target: resolved.displayName, roomId: resolved.roomId, messages });
          return;
        }

        if (messages.length === 0) {
          printData(`No messages in ${resolved.displayName}`);
          return;
        }

        for (const msg of messages) {
          const time = new Date(msg.timestamp).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          printData(`[${time}] ${msg.senderDisplayName}: ${msg.body}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Cannot resolve target')) {
          printError(message);
          fail(EXIT_CODES.NOT_FOUND);
        }

        printError(message);
        fail(EXIT_CODES.ERROR);
      } finally {
        if (ipc) {
          await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
        }
      }
    });
}
