import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access } from 'node:fs/promises';
import { Command } from 'commander';
import { IpcClient } from '../ipc/client.js';
import { DaemonManager } from '../daemon/lifecycle.js';
import { EXIT_CODES } from '../shared/constants.js';
import {
  printData,
  printError,
  printInfo,
  printJson,
  printSuccess,
  printWarning,
} from '../shared/output.js';
import { getProfileDir, ProfileManager } from '../shared/profile.js';
import { getDaemonSockPath } from '../shared/profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonScript = join(__dirname, 'daemon.mjs');

function fail(code: number): never {
  process.exit(code);
}

async function getCurrentProfileDirOrExit(profileManager: ProfileManager): Promise<string> {
  const email = await profileManager.getCurrentEmail();
  if (!email) {
    printError('Not logged in. Run: clim login --email <email> --password <password>');
    fail(EXIT_CODES.AUTH_FAILED);
  }

  return getProfileDir(email);
}

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Manage the background daemon');

  daemon
    .command('start')
    .description('Start the background daemon')
    .action(async () => {
      const profileManager = new ProfileManager();
      const profileDir = await getCurrentProfileDirOrExit(profileManager);
      const manager = new DaemonManager(profileDir);

      if (await manager.isRunning()) {
        const pid = await manager.getPid();
        printInfo(`Daemon already running (PID: ${pid ?? 'unknown'})`);
        return;
      }

      const scriptExists = await fileExists(daemonScript);
      if (!scriptExists) {
        printError(`Daemon script not found: ${daemonScript}. Run: pnpm build`);
        fail(EXIT_CODES.NOT_FOUND);
      }

      try {
        const pid = await manager.start(daemonScript);
        printSuccess(`Daemon started (PID: ${pid})`);
      } catch (error) {
        printError(`Failed to start daemon: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  daemon
    .command('stop')
    .description('Stop the background daemon')
    .action(async () => {
      const profileManager = new ProfileManager();
      const profileDir = await getCurrentProfileDirOrExit(profileManager);
      const manager = new DaemonManager(profileDir);

      if (!(await manager.isRunning())) {
        printInfo('Daemon is not running');
        return;
      }

      try {
        await manager.stop();
        printSuccess('Daemon stopped');
      } catch (error) {
        printError(`Failed to stop daemon: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const profileManager = new ProfileManager();
      const profileDir = await getCurrentProfileDirOrExit(profileManager);
      const manager = new DaemonManager(profileDir);
      const baseStatus = await manager.status();
      const sockPath = getDaemonSockPath(profileDir);

      let ipcOk = false;
      let daemonStatus: unknown = null;

      if (baseStatus.running) {
        const client = new IpcClient();
        try {
          await client.connect(sockPath, 500);
          daemonStatus = await client.call('status', {}, 1000);
          ipcOk = true;
        } catch {
          ipcOk = false;
        } finally {
          await client.close().catch(() => undefined);
        }
      }

      const status = {
        running: baseStatus.running,
        pid: baseStatus.pid,
        sockExists: baseStatus.sockExists,
        ipcOk,
        daemon: daemonStatus,
      };

      if (opts.json) {
        printJson(status);
        return;
      }

      if (!status.running) {
        printData('Daemon: not running');
        return;
      }

      printData(`Daemon: running (PID: ${status.pid})`);
      printData(`Socket: ${status.sockExists ? 'present' : 'missing'}`);
      printData(`IPC: ${status.ipcOk ? 'ok' : 'unreachable'}`);
      if (status.daemon && typeof status.daemon === 'object') {
        printData(`Status: ${JSON.stringify(status.daemon)}`);
      } else if (!status.ipcOk) {
        printWarning('Daemon process exists but IPC status check failed');
      }
    });
}
