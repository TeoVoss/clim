import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MatrixSyncManager } from './matrix-sync.js';
import { HookEngine } from './hook-engine.js';
import { TokenRefresher } from './token-refresher.js';
import { IpcServer } from '../ipc/server.js';
import { CREDENTIALS_FILE, VERSION } from '../shared/constants.js';
import { loadConfig } from '../shared/config.js';
import { getDaemonSockPath, type StoredCredentials } from '../shared/profile.js';
import { createEvent, type EventType, type ClimEventMeta, type StructuredEvent } from '../shared/events.js';
import { HooksStore } from '../shared/hooks-store.js';
import { openclawProvider } from '../providers/openclaw/index.js';
import type { ProviderRegistration } from '../providers/types.js';

const profileDirIdx = process.argv.indexOf('--profile-dir');
if (profileDirIdx === -1 || !process.argv[profileDirIdx + 1]) {
  console.error('climd: --profile-dir is required');
  process.exit(1);
}

const profileDir = process.argv[profileDirIdx + 1];
const sockPath = getDaemonSockPath(profileDir);
const credPath = join(profileDir, CREDENTIALS_FILE);
const syncTokenPath = join(profileDir, 'sync-token');
const credData = await readFile(credPath, 'utf-8');
const credentials = JSON.parse(credData) as StoredCredentials;

function localizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const isPrivate =
      host === 'host.docker.internal' ||
      host.startsWith('172.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.');
    if (isPrivate) {
      parsed.hostname = 'localhost';
      return parsed.toString().replace(/\/$/, '');
    }
    return url;
  } catch {
    return url;
  }
}

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, methodName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Method '${methodName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const ipc = new IpcServer();
const matrixSync = new MatrixSyncManager();

const providers: ProviderRegistration[] = [openclawProvider];

ipc.registerMethod('ping', async () => withTimeout(async () => ({ pong: true, version: VERSION }), 5000, 'ping'));
ipc.registerMethod('status', async () => withTimeout(async () => ({
  version: VERSION,
  pid: process.pid,
  uptime: process.uptime(),
  memoryUsage: process.memoryUsage().rss,
  matrixSyncing: matrixSync.isSyncing(),
  roomCount: matrixSync.getRooms().length,
}), 5000, 'status'));

ipc.registerMethod('get_rooms', async () => withTimeout(async () => matrixSync.getRooms(), 30000, 'get_rooms'));

ipc.registerMethod('send_message', async (params) => withTimeout(async () => {
  const { roomId, body, eventMeta } = params as { roomId: string; body: string; eventMeta?: ClimEventMeta };
  return matrixSync.sendMessage(roomId, body, eventMeta);
}, 30000, 'send_message'));

ipc.registerMethod('upload_and_send_file', async (params) => withTimeout(async () => {
  const { roomId, filePath, fileName, mimeType, fileDataBase64 } = params as {
    roomId: string;
    filePath: string;
    fileName: string;
    mimeType: string;
    fileDataBase64: string;
  };

  const fileData = Buffer.from(fileDataBase64, 'base64');
  return matrixSync.sendFile(roomId, filePath, fileName, mimeType, fileData);
}, 30000, 'upload_and_send_file'));

ipc.registerMethod('get_messages', async (params) => withTimeout(async () => {
  const { roomId, limit = 20 } = params as { roomId: string; limit?: number };
  return matrixSync.getMessages(roomId, limit);
}, 30000, 'get_messages'));

ipc.registerMethod('search_messages', async (params) => withTimeout(async () => {
  const { query, roomId, limit = 20 } = params as { query: string; roomId?: string; limit?: number };
  return matrixSync.searchMessages(query, roomId, limit);
}, 30000, 'search_messages'));

ipc.registerMethod('wait_for_reply', async (params) => {
  const { roomId, timeout = 120000 } = params as { roomId: string; timeout?: number };
  return matrixSync.waitForReply(roomId, timeout);
});

ipc.registerMethod('subscribe_events', async () => withTimeout(async () => ({ subscribed: true }), 5000, 'subscribe_events'));

ipc.registerMethod('send_read_receipt', async (params) => withTimeout(async () => {
  const { roomId, eventId } = params as { roomId: string; eventId: string };
  await matrixSync.sendReadReceipt(roomId, eventId);
  return { ok: true };
}, 30000, 'send_read_receipt'));

const hooksStore = new HooksStore(join(profileDir, 'hooks.json'));
const hookEngine = new HookEngine(hooksStore);
await hookEngine.start();

