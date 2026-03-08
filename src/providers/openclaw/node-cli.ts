import { join } from 'node:path';
import { Command } from 'commander';
import { IpcClient } from '../../ipc/client.js';
import { EXIT_CODES } from '../../shared/constants.js';
import { printData, printError, printJson } from '../../shared/output.js';
import { getDaemonSockPath, getProfileDir, ProfileManager } from '../../shared/profile.js';

export function registerNodeCommand(program: Command): void {
  const node = program.command('node').description('Node device management');

  node
    .command('status')
    .description('Show Node device connection status')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
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
        const result = await client.call('node_status', {}, 3000) as {
          connected: boolean;
          deviceId: string | null;
          commands: string[];
        };

        if (opts.json) {
          printJson(result);
          return;
        }

        printData(`Node Device: ${result.connected ? 'connected' : 'disconnected'}`);
        if (result.deviceId) {
          printData(`Device ID:   ${result.deviceId}`);
        }
        printData(`Commands:    ${result.commands.join(', ')}`);
      } catch {
        printError('Cannot connect to daemon. Is it running? Run: clim daemon start');
        process.exit(EXIT_CODES.ERROR);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
}
