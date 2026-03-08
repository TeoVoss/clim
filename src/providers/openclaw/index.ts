/**
 * OpenClaw provider for clim.
 *
 * Adds AI agent capabilities powered by OpenClaw Gateway:
 * - Node client (tool executor for Gateway)
 * - Invoke handler (system.run, file.read/write, user_context, shadow.draft)
 * - Draft store (批奏折)
 * - CLI commands: agents, node, drafts, piebox, summary
 */

import type { Command } from 'commander';
import type { ProviderRegistration, ProviderDaemonContext } from '../types.js';
import { createEvent } from '../../shared/events.js';
import { NodeClient } from './node-client.js';
import { DraftStore } from './draft-store.js';
import { registerInvokeHandler } from './invoke-handler.js';
import { registerAgentsCommand } from './agents-cli.js';
import { registerNodeCommand } from './node-cli.js';
import { registerDraftsCommand } from './drafts-cli.js';
import { registerPieboxCommand } from './piebox-cli.js';
import { registerSummaryCommand } from './summary-cli.js';

let nodeClient: NodeClient | null = null;
let draftStore: DraftStore | null = null;

export const openclawProvider: ProviderRegistration = {
  name: 'openclaw',

  registerCommands(program: Command) {
    registerAgentsCommand(program);
    registerNodeCommand(program);
    registerDraftsCommand(program);
    registerPieboxCommand(program);
    registerSummaryCommand(program);
  },

  async initDaemon(ctx: ProviderDaemonContext) {
    const creds = ctx.credentials;

    // Always register IPC methods so CLI commands work even without Gateway
    ctx.ipc.registerMethod('node_status', async () => ({
      connected: nodeClient?.isConnected ?? false,
      deviceId: nodeClient?.currentDeviceId ?? null,
      commands: nodeClient ? [...nodeClient.commands] : [],
    }));

    ctx.ipc.registerMethod('get_drafts', async (params) => {
      if (!draftStore) return [];
      const { status } = (params ?? {}) as { status?: string };
      const validStatuses = ['pending', 'approved', 'rejected', 'edited'] as const;
      const filterStatus = validStatuses.includes(status as typeof validStatuses[number])
        ? (status as typeof validStatuses[number])
        : undefined;
      return draftStore.list(filterStatus);
    });

    ctx.ipc.registerMethod('approve_draft', async (params) => {
      if (!draftStore) return { ok: false, error: 'Draft store not initialized' };
      const { id } = params as { id: number };
      const draft = draftStore.approve(id);
      if (!draft) return { ok: false, error: 'Draft not found or not pending' };
      const result = await ctx.matrixSync.sendMessage(draft.targetRoomId, draft.draftBody);
      return { ok: true, eventId: result.eventId };
    });

    ctx.ipc.registerMethod('reject_draft', async (params) => {
      if (!draftStore) return { ok: false, error: 'Draft store not initialized' };
      const { id } = params as { id: number };
      const draft = draftStore.reject(id);
      if (!draft) return { ok: false, error: 'Draft not found or not pending' };
      return { ok: true };
    });

    ctx.ipc.registerMethod('edit_draft', async (params) => {
      if (!draftStore) return { ok: false, error: 'Draft store not initialized' };
      const { id, body } = params as { id: number; body: string };
      const draft = draftStore.editBody(id, body);
      if (!draft) return { ok: false, error: 'Draft not found or not pending' };
      return { ok: true };
    });

    // Stop here if Gateway credentials are not available
    if (!creds.gatewayUrl || !creds.gatewayToken ||
        !(creds.cliNodeDeviceKeyPem || creds.nodeDeviceKeyPem)) {
      return;
    }

    nodeClient = new NodeClient();
    draftStore = new DraftStore();

    // Broadcast draft events via IPC
    draftStore.onDraft((draft) => {
      ctx.ipc.broadcast({
        jsonrpc: '2.0',
        method: 'event',
        params: createEvent('draft.created', {
          payload: {
            draftId: draft.id,
            targetRoomId: draft.targetRoomId,
            targetRoomName: draft.targetRoomName,
            draftBody: draft.draftBody,
          },
        }) as unknown as Record<string, unknown>,
      });
    });

    // Connect node client with invoke handler
    registerInvokeHandler({ nodeClient, draftStore, matrixSync: ctx.matrixSync });
    await nodeClient.connect({
      gatewayUrl: ctx.localizeUrl(creds.gatewayUrl),
      gatewayToken: creds.gatewayToken,
      deviceKeyPem: (creds.cliNodeDeviceKeyPem || creds.nodeDeviceKeyPem)!,
    });
  },

  async shutdownDaemon() {
    if (nodeClient) {
      await nodeClient.disconnect();
      nodeClient = null;
    }
    draftStore = null;
  },

  isAvailable(credentials) {
    return Boolean(credentials.gatewayUrl);
  },
};
