import { Command } from 'commander';
import { ProvisioningClient, ProvisioningError, isNetworkError } from '../client/provisioning.js';
import { loadConfig } from '../shared/config.js';
import { EXIT_CODES } from '../shared/constants.js';
import { ensureDaemonAndConnect, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printJson, printSuccess } from '../shared/output.js';
import { ProfileManager } from '../shared/profile.js';

function fail(code: number): never {
  process.exit(code);
}

function formatTimestamp(createdAt: string): string {
  const d = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function resolveRequestId(client: ProvisioningClient, accessToken: string, emailOrId: string, direction?: 'incoming' | 'outgoing'): Promise<string> {
  // If it looks like a UUID (or prefix), assume it's a request ID
  if (/^[0-9a-f-]{8,}$/i.test(emailOrId) && !emailOrId.includes('@')) {
    // Could be a full UUID or a prefix — if prefix, resolve via list
    if (emailOrId.length >= 36) return emailOrId;
    const response = await client.listContactRequests(accessToken);
    const match = response.requests.find((r: { id: string; direction?: string }) =>
      r.id.startsWith(emailOrId) && (!direction || r.direction === direction),
    );
    if (!match) throw new Error(`No ${direction ?? 'pending'} request matching ID prefix "${emailOrId}"`);
    return match.id;
  }

  // Otherwise treat as email
  const response = await client.listContactRequests(accessToken);
  const match = response.requests.find((r: { fromEmail: string; toEmail: string; direction?: string }) => {
    const email = direction === 'incoming' ? r.fromEmail : direction === 'outgoing' ? r.toEmail : r.fromEmail;
    return email === emailOrId && (!direction || r.direction === direction);
  });
  if (!match) throw new Error(`No ${direction ?? 'pending'} request from "${emailOrId}"`);
  return match.id;
}

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command('contacts')
    .description('Manage contacts and friend requests');

  // --- list (all contacts: agents + humans, grouped) ---

  contacts
    .command('list')
    .description('List all contacts (agents and people), grouped')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      let ipc = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const rooms = (await ipc.call('get_rooms', {})) as Array<{
          roomId: string;
          name: string;
          type: string;
          unreadCount: number;
          members: Array<{ userId: string; displayName: string }>;
          lastMessage?: { body: string; timestamp: number };
        }>;

        const agents = rooms.filter((r) => r.type === 'agent');
        const humans = rooms.filter((r) => r.type === 'human');

        if (opts.json) {
          printJson({
            agents: agents.map((r) => ({ roomId: r.roomId, name: r.name, unreadCount: r.unreadCount, lastMessage: r.lastMessage?.body ?? null })),
            people: humans.map((r) => ({ roomId: r.roomId, name: r.name, unreadCount: r.unreadCount, lastMessage: r.lastMessage?.body ?? null })),
          });
          return;
        }

        const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;

        if (agents.length === 0 && humans.length === 0) {
          printData('No contacts yet');
          return;
        }

        if (agents.length > 0) {
          printData('Agents');
          for (const r of agents) {
            const badge = r.unreadCount > 0 ? ` (${r.unreadCount})` : '';
            const last = r.lastMessage ? ` — ${truncate(r.lastMessage.body, 50)}` : '';
            printData(`  🤖 ${r.name}${badge}${last}`);
          }
        }

        if (humans.length > 0) {
          if (agents.length > 0) printData('');
          printData('People');
          for (const r of humans) {
            const badge = r.unreadCount > 0 ? ` (${r.unreadCount})` : '';
            const last = r.lastMessage ? ` — ${truncate(r.lastMessage.body, 50)}` : '';
            printData(`  👤 ${r.name}${badge}${last}`);
          }
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

  contacts
    .command('add <email>')
    .description('Send a friend request')
    .option('--json', 'JSON output')
    .action(async (email: string, opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const credentials = await profileManager.loadCredentials();
        const client = new ProvisioningClient(config.provisioningUrl);

        const result = await client.sendContactRequest(credentials.accessToken, email);

        if (opts.json) {
          printJson({ success: true, result });
        } else {
          printSuccess(`Friend request sent to ${email}`);
        }
      } catch (error) {
        if (isNetworkError(error)) {
          printError('Network error: cannot reach Provisioning service');
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        if (error instanceof ProvisioningError) {
          if (error.statusCode === 404) {
            printError(`User not found: ${email}`);
            fail(EXIT_CODES.NOT_FOUND);
          }
          if (error.statusCode === 409) {
            printError('Friend request already exists or already friends');
            fail(EXIT_CODES.ERROR);
          }
          printError(error.message);
          fail(EXIT_CODES.ERROR);
        }

        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  contacts
    .command('requests')
    .description('List pending friend requests (incoming and outgoing)')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const credentials = await profileManager.loadCredentials();
        const client = new ProvisioningClient(config.provisioningUrl);

        const response = await client.listContactRequests(credentials.accessToken);

        if (opts.json) {
          printJson(response);
          return;
        }

        if (!response.requests || response.requests.length === 0) {
          printData('No pending requests');
          return;
        }

        const incoming = response.requests.filter((r: { direction: string }) => r.direction === 'incoming');
        const outgoing = response.requests.filter((r: { direction: string }) => r.direction === 'outgoing');

        if (incoming.length > 0) {
          printData('Friend requests:');
          for (const req of incoming) {
            printData(`  ${req.fromEmail}  ${formatTimestamp(req.createdAt)}`);
          }
        }

        if (outgoing.length > 0) {
          if (incoming.length > 0) printData('');
          printData('Sent:');
          for (const req of outgoing) {
            printData(`  ${req.toEmail}  ${formatTimestamp(req.createdAt)}`);
          }
        }
      } catch (error) {
        if (isNetworkError(error)) {
          printError('Network error: cannot reach Provisioning service');
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        if (error instanceof ProvisioningError) {
          printError(error.message);
          fail(EXIT_CODES.ERROR);
        }

        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  contacts
    .command('accept <emailOrId>')
    .description('Accept a friend request (by sender email or request ID)')
    .option('--json', 'JSON output')
    .action(async (emailOrId: string, opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const credentials = await profileManager.loadCredentials();
        const client = new ProvisioningClient(config.provisioningUrl);

        const requestId = await resolveRequestId(client, credentials.accessToken, emailOrId, 'incoming');
        const result = await client.acceptContactRequest(credentials.accessToken, requestId);

        if (opts.json) {
          printJson({ success: true, result });
        } else {
          printSuccess('Friend request accepted');
        }
      } catch (error) {
        if (isNetworkError(error)) {
          printError('Network error: cannot reach Provisioning service');
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        if (error instanceof ProvisioningError) {
          if (error.statusCode === 404) {
            printError('Request not found');
            fail(EXIT_CODES.NOT_FOUND);
          }
          printError(error.message);
          fail(EXIT_CODES.ERROR);
        }

        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });

  contacts
    .command('reject <emailOrId>')
    .description('Reject a friend request (by sender email or request ID)')
    .option('--json', 'JSON output')
    .action(async (emailOrId: string, opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const credentials = await profileManager.loadCredentials();
        const client = new ProvisioningClient(config.provisioningUrl);

        const requestId = await resolveRequestId(client, credentials.accessToken, emailOrId, 'incoming');
        await client.rejectContactRequest(credentials.accessToken, requestId);

        if (opts.json) {
          printJson({ success: true });
        } else {
          printSuccess('Friend request rejected');
        }
      } catch (error) {
        if (isNetworkError(error)) {
          printError('Network error: cannot reach Provisioning service');
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        if (error instanceof ProvisioningError) {
          if (error.statusCode === 404) {
            printError('Request not found');
            fail(EXIT_CODES.NOT_FOUND);
          }
          printError(error.message);
          fail(EXIT_CODES.ERROR);
        }

        printError(error instanceof Error ? error.message : String(error));
        fail(EXIT_CODES.ERROR);
      }
    });
}
