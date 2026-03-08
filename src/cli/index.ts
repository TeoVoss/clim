import { Command } from 'commander';
import { VERSION } from '../shared/constants.js';
import { registerAuthCommands } from './auth.js';
import { registerDaemonCommands } from './daemon.js';
import { registerChatCommand } from './chat.js';
import { registerHistoryCommand } from './history.js';
import { registerRoomsCommand } from './rooms.js';
import { registerUnreadCommand } from './unread.js';
import { registerWatchCommand } from './watch.js';
import { registerOnCommand } from './on.js';
import { registerContactsCommand } from './contacts.js';
import { registerStatusCommand } from './status.js';
import { registerConfigCommand } from './config-cmd.js';
import { registerAccountsCommand } from './accounts.js';
import { registerDoctorCommand } from './doctor.js';
import { registerShellCommand } from './shell.js';
import { registerExportCommand } from './export.js';
import { registerSearchCommand } from './search.js';
import { registerHookCommand } from './hook.js';
import { openclawProvider } from '../providers/openclaw/index.js';
import type { ProviderRegistration } from '../providers/types.js';

const program = new Command();

program
  .name('clim')
  .description('clim — CLI messenger for humans and AI agents')
  .version(VERSION)
  .enablePositionalOptions(true);

  registerAuthCommands(program);
  registerDaemonCommands(program);
registerChatCommand(program);
registerHistoryCommand(program);
registerRoomsCommand(program);
registerUnreadCommand(program);
registerWatchCommand(program);
registerOnCommand(program);
registerShellCommand(program);
registerContactsCommand(program);
registerStatusCommand(program);
registerConfigCommand(program);
registerAccountsCommand(program);
registerDoctorCommand(program);
registerExportCommand(program);
registerSearchCommand(program);
registerHookCommand(program);

const providers: ProviderRegistration[] = [openclawProvider];
for (const provider of providers) {
  if (provider.registerCommands) {
    provider.registerCommands(program);
  }
}

program.parse();
