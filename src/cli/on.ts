import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { type IpcNotification } from '../ipc/protocol.js';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { expandTemplate, matchesFilter, parseFilter } from '../shared/filter.js';
import { printError, printInfo } from '../shared/output.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function registerOnCommand(program: Command): void {
  program
    .command('on')
    .description('Run a command when events match a filter')
    .argument('<filter>', 'Event filter (e.g. "type=message.text", "type=message.*,sender=@agent*")')
    .argument('[command...]', 'Command to execute after -- (receives event JSON on stdin)')
    .option('--no-stdin', 'Do not pipe event JSON to stdin')
    .allowUnknownOption(false)
    .enablePositionalOptions(true)
    .passThroughOptions(true)
    .action(async (filterFromArgs: string, _commandArgs: string[], opts: { stdin?: boolean }) => {
      let ipc = null;
      let running = true;

      try {
        const argv = process.argv;
        const dashDashIdx = argv.indexOf('--');
        const onIdx = argv.indexOf('on');

        if (onIdx === -1) {
          printError('Internal error: cannot determine command position');
          fail(EXIT_CODES.ERROR);
        }

        if (dashDashIdx === -1 || dashDashIdx <= onIdx + 1) {
          printError('Usage: clim on <filter> -- <command...>');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const filterStr = filterFromArgs.trim();
        if (!filterStr) {
          printError('Missing filter');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const cmdArgs = argv.slice(dashDashIdx + 1);
        if (cmdArgs.length === 0) {
          printError('Missing command after --');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const filter = parseFilter(filterStr);
        if (filter.size === 0) {
          printError('Invalid filter. Expected key=value pairs (e.g. "type=message.text" or "type=message.*")');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);
        await ipc.call('subscribe_events', {});

        printInfo(`Watching for events matching: ${filterStr}`);
        printInfo(`Will execute: ${cmdArgs.join(' ')}`);

        ipc.onNotification((notification: IpcNotification) => {
          if (!running) return;
          if (notification.method !== 'event') return;

          if (!isRecord(notification.params)) return;
          const event = notification.params;
          if (!matchesFilter(event, filter)) return;

          const command = expandTemplate(cmdArgs[0], event);
          const args = cmdArgs.slice(1).map((arg) => expandTemplate(arg, event));
          const wantsStdin = opts.stdin !== false;

          const child = spawn(command, args, {
            stdio: wantsStdin ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
            shell: false,
          });

          if (wantsStdin && child.stdin) {
            child.stdin.write(JSON.stringify(event) + '\n');
            child.stdin.end();
          }

          child.on('error', (error: Error) => {
            printError(`Failed to execute command: ${error.message}`);
          });
        });

        await new Promise<void>((resolve) => {
          const cleanup = () => {
            running = false;
            resolve();
          };

          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        printError(message);
        fail(EXIT_CODES.ERROR);
      } finally {
        if (ipc) {
          await (ipc as { close: () => Promise<void> }).close().catch(() => undefined);
        }
      }
    });
}
