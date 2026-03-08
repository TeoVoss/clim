import readline from 'node:readline';
import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printInfo } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';
import { type IpcNotification } from '../ipc/protocol.js';
import { createMessageMeta } from '../shared/events.js';

interface RoomInfo {
  roomId: string;
  name: string;
  type: 'agent' | 'human' | 'unknown';
  unreadCount: number;
}

interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

interface EventParams {
  type: string;
  roomId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  eventId: string;
  timestamp: number;
}

interface Draft {
  id: number;
  targetRoomId: string;
  targetRoomName: string;
  draftBody: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEventParams(params: unknown): params is EventParams {
  return isRecord(params) && typeof params.type === 'string' && typeof params.roomId === 'string';
}

function formatRooms(rooms: RoomInfo[], currentRoomId?: string): string[] {
  return rooms.map((room) => {
    const icon = room.type === 'agent' ? '🤖' : room.type === 'human' ? '👤' : '💬';
    const unread = room.unreadCount > 0 ? ` (${room.unreadCount} unread)` : '';
    const current = room.roomId === currentRoomId ? ' *' : '';
    return `${icon} ${room.name}  ${room.roomId}${unread}${current}`;
  });
}

function formatHistory(messages: MessageInfo[]): string[] {
  return messages.map((msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return `[${time}] ${msg.senderDisplayName}: ${msg.body}`;
  });
}

function formatDrafts(drafts: Draft[]): string[] {
  return drafts.map((draft) => {
    const body = draft.draftBody.replace(/\s+/g, ' ').trim();
    const preview = body.length <= 60 ? body : `${body.slice(0, 59)}…`;
    return `#${draft.id} → ${draft.targetRoomName} (${draft.targetRoomId}) "${preview}"`;
  });
}

export function registerShellCommand(program: Command): void {
  program
    .command('shell')
    .description('Interactive REPL for chatting')
    .argument('[target]', 'Agent name, @username, or room ID')
    .action(async (target?: string) => {
      let ipc: Awaited<ReturnType<typeof ensureDaemonAndConnect>> | null = null;
      let rl: readline.Interface | null = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        let current = target
          ? await resolveTarget(target, ipc)
          : null;

        if (!current) {
          const rooms = (await ipc.call('get_rooms', {})) as RoomInfo[];
          const agentRooms = rooms.filter((room) => room.type === 'agent');

          if (agentRooms.length === 1) {
            current = { roomId: agentRooms[0].roomId, displayName: agentRooms[0].name, type: 'agent' };
            printInfo(`Auto-selected target: ${current.displayName}`);
          } else {
            printError('Multiple rooms available. Please specify a target.');
            for (const line of formatRooms(rooms)) {
              printData(line);
            }
            fail(EXIT_CODES.INVALID_ARGS);
          }
        }

        printInfo(`Chatting with ${current.displayName} (/help for commands, /quit to exit)`);

        await ipc.call('subscribe_events', {});

        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const ownEventIds = new Set<string>();
        const shownEventIds = new Set<string>();
        let exiting = false;

        const setPrompt = () => {
          rl?.setPrompt('me> ');
        };

        const printAbovePrompt = (line: string) => {
          if (!rl) return;
          const pending = rl.line;
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(`${line}\n`);
          rl.prompt();
          if (pending.length > 0) {
            rl.write(pending);
          }
        };

        ipc.onNotification((notification: IpcNotification) => {
          if (!current || !rl || exiting) return;
          if (notification.method !== 'event') return;
          if (!isEventParams(notification.params)) return;

          const event = notification.params;
          if (event.type !== 'message') return;
          if (event.roomId !== current.roomId) return;

          if (ownEventIds.has(event.eventId)) {
            ownEventIds.delete(event.eventId);
            return;
          }

          if (shownEventIds.has(event.eventId)) {
            return;
          }

          shownEventIds.add(event.eventId);
          printAbovePrompt(`${event.senderDisplayName}: ${event.body}`);

          // Auto-mark as read when displaying incoming messages
          ipc.call('send_read_receipt', { roomId: event.roomId, eventId: event.eventId }, 5000).catch(() => undefined);
        });

        const closeShell = async () => {
          if (exiting) return;
          exiting = true;
          rl?.close();
          await ipc?.close().catch(() => undefined);
        };

        const handleSlashCommand = async (input: string): Promise<boolean> => {
          const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
          const command = cmd?.toLowerCase() ?? '';

          if (!command) {
            return true;
          }

          if (command === 'quit' || command === 'exit') {
            await closeShell();
            return false;
          }

          if (command === 'help') {
            printData('Available commands:');
            printData('/target <name>   Switch conversation target');
            printData('/history [n]      Show last N messages (default 10)');
            printData('/rooms            List available rooms');
            printData('/agents           List agent rooms');
            printData('/drafts           List pending drafts');
            printData('/approve <id>     Approve a draft');
            printData('/reject <id>      Reject a draft');
            printData('/help             Show this help');
            printData('/quit or /exit    Exit shell');
            return true;
          }

          if (command === 'target') {
            const value = rest.join(' ').trim();
            if (!value) {
              printError('Usage: /target <name>');
              return true;
            }

            current = await resolveTarget(value, ipc!);
            setPrompt();
            printInfo(`Switched to ${current.displayName}`);
            return true;
          }

          if (command === 'history') {
            const nRaw = rest[0];
            const n = nRaw ? Number(nRaw) : 10;
            const limit = Math.max(1, Math.min(Number.isFinite(n) ? n : 10, 200));

            const messages = (await ipc!.call('get_messages', {
              roomId: current!.roomId,
              limit,
            })) as MessageInfo[];

            if (messages.length === 0) {
              printData('No messages');
              return true;
            }

            for (const line of formatHistory(messages)) {
              printData(line);
            }
            return true;
          }

          if (command === 'rooms') {
            const rooms = (await ipc!.call('get_rooms', {})) as RoomInfo[];
            for (const line of formatRooms(rooms, current!.roomId)) {
              printData(line);
            }
            return true;
          }

          if (command === 'agents') {
            const rooms = (await ipc!.call('get_rooms', {})) as RoomInfo[];
            const agents = rooms.filter((room) => room.type === 'agent');
            if (agents.length === 0) {
              printData('No agent rooms');
              return true;
            }
            for (const line of formatRooms(agents, current!.roomId)) {
              printData(line);
            }
            return true;
          }

          if (command === 'drafts') {
            const drafts = (await ipc!.call('get_drafts', { status: 'pending' })) as Draft[];
            if (drafts.length === 0) {
              printData('No pending drafts');
              return true;
            }
            for (const line of formatDrafts(drafts)) {
              printData(line);
            }
            return true;
          }

          if (command === 'approve' || command === 'reject') {
            const id = Number(rest[0]);
            if (!Number.isInteger(id)) {
              printError(`Usage: /${command} <id>`);
              return true;
            }

            const method = command === 'approve' ? 'approve_draft' : 'reject_draft';
            const result = (await ipc!.call(method, { id })) as { ok: boolean; error?: string; eventId?: string };
            if (!result.ok) {
              printError(result.error ?? `Failed to ${command} draft`);
              return true;
            }

            if (command === 'approve') {
              printInfo(`Approved draft #${id}${result.eventId ? ` (${result.eventId})` : ''}`);
            } else {
              printInfo(`Rejected draft #${id}`);
            }
            return true;
          }

          printError(`Unknown command: /${command}. Use /help.`);
          return true;
        };

        rl.on('SIGINT', async () => {
          if (exiting) {
            return;
          }

          if (rl && rl.line.trim().length > 0) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            rl.prompt();
            return;
          }

          await closeShell();
        });

        setPrompt();
        rl.prompt();

        for await (const rawLine of rl) {
          if (exiting || !current) break;

          const line = rawLine.trim();
          if (!line) {
            rl.prompt();
            continue;
          }

          try {
            if (line.startsWith('/')) {
              const shouldContinue = await handleSlashCommand(line);
              if (!shouldContinue) {
                break;
              }
              if (!exiting) rl.prompt();
              continue;
            }

            const shellEventMeta = createMessageMeta({ via: 'cli', interactive: true });
            const sendResult = (await ipc.call('send_message', {
              roomId: current.roomId,
              body: line,
              eventMeta: shellEventMeta,
            })) as { eventId: string };
            ownEventIds.add(sendResult.eventId);

            const reply = (await ipc.call('wait_for_reply', {
              roomId: current.roomId,
              timeout: 120000,
            }, 125000)) as MessageInfo;

            if (!shownEventIds.has(reply.eventId)) {
              shownEventIds.add(reply.eventId);
              printData(`${reply.senderDisplayName}: ${reply.body}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            printError(message);
            await closeShell();
            fail(EXIT_CODES.ERROR);
          }

          if (!exiting) {
            rl.prompt();
          }
        }

        await closeShell();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Cannot resolve target')) {
          printError(message);
          fail(EXIT_CODES.NOT_FOUND);
        }

        if (message.includes('IPC')) {
          printError(`Cannot connect to daemon: ${message}`);
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        printError(message);
        fail(EXIT_CODES.ERROR);
      } finally {
        if (rl) {
          rl.close();
        }
        if (ipc) {
          await ipc.close().catch(() => undefined);
        }
      }
    });
}
