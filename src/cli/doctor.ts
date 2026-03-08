import { join } from 'node:path';
import { Command } from 'commander';
import { VERSION, EXIT_CODES } from '../shared/constants.js';
import { loadConfig } from '../shared/config.js';
import { getDaemonSockPath, getProfileDir, ProfileManager } from '../shared/profile.js';
import { IpcClient } from '../ipc/client.js';
import { DaemonManager } from '../daemon/lifecycle.js';
import {
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printJson,
} from '../shared/output.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
}

interface DoctorOutput {
  version: string;
  checks: CheckResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run full-stack diagnostics')
    .option('--json', 'JSON output')
    .option('--fix', 'Attempt to auto-fix issues')
    .action(async (opts: { json?: boolean; fix?: boolean }) => {
      const checks: CheckResult[] = [];

      // 1. Config check
      let config = null;
      try {
        config = await loadConfig();
        checks.push({
          name: 'config',
          status: 'pass',
          detail: '~/.clim/config.json valid',
        });
      } catch (error) {
        checks.push({
          name: 'config',
          status: 'fail',
          detail: `Config error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // 2. Auth check
      const profileManager = new ProfileManager();
      let email: string | null = null;
      let credentials = null;
      try {
        email = await profileManager.getCurrentEmail();
        if (!email) {
          checks.push({
            name: 'auth',
            status: 'fail',
            detail: 'Not logged in',
          });
        } else {
          credentials = await profileManager.loadCredentials(email);
          checks.push({
            name: 'auth',
            status: 'pass',
            detail: `Logged in as ${email}`,
          });
        }
      } catch (error) {
        checks.push({
          name: 'auth',
          status: 'fail',
          detail: `Auth error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // 3. Provisioning check
      if (config) {
        let provisioningOk = false;
        try {
          const response = await fetch(`${config.provisioningUrl}/v1/auth/login`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
          });
          provisioningOk = true;
          checks.push({
            name: 'provisioning',
            status: 'pass',
            detail: `${config.provisioningUrl} reachable`,
          });
        } catch (error) {
          checks.push({
            name: 'provisioning',
            status: 'fail',
            detail: `${config.provisioningUrl} unreachable: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // 4. Daemon check
      let daemonOk = false;
      let daemonStatus = null;
      let daemonPid: number | null = null;
      if (email) {
        const profileDir = getProfileDir(email);
        const manager = new DaemonManager(profileDir);
        const sockPath = getDaemonSockPath(profileDir);

        try {
          const isRunning = await manager.isRunning();
          if (isRunning) {
            const client = new IpcClient();
            try {
              await client.connect(sockPath, 2000);
              daemonStatus = (await client.call('status', {}, 3000)) as Record<string, unknown> | null;
              daemonPid = ((daemonStatus as Record<string, unknown>)?.pid as number | undefined) ?? null;
              daemonOk = true;
              checks.push({
                name: 'daemon',
                status: 'pass',
                detail: `Running (PID: ${daemonPid})`,
              });
              await client.close().catch(() => undefined);
            } catch (error) {
              checks.push({
                name: 'daemon',
                status: 'fail',
                detail: `Daemon not responding: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          } else {
            checks.push({
              name: 'daemon',
              status: 'fail',
              detail: 'Not running',
            });

            if (opts.fix) {
              try {
                printInfo('Attempting to start daemon...');
                const daemonScript = join(
                  new URL(import.meta.url).pathname,
                  '..',
                  '..',
                  'shared',
                  'daemon.mjs'
                );
                await manager.start(daemonScript);
                daemonOk = true;
                checks[checks.length - 1].status = 'pass';
                checks[checks.length - 1].detail = 'Started successfully';
              } catch (startError) {
                checks[checks.length - 1].detail = `Failed to start: ${startError instanceof Error ? startError.message : String(startError)}`;
              }
            }
          }
        } catch (error) {
          checks.push({
            name: 'daemon',
            status: 'fail',
            detail: `Daemon check error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // 5. Matrix check
      if (daemonOk && email) {
        const profileDir = getProfileDir(email);
        const sockPath = getDaemonSockPath(profileDir);
        const client = new IpcClient();

        try {
          await client.connect(sockPath, 2000);
          const status = (await client.call('status', {}, 3000)) as Record<string, unknown>;
          const matrixSyncing = (status?.matrixSyncing as boolean | undefined) === true;
          const roomCount = (status?.roomCount as number | undefined) ?? 0;

          checks.push({
            name: 'matrix',
            status: matrixSyncing ? 'pass' : 'fail',
            detail: matrixSyncing ? `Syncing (${roomCount} rooms)` : 'Not syncing',
          });

          await client.close().catch(() => undefined);
        } catch (error) {
          checks.push({
            name: 'matrix',
            status: 'fail',
            detail: `Matrix check error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // 6. Node check
      if (daemonOk && email) {
        const profileDir = getProfileDir(email);
        const sockPath = getDaemonSockPath(profileDir);
        const client = new IpcClient();

        try {
          await client.connect(sockPath, 2000);
          const nodeStatus = (await client.call('node_status', {}, 3000)) as Record<string, unknown>;
          const connected = (nodeStatus?.connected as boolean | undefined) === true;
          const deviceId = (nodeStatus?.deviceId as string | null | undefined) ?? null;

          checks.push({
            name: 'node',
            status: connected ? 'pass' : 'warning',
            detail: connected ? `Connected (${deviceId})` : 'Not connected (optional)',
          });

          await client.close().catch(() => undefined);
        } catch (error) {
          checks.push({
            name: 'node',
            status: 'warning',
            detail: 'Not connected (optional)',
          });
        }
      }

      // 7. Rooms check
      if (daemonOk && email) {
        const profileDir = getProfileDir(email);
        const sockPath = getDaemonSockPath(profileDir);
        const client = new IpcClient();

        try {
          await client.connect(sockPath, 2000);
          const rooms = await client.call('get_rooms', {}, 3000);
          const roomCount = Array.isArray(rooms) ? rooms.length : 0;

          checks.push({
            name: 'rooms',
            status: 'pass',
            detail: `${roomCount} rooms accessible`,
          });

          await client.close().catch(() => undefined);
        } catch (error) {
          checks.push({
            name: 'rooms',
            status: 'fail',
            detail: `Rooms check error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Output results
      const summary = {
        passed: checks.filter((c) => c.status === 'pass').length,
        warnings: checks.filter((c) => c.status === 'warning').length,
        failed: checks.filter((c) => c.status === 'fail').length,
      };

      if (opts.json) {
        const output: DoctorOutput = {
          version: VERSION,
          checks,
          summary,
        };
        printJson(output);
      } else {
        printInfo(`clim doctor v${VERSION}\n`);
        for (const check of checks) {
          const label = check.name.padEnd(14);
          if (check.status === 'pass') {
            printSuccess(`${label} ${check.detail}`);
          } else if (check.status === 'warning') {
            printWarning(`${label} ${check.detail}`);
          } else {
            printError(`${label} ${check.detail}`);
          }
        }
        printInfo('');
        printInfo(
          `Result: ${summary.passed}/${checks.length} checks passed, ${summary.warnings} warning(s), ${summary.failed} failure(s)`
        );
      }

      // Exit with appropriate code
      if (summary.failed > 0) {
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