function dispatchToHooks(event: StructuredEvent): void {
  hookEngine.dispatch(event).catch((err) => {
    console.error(`[HookEngine] dispatch error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

matrixSync.onEvent((event) => {
  const eventType: EventType = 'message.text';

  const structured = createEvent(eventType, {
    roomId: event.roomId,
    sender: event.sender,
    senderDisplayName: event.senderDisplayName,
    payload: {
      eventId: event.eventId,
      body: event.body,
    },
  });

  ipc.broadcast({
    jsonrpc: '2.0',
    method: 'event',
    params: structured as unknown as Record<string, unknown>,
  });

  dispatchToHooks(structured);
});

matrixSync.onStructuredEvent((event) => {
  ipc.broadcast({
    jsonrpc: '2.0',
    method: 'event',
    params: event as unknown as Record<string, unknown>,
  });

  dispatchToHooks(event);
});

await matrixSync.start({
  homeserver: localizeUrl(credentials.matrixCredentials.homeserver),
  userId: credentials.matrixCredentials.userId,
  accessToken: credentials.matrixCredentials.accessToken,
  deviceId: credentials.matrixCredentials.deviceId,
  syncTokenPath,
});

await ipc.start(sockPath);

ipc.registerMethod('hook_list', async () => hooksStore.list());

ipc.registerMethod('hook_add', async (params) => {
  const { name, filter, action, enabled } = params as {
    name: string; filter: string; action: { type: string; [key: string]: unknown }; enabled: boolean;
  };
  const result = await hooksStore.add({ name, filter, action: action as import('../shared/hooks-store.js').HookAction, enabled });
  await hookEngine.reload();
  return result;
});

ipc.registerMethod('hook_remove', async (params) => {
  const { id } = params as { id: string };
  const ok = await hooksStore.remove(id);
  if (ok) await hookEngine.reload();
  return { ok, error: ok ? undefined : 'Hook not found' };
});

ipc.registerMethod('hook_enable', async (params) => {
  const { id } = params as { id: string };
  const ok = await hooksStore.enable(id);
  if (ok) await hookEngine.reload();
  return { ok, error: ok ? undefined : 'Hook not found' };
});

ipc.registerMethod('hook_disable', async (params) => {
  const { id } = params as { id: string };
  const ok = await hooksStore.disable(id);
  if (ok) await hookEngine.reload();
  return { ok, error: ok ? undefined : 'Hook not found' };
});

ipc.registerMethod('hook_test', async (params) => {
  const { id, event } = params as { id: string; event: StructuredEvent };
  return hookEngine.dispatchToHook(id, event);
});

ipc.registerMethod('hook_history', async () => hookEngine.getLog());

const providerContext = { matrixSync, ipc, credentials, localizeUrl };
for (const provider of providers) {
  if (provider.initDaemon) {
    await provider.initDaemon(providerContext).catch((err) => {
      console.error(`[Daemon] Provider '${provider.name}' init failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

const config = await loadConfig();
const tokenRefresher = new TokenRefresher({
  provisioningUrl: config.provisioningUrl,
  credentialsPath: credPath,
  onTokenRefreshed: async (newAccessToken) => {
    const newCredData = await readFile(credPath, 'utf-8');
    const newCreds = JSON.parse(newCredData) as StoredCredentials;
    await matrixSync.stop();
    await matrixSync.start({
      homeserver: localizeUrl(newCreds.matrixCredentials.homeserver),
      userId: newCreds.matrixCredentials.userId,
      accessToken: newAccessToken,
      deviceId: newCreds.matrixCredentials.deviceId,
      syncTokenPath,
    });
    console.log('[Daemon] Matrix reconnected with refreshed token');
  },
});
tokenRefresher.start(
  credentials.accessToken ?? credentials.matrixCredentials.accessToken,
  credentials.refreshToken ?? '',
);

const hasProviders = providers.some((p) => p.isAvailable?.(credentials));
if (hasProviders) {
  console.log(`climd v${VERSION} started (PID: ${process.pid})`);
} else {
  console.log(`climd v${VERSION} started in social mode (PID: ${process.pid})`);
  console.log('  Run `clim agents provision` to enable AI agent features.');
}

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log('climd shutting down...');
  tokenRefresher.stop();
  hookEngine.stop();
  for (const provider of providers) {
    if (provider.shutdownDaemon) {
      await provider.shutdownDaemon().catch(() => {});
    }
  }
  await matrixSync.stop();
  await ipc.stop();
  process.exit(0);
};

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
