import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson } from '../shared/output.js';
import type { HookDefinition } from '../shared/hooks-store.js';

function parseAction(opts: {
  webhook?: string;
  exec?: string;
  log?: string | boolean;
  method?: string;
  header?: string[];
  secret?: string;
}): { type: string; [key: string]: unknown } | null {
  if (opts.webhook) {
    const action: { type: string; [key: string]: unknown } = { type: 'webhook', url: opts.webhook };
    if (opts.method) action.method = opts.method.toUpperCase();
    if (opts.secret) action.secret = opts.secret;
    if (opts.header && opts.header.length > 0) {
      const headers: Record<string, string> = {};
      for (const h of opts.header) {
        const colonIdx = h.indexOf(':');
        if (colonIdx > 0) {
          headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim();
        }
      }
      action.headers = headers;
    }
    return action;
  }

  if (opts.exec) {
    return { type: 'exec', command: opts.exec };
  }

  if (opts.log !== undefined) {
    return typeof opts.log === 'string'
      ? { type: 'log', path: opts.log }
      : { type: 'log' };
  }

  return null;
}

function formatAction(action: { type: string; [key: string]: unknown }): string {
  switch (action.type) {
    case 'webhook': return `webhook → ${action.url}`;
    case 'exec': return `exec → ${action.command}`;
    case 'log': return action.path ? `log → ${action.path}` : 'log → stdout';
    default: return action.type;
  }
}

export function registerHookCommand(program: Command): void {
  const hook = program.command('hook').description('Manage event hooks');

  hook
    .command('add')
    .description('Add a new hook')
    .requiredOption('--name <name>', 'Hook name')
    .requiredOption('--filter <filter>', 'Event filter (e.g. "type=message.text")')
    .option('--webhook <url>', 'Webhook URL to POST events to')
    .option('--exec <command>', 'Command to execute (event JSON on stdin)')
    .option('--log [path]', 'Log events as NDJSON (to file or stdout)')
    .option('--method <method>', 'HTTP method for webhook (POST or PUT)')
    .option('--header <header...>', 'HTTP header for webhook (Key: Value)')
    .option('--secret <secret>', 'HMAC-SHA256 secret for webhook signature')
    .option('--json', 'JSON output')
    .action(async (opts: {
      name: string;
      filter: string;
      webhook?: string;
      exec?: string;
      log?: string | boolean;
      method?: string;
      header?: string[];
      secret?: string;
      json?: boolean;
    }) => {
      try {
        const action = parseAction(opts);
        if (!action) {
          printError('Specify one action: --webhook <url>, --exec <command>, or --log [path]');
          fail(EXIT_CODES.INVALID_ARGS);
        }

        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const result = await ipc.call('hook_add', {
            name: opts.name,
            filter: opts.filter,
            action,
            enabled: true,
          }, 5000) as HookDefinition;

          if (opts.json) {
            printJson(result);
          } else {
            printData(`✓ Hook #${result.id} "${result.name}" added`);
            printData(`  Filter: ${result.filter}`);
            printData(`  Action: ${formatAction(result.action)}`);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('list')
    .description('List all hooks')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const hooks = await ipc.call('hook_list', {}, 5000) as HookDefinition[];

          if (opts.json) {
            printJson(hooks);
            return;
          }

          if (hooks.length === 0) {
            printData('No hooks configured. Use `clim hook add` to create one.');
            return;
          }

          for (const h of hooks) {
            const status = h.enabled ? '●' : '○';
            printData(`${status} #${h.id} ${h.name}`);
            printData(`  Filter: ${h.filter}`);
            printData(`  Action: ${formatAction(h.action)}`);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('remove <id>')
    .description('Remove a hook by ID')
    .action(async (id: string) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const result = await ipc.call('hook_remove', { id }, 5000) as { ok: boolean; error?: string };
          if (result.ok) {
            printData(`✓ Hook #${id} removed`);
          } else {
            printError(result.error ?? 'Hook not found');
            fail(EXIT_CODES.NOT_FOUND);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('enable <id>')
    .description('Enable a hook')
    .action(async (id: string) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const result = await ipc.call('hook_enable', { id }, 5000) as { ok: boolean; error?: string };
          if (result.ok) {
            printData(`✓ Hook #${id} enabled`);
          } else {
            printError(result.error ?? 'Hook not found');
            fail(EXIT_CODES.NOT_FOUND);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('disable <id>')
    .description('Disable a hook')
    .action(async (id: string) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const result = await ipc.call('hook_disable', { id }, 5000) as { ok: boolean; error?: string };
          if (result.ok) {
            printData(`✓ Hook #${id} disabled`);
          } else {
            printError(result.error ?? 'Hook not found');
            fail(EXIT_CODES.NOT_FOUND);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('test <id>')
    .description('Send a test event to a hook')
    .option('--event <json>', 'Custom event JSON (default: synthetic message.text event)')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { event?: string; json?: boolean }) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          let event: Record<string, unknown>;
          if (opts.event) {
            event = JSON.parse(opts.event) as Record<string, unknown>;
          } else {
            event = {
              version: 1,
              type: 'message.text',
              timestamp: Date.now(),
              roomId: '!test:localhost',
              sender: '@test-user:localhost',
              senderDisplayName: 'Test User',
              payload: { eventId: '$test', body: 'This is a test message from clim hook test' },
            };
          }

          const result = await ipc.call('hook_test', { id, event }, 15000) as { ok: boolean; error?: string };

          if (opts.json) {
            printJson(result);
          } else if (result.ok) {
            printData(`✓ Test event dispatched to hook #${id}`);
          } else {
            printError(`✗ ${result.error ?? 'Unknown error'}`);
            fail(EXIT_CODES.ERROR);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  hook
    .command('history')
    .description('Show recent hook trigger history')
    .option('--json', 'JSON output')
    .option('-n, --limit <n>', 'Number of entries to show', '20')
    .action(async (opts: { json?: boolean; limit: string }) => {
      try {
        const profileDir = await requireProfileDir();
        const ipc = await ensureDaemonAndConnect(profileDir);

        try {
          const entries = await ipc.call('hook_history', {}, 5000) as Array<{
            hookId: string; hookName: string; eventType: string; timestamp: number; ok: boolean; error?: string;
          }>;

          const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 20);
          const display = entries.slice(-limit);

          if (opts.json) {
            printJson(display);
            return;
          }

          if (display.length === 0) {
            printData('No hook triggers recorded yet.');
            return;
          }

          for (const e of display) {
            const time = new Date(e.timestamp).toLocaleTimeString([], {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
            const status = e.ok ? '✓' : '✗';
            const detail = e.error ? ` — ${e.error}` : '';
            printData(`${status} [${time}] #${e.hookId} ${e.hookName} ← ${e.eventType}${detail}`);
          }
        } finally {
          await ipc.close().catch(() => undefined);
        }
      } catch (error) {
        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });
}
