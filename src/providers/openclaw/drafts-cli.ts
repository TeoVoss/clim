import { join } from 'node:path';
import { Command } from 'commander';
import { IpcClient } from '../../ipc/client.js';
import { EXIT_CODES } from '../../shared/constants.js';
import { printData, printError, printJson, printSuccess, printWarning } from '../../shared/output.js';
import { getDaemonSockPath, getProfileDir, ProfileManager } from '../../shared/profile.js';

interface Draft {
  id: number;
  targetRoomId: string;
  targetRoomName: string;
  draftBody: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
}

async function connectDaemon(): Promise<{ client: IpcClient; cleanup: () => Promise<void> }> {
  const profileManager = new ProfileManager();
  const email = await profileManager.getCurrentEmail();
  if (!email) {
    printError('Not logged in. Run: clim login --email <email> --password <password>');
    process.exit(EXIT_CODES.AUTH_FAILED);
  }

  const profileDir = getProfileDir(email);
  const sockPath = getDaemonSockPath(profileDir);
  const client = new IpcClient();

  try {
    await client.connect(sockPath, 2000);
  } catch {
    printError('Cannot connect to daemon. Is it running? Run: clim daemon start');
    process.exit(EXIT_CODES.ERROR);
  }

  return { client, cleanup: () => client.close().catch(() => undefined) };
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ');
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen - 1) + '…';
}

export function registerDraftsCommand(program: Command): void {
  const drafts = program.command('drafts').description('Manage drafts (批奏折)');

  drafts
    .command('list', { isDefault: true })
    .description('List drafts')
    .option('--all', 'Include processed drafts')
    .option('--json', 'JSON output')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { client, cleanup } = await connectDaemon();
      try {
        const params = opts.all ? {} : { status: 'pending' };
        const result = await client.call('get_drafts', params, 3000) as Draft[];

        if (opts.json) {
          printJson(result);
          return;
        }

        if (result.length === 0) {
          printData(opts.all ? 'No drafts' : 'No pending drafts');
          return;
        }

        for (const draft of result) {
          const status = draft.status === 'pending' ? '' : ` [${draft.status}]`;
          const preview = truncate(draft.draftBody, 40);
          printData(`  #${draft.id}  → ${draft.targetRoomName.padEnd(12)} "${preview}"  ${formatTimeAgo(draft.createdAt)}${status}`);
        }
      } finally {
        await cleanup();
      }
    });

  drafts
    .command('show <id>')
    .description('Show draft details')
    .option('--json', 'JSON output')
    .action(async (idStr: string, opts: { json?: boolean }) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        printError('Invalid draft ID');
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      const { client, cleanup } = await connectDaemon();
      try {
        const drafts = await client.call('get_drafts', {}, 3000) as Draft[];
        const draft = drafts.find((d) => d.id === id);

        if (!draft) {
          printError(`Draft #${id} not found`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        if (opts.json) {
          printJson(draft);
          return;
        }

        printData(`Draft #${draft.id}`);
        printData(`Status:  ${draft.status}`);
        printData(`Target:  ${draft.targetRoomName} (${draft.targetRoomId})`);
        printData(`Created: ${new Date(draft.createdAt).toLocaleString()}`);
        printData(`Body:\n${draft.draftBody}`);
      } finally {
        await cleanup();
      }
    });

  drafts
    .command('approve <id>')
    .description('Approve draft and send as message')
    .action(async (idStr: string) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        printError('Invalid draft ID');
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      const { client, cleanup } = await connectDaemon();
      try {
        const result = await client.call('approve_draft', { id }, 5000) as { ok: boolean; eventId?: string; error?: string };
        if (result.ok) {
          printSuccess(`Draft #${id} approved and sent (${result.eventId})`);
        } else {
          printError(`Failed to approve: ${result.error}`);
          process.exit(EXIT_CODES.ERROR);
        }
      } finally {
        await cleanup();
      }
    });

  drafts
    .command('reject <id>')
    .description('Reject and discard draft')
    .action(async (idStr: string) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        printError('Invalid draft ID');
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      const { client, cleanup } = await connectDaemon();
      try {
        const result = await client.call('reject_draft', { id }, 3000) as { ok: boolean; error?: string };
        if (result.ok) {
          printSuccess(`Draft #${id} rejected`);
        } else {
          printError(`Failed to reject: ${result.error}`);
          process.exit(EXIT_CODES.ERROR);
        }
      } finally {
        await cleanup();
      }
    });

  drafts
    .command('edit <id> <body>')
    .description('Edit draft body then approve')
    .action(async (idStr: string, body: string) => {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        printError('Invalid draft ID');
        process.exit(EXIT_CODES.INVALID_ARGS);
      }

      const { client, cleanup } = await connectDaemon();
      try {
        const editResult = await client.call('edit_draft', { id, body }, 3000) as { ok: boolean; error?: string };
        if (!editResult.ok) {
          printError(`Failed to edit: ${editResult.error}`);
          process.exit(EXIT_CODES.ERROR);
        }

        printSuccess(`Draft #${id} edited`);
        printWarning('Draft is now in "edited" status. Use "clim drafts approve" to send.');
      } finally {
        await cleanup();
      }
    });
}
