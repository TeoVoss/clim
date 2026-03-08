import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { DaemonManager } from '../daemon/lifecycle.js';
import { EXIT_CODES } from '../shared/constants.js';
import { printData, printError, printJson, printSuccess } from '../shared/output.js';
import {
  ProfileManager,
  getProfileDir,
  getCurrentProfilePath,
} from '../shared/profile.js';

function fail(code: number): never {
  process.exit(code);
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program
    .command('accounts')
    .description('Manage multiple accounts');

  accounts.action(async () => {
    try {
      const profileManager = new ProfileManager();
      const profiles = await profileManager.listProfiles();
      const currentEmail = await profileManager.getCurrentEmail();

      if (profiles.length === 0) {
        printData('No accounts configured');
        return;
      }

      const lines = profiles.map((profile) => {
        const marker = profile.email === currentEmail ? '* ' : '  ';
        const status = profile.hasCredentials ? '' : ' (no credentials)';
        const current = profile.email === currentEmail ? ' (current)' : '';
        return `${marker}${profile.email}${current}${status}`;
      });

      printData(lines.join('\n'));
    } catch (error) {
      printError(`Failed to list accounts: ${error instanceof Error ? error.message : String(error)}`);
      fail(EXIT_CODES.ERROR);
    }
  });

  accounts
    .command('current')
    .description('Show current active account')
    .action(async () => {
      try {
        const profileManager = new ProfileManager();
        const currentEmail = await profileManager.getCurrentEmail();

        if (!currentEmail) {
          printData('No account currently active');
        } else {
          printData(currentEmail);
        }
      } catch (error) {
        printError(`Failed to get current account: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  accounts
    .command('switch')
    .argument('<email>', 'Email address to switch to')
    .description('Switch to a different account')
    .action(async (email: string) => {
      try {
        const profileManager = new ProfileManager();
        const profiles = await profileManager.listProfiles();

        const profile = profiles.find((p) => p.email === email);
        if (!profile) {
          printError(`Account not found: ${email}`);
          fail(EXIT_CODES.NOT_FOUND);
        }

        if (!profile.hasCredentials) {
          printError(`No credentials for account: ${email}`);
          fail(EXIT_CODES.AUTH_FAILED);
        }

        const currentEmail = await profileManager.getCurrentEmail();
        if (currentEmail === email) {
          printSuccess(`Already on account: ${email}`);
          return;
        }

        if (currentEmail) {
          const currentProfileDir = getProfileDir(currentEmail);
          const daemonManager = new DaemonManager(currentProfileDir);
          await daemonManager.stop();
        }

        await writeFile(getCurrentProfilePath(), email, 'utf8');
        printSuccess(`Switched to account: ${email}`);
      } catch (error) {
        printError(`Failed to switch account: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  accounts
    .command('remove')
    .argument('<email>', 'Email address to remove')
    .description('Remove account credentials')
    .action(async (email: string) => {
      try {
        const profileManager = new ProfileManager();
        const currentEmail = await profileManager.getCurrentEmail();

        if (currentEmail === email) {
          const profileDir = getProfileDir(email);
          const daemonManager = new DaemonManager(profileDir);
          await daemonManager.stop();
        }

        await profileManager.purgeProfile(email);
        printSuccess(`Account removed: ${email}`);
      } catch (error) {
        printError(`Failed to remove account: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });
}
