import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';
import { type IpcNotification } from '../ipc/protocol.js';
import type { StructuredEvent } from '../shared/events.js';

interface LegacyEventParams {
  type: string;
  roomId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  eventId: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLegacyEventParams(params: unknown): params is LegacyEventParams {
  return isRecord(params) && typeof params.type === 'string' && typeof params.roomId === 'string';
}

function isStructuredEventParams(params: unknown): params is StructuredEvent {
  return isRecord(params)
    && params.version === 1
    && typeof params.type === 'string'
    && typeof params.timestamp === 'number'
    && isRecord(params.payload);
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch real-time events')
    .option('--json', 'NDJSON output (one JSON per line)')
    .option('--room <target>', 'Filter by room (agent name, @username, or room ID)')
    .option('--type <type>', 'Filter by event type (e.g. message.text, typing.start)')
    .action(async (opts: { json?: boolean; room?: string; type?: string }) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        let filterRoomId: string | null = null;
        if (opts.room) {
          const resolved = await resolveTarget(opts.room, ipc);
          filterRoomId = resolved.roomId;
        }

        await ipc.call('subscribe_events', {});

        ipc.onNotification((notification: IpcNotification) => {
          if (notification.method !== 'event') return;
          const params = notification.params;

          if (isStructuredEventParams(params)) {
            const eventType = params.type;
            const eventTimestamp = params.timestamp;
            const eventRoomId = params.roomId;

            if (filterRoomId && eventRoomId !== filterRoomId) return;
            if (opts.type && eventType !== opts.type) return;

            if (opts.json) {
              process.stdout.write(JSON.stringify(params) + '\n');
              return;
            }

            const time = new Date(eventTimestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });

            if (eventType === 'message.text') {
              const senderName = typeof params.senderDisplayName === 'string'
                ? params.senderDisplayName
                : (typeof params.sender === 'string' ? params.sender : 'unknown');
              const body = typeof params.payload.body === 'string' ? params.payload.body : '';
              printData(`[${time}] [${eventType}] ${senderName}: ${body}`);
              return;
            }

            if (eventType === 'typing.start' || eventType === 'typing.stop') {
              const senderName = typeof params.senderDisplayName === 'string'
                ? params.senderDisplayName
                : (typeof params.sender === 'string' ? params.sender : 'Unknown');
              const action = eventType === 'typing.start' ? 'is typing...' : 'stopped typing';
              printData(`[${time}] [${eventType}] ${senderName} ${action}`);
              return;
            }

            if (eventType === 'draft.created') {
              const roomName = typeof params.payload.targetRoomName === 'string' ? params.payload.targetRoomName : 'unknown room';
              printData(`[${time}] [${eventType}] New draft for ${roomName}`);
              return;
            }

            printData(`[${time}] [${eventType}]`);
            return;
          }

          if (!isLegacyEventParams(params)) return;

          if (filterRoomId && params.roomId !== filterRoomId) return;
          if (opts.type && params.type !== opts.type) return;

          if (opts.json) {
            process.stdout.write(JSON.stringify(params) + '\n');
            return;
          }

          const time = new Date(params.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          printData(`[${time}] ${params.senderDisplayName}: ${params.body}`);

        });

        await new Promise<void>((resolve) => {
          const cleanup = () => resolve();
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
        });
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
