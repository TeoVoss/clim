import { Command } from 'commander';
import { EXIT_CODES } from '../shared/constants.js';
import { loadConfig } from '../shared/config.js';
import { printError, printJson, printSuccess } from '../shared/output.js';
import { ProfileManager } from '../shared/profile.js';
import { ensureDaemonAndConnect, requireProfileDir } from '../shared/daemon-connection.js';

interface DaemonStatus {
  version: string;
  pid: number;
  uptime: number;
  matrixSyncing: boolean;
  roomCount: number;
}

interface NodeStatus {
  connected: boolean;
  deviceId: string | null;
  commands: string[];
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Full system status check')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const checks: CheckResult[] = [];

      const profileManager = new ProfileManager();
      const email = await profileManager.getCurrentEmail();
      checks.push({
        label: 'Profile',
        ok: !!email,
        detail: email ?? 'not logged in',
      });

      if (!email) {
        outputChecks(checks, opts.json);
        process.exit(EXIT_CODES.AUTH_FAILED);
      }

      const config = await loadConfig();
      let provisioningOk = false;
      try {
        await fetch(`${config.provisioningUrl}/v1/auth/login`, { signal: AbortSignal.timeout(3000) });
        provisioningOk = true;
      } catch { }
      checks.push({
        label: 'Provisioning',
        ok: provisioningOk,
        detail: provisioningOk ? `${config.provisioningUrl} (reachable)` : `${config.provisioningUrl} (unreachable)`,
      });

      const profileDir = await requireProfileDir();

      let daemonOk = false;
      let daemonStatus: DaemonStatus | null = null;
      let nodeStatus: NodeStatus | null = null;
      let client = null;

      try {
        client = await ensureDaemonAndConnect(profileDir);
        daemonStatus = await client.call('status', {}, 3000) as DaemonStatus;
        daemonOk = true;
      } catch { }

      checks.push({
        label: 'Daemon',
        ok: daemonOk,
        detail: daemonOk && daemonStatus
          ? `running (PID ${daemonStatus.pid})`
          : 'not running',
      });

      if (daemonOk) {
        checks.push({
          label: 'Matrix Sync',
          ok: !!daemonStatus?.matrixSyncing,
          detail: daemonStatus?.matrixSyncing
            ? `connected (${daemonStatus.roomCount} rooms)`
            : 'not syncing',
        });

        try {
          nodeStatus = await client!.call('node_status', {}, 3000) as NodeStatus;
        } catch { }

        if (nodeStatus?.connected) {
          checks.push({
            label: 'Gateway',
            ok: true,
            detail: `connected (${nodeStatus.commands.length} commands)`,
          });
        } else {
          // Check if credentials have gateway info
          const creds = await profileManager.loadCredentials(email!);
          checks.push({
            label: 'Gateway',
            ok: false,
            detail: creds.gatewayUrl
              ? 'disconnected (gateway provisioned but not reachable)'
              : 'not provisioned (run `clim agent provision` to enable AI)',
          });
        }
      }

      if (client) {
        await (client as { close: () => Promise<void> }).close().catch(() => undefined);
      }

      outputChecks(checks, opts.json);
    });
}

function outputChecks(checks: CheckResult[], json?: boolean): void {
  if (json) {
    printJson(checks);
    return;
  }

  for (const check of checks) {
    if (check.ok) {
      printSuccess(`${check.label.padEnd(14)} ${check.detail}`);
    } else {
      printError(`${check.label.padEnd(14)} ${check.detail}`);
    }
  }
}
