import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';

interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

interface ExportOptions {
  format?: string;
  limit?: string;
  since?: string;
  json?: boolean;
}

function pad(num: number): string {
  return String(num).padStart(2, '0');
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toMarkdownQuote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export chat history for a room')
    .argument('<target>', 'Agent name, @username, or room ID')
    .option('--format <type>', 'Output format: text, json, markdown', 'text')
    .option('--limit <n>', 'Max messages to export', '100')
    .option('--since <date>', 'ISO date filter, e.g. 2026-03-01')
    .option('--json', 'Shortcut for --format json')
    .action(async (target: string, opts: ExportOptions) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const resolved = await resolveTarget(target, ipc);
        const requestedLimit = Number(opts.limit) || 100;
        const limit = Math.max(1, Math.min(requestedLimit, 1000));

        const format = opts.json ? 'json' : (opts.format ?? 'text').toLowerCase();
        if (format !== 'text' && format !== 'json' && format !== 'markdown') {
          printError(`Invalid format: ${format}. Use text, json, or markdown.`);
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const sinceTs = opts.since ? Date.parse(opts.since) : null;
        if (opts.since && (sinceTs === null || Number.isNaN(sinceTs))) {
          printError(`Invalid --since date: ${opts.since}`);
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const messages = (await ipc.call(
          'get_messages',
          { roomId: resolved.roomId, limit },
          30000,
        )) as MessageInfo[];

        const filtered = sinceTs === null
          ? messages
          : messages.filter((message) => message.timestamp >= sinceTs);

        if (format === 'json') {
          process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
          return;
        }

        if (filtered.length === 0) {
          printData(`No messages in ${resolved.displayName}`);
          return;
        }

        if (format === 'text') {
          for (const message of filtered) {
            printData(`[${formatTimestamp(message.timestamp)}] ${message.senderDisplayName}: ${message.body}`);
          }
          return;
        }

        const markdownLines: string[] = [
          `# Chat Export: ${resolved.displayName}`,
          '',
        ];

        for (const message of filtered) {
          markdownLines.push(`**${formatTimestamp(message.timestamp)}** — *${message.senderDisplayName}*:`);
          markdownLines.push(toMarkdownQuote(message.body));
          markdownLines.push('');
        }

        printData(markdownLines.join('\n').trimEnd());
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
