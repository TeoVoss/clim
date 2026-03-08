import { Command } from 'commander';
import { EXIT_CODES } from '../../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../../shared/daemon-connection.js';
import { printData, printError, printJson } from '../../shared/output.js';
import { resolveTarget } from '../../shared/resolve-target.js';

interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

interface SummaryOptions {
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

function buildSummaryPrompt(messages: MessageInfo[]): string {
  const lines = [
    '请总结以下对话内容，提取关键信息和结论：',
    '',
  ];

  for (const message of messages) {
    lines.push(`[${message.senderDisplayName} at ${formatTimestamp(message.timestamp)}]: ${message.body}`);
  }

  return lines.join('\n');
}

export function registerSummaryCommand(program: Command): void {
  program
    .command('summary')
    .description('Ask agent to summarize recent messages in a room')
    .argument('<target>', 'Agent name, @username, or room ID')
    .option('--limit <n>', 'Number of messages to summarize', '30')
    .option('--json', 'JSON output')
    .action(async (target: string, opts: SummaryOptions) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const resolved = await resolveTarget(target, ipc);
        const limit = Math.max(1, Number(opts.limit) || 30);

        const messages = (await ipc.call(
          'get_messages',
          { roomId: resolved.roomId, limit },
          30000,
        )) as MessageInfo[];

        if (messages.length === 0) {
          printError(`No messages in ${resolved.displayName}`);
          fail(EXIT_CODES.NOT_FOUND);
        }

        const prompt = buildSummaryPrompt(messages);

        const sendResult = (await ipc.call('send_message', {
          roomId: resolved.roomId,
          body: prompt,
        })) as { eventId: string };

        const timeoutMs = 120000;
        const reply = (await ipc.call(
          'wait_for_reply',
          { roomId: resolved.roomId, timeout: timeoutMs },
          timeoutMs + 5000,
        )) as MessageInfo;

        if (opts.json) {
          printJson({
            target: resolved.displayName,
            roomId: resolved.roomId,
            sentEventId: sendResult.eventId,
            summary: {
              sender: reply.sender,
              senderDisplayName: reply.senderDisplayName,
              body: reply.body,
              timestamp: reply.timestamp,
              eventId: reply.eventId,
            },
          });
          return;
        }

        printData(reply.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Cannot resolve target')) {
          printError(message);
          fail(EXIT_CODES.NOT_FOUND);
        }

        if (message.includes('Timed out')) {
          printError('Timed out waiting for summary reply');
          fail(EXIT_CODES.TIMEOUT);
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
