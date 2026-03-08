import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';

interface SearchResult {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
  roomName: string;
}

interface SearchOptions {
  room?: string;
  limit?: string;
  json?: boolean;
}

function pad(num: number): string {
  return String(num).padStart(2, '0');
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search messages by text in one room or all rooms')
    .argument('<query>', 'Text to search for')
    .option('--room <target>', 'Search in specific room only')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'JSON output')
    .action(async (query: string, opts: SearchOptions) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
          printError('Search query cannot be empty');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const limit = Math.max(1, Number(opts.limit) || 20);

        let roomId: string | undefined;
        if (opts.room) {
          const resolved = await resolveTarget(opts.room, ipc);
          roomId = resolved.roomId;
        }

        const matches = (await ipc.call(
          'search_messages',
          { query: normalizedQuery, roomId, limit },
          30000,
        )) as SearchResult[];

        if (opts.json) {
          printJson(matches);
          return;
        }

        if (matches.length === 0) {
          printData('No matches found');
          return;
        }

        for (const message of matches) {
          printData(`[${message.roomName}] [${formatTimestamp(message.timestamp)}] ${message.senderDisplayName}: ${message.body}`);
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
