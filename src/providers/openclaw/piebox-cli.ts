import { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { ProfileManager } from '../../shared/profile.js';
import { ProvisioningClient } from '../../client/provisioning.js';
import { printSuccess, printError, printInfo, printJson } from '../../shared/output.js';
import { EXIT_CODES } from '../../shared/constants.js';

export function registerPieboxCommand(program: Command): void {
  const piebox = program.command('piebox').description('PieBox container management');

  piebox
    .command('status')
    .description('Show PieBox container status')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const email = await profileManager.getCurrentEmail();

        if (!email) {
          printError('Not logged in');
          process.exit(EXIT_CODES.AUTH_FAILED);
        }

        const credentials = await profileManager.loadCredentials(email);
        const client = new ProvisioningClient(config.provisioningUrl);

        try {
          const status = await client.pieboxStatus(credentials.accessToken);

          if (opts.json) {
            printJson(status);
          } else {
            printSuccess('PieBox Status');
            printInfo(JSON.stringify(status, null, 2));
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('404')) {
            printError('PieBox status API not available on this Provisioning version');
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          throw error;
        }
      } catch (error) {
        printError(`Failed to get PieBox status: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  piebox
    .command('ensure')
    .description('Ensure PieBox container is running')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        const profileManager = new ProfileManager();
        const email = await profileManager.getCurrentEmail();

        if (!email) {
          printError('Not logged in');
          process.exit(EXIT_CODES.AUTH_FAILED);
        }

        const credentials = await profileManager.loadCredentials(email);
        const client = new ProvisioningClient(config.provisioningUrl);

        try {
          const result = await client.pieboxEnsure(credentials.accessToken);

          if (opts.json) {
            printJson(result);
          } else {
            printSuccess('PieBox Ensure Result');
            printInfo(JSON.stringify(result, null, 2));
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('404')) {
            printError('PieBox ensure API not available on this Provisioning version');
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          throw error;
        }
      } catch (error) {
        printError(`Failed to ensure PieBox: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
