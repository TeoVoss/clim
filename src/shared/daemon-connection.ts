import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IpcClient } from '../ipc/client.js';
import { DaemonManager } from '../daemon/lifecycle.js';
import { EXIT_CODES, VERSION } from './constants.js';
import { printError, printInfo } from './output.js';
import { getDaemonSockPath, getProfileDir, ProfileManager } from './profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonScript = join(__dirname, 'daemon.mjs');

export function fail(code: number): never {
  process.exit(code);
}

export async function requireProfileDir(): Promise<string> {
  const profileManager = new ProfileManager();
  const email = await profileManager.getCurrentEmail();
  if (!email) {
    printError('Not logged in. Run: clim login --email <email> --password <password>');
    fail(EXIT_CODES.AUTH_FAILED);
  }
  return getProfileDir(email);
}

export async function ensureDaemonAndConnect(profileDir: string): Promise<IpcClient> {
  const manager = new DaemonManager(profileDir);
  const sockPath = getDaemonSockPath(profileDir);

  if (await manager.isRunning()) {
    // Daemon is alive — check version match
    const client = new IpcClient();
    try {
      await client.connect(sockPath, 2000);
      const pong = await client.call('ping', {}, 2000) as { version?: string };
      if (pong.version === VERSION) {
        return client;
      }
      // Version mismatch — restart daemon
      await client.close().catch(() => undefined);
      printInfo(`Restarting daemon (${pong.version ?? '?'} → ${VERSION})...`);
      await manager.stop();
    } catch {
      await client.close().catch(() => undefined);
      // Can't reach daemon — will restart below
    }
  }

  printInfo('Starting daemon...');
  await manager.start(daemonScript);

  const client = new IpcClient();
  await client.connect(sockPath, 3000);
  return client;
}
