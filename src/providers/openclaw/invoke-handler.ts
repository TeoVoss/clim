import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NodeClient, InvokeRequest } from './node-client.js';
import type { DraftStore } from './draft-store.js';
import type { MatrixSyncManager } from '../../daemon/matrix-sync.js';

export interface InvokeHandlerDeps {
  nodeClient: NodeClient;
  draftStore: DraftStore;
  matrixSync: MatrixSyncManager;
}

export function registerInvokeHandler(deps: InvokeHandlerDeps): void {
  const { nodeClient, draftStore, matrixSync } = deps;

  nodeClient.onInvokeRequest = (req: InvokeRequest) => {
    handleCommand(nodeClient, draftStore, matrixSync, req).catch((err) => {
      console.error(`[InvokeHandler] unhandled error for ${req.command}:`, err);
      nodeClient.sendInvokeResult({
        requestId: req.requestId,
        ok: false,
        errorCode: 'INTERNAL_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    });
  };
}

async function handleCommand(
  nodeClient: NodeClient,
  draftStore: DraftStore,
  matrixSync: MatrixSyncManager,
  req: InvokeRequest,
): Promise<void> {
  const params = req.paramsJSON ? (JSON.parse(req.paramsJSON) as Record<string, unknown>) : {};

  switch (req.command) {
    case 'system.run':
      return handleSystemRun(nodeClient, req.requestId, params);
    case 'file.read':
      return handleFileRead(nodeClient, req.requestId, params);
    case 'file.write':
      return handleFileWrite(nodeClient, req.requestId, params);
    case 'user_context.search':
      return handleUserContextSearch(nodeClient, matrixSync, req.requestId, params);
    case 'user_context.rooms':
      return handleUserContextRooms(nodeClient, matrixSync, req.requestId);
    case 'user_context.messages':
      return handleUserContextMessages(nodeClient, matrixSync, req.requestId, params);
    case 'shadow.draft.create':
      return handleShadowDraftCreate(nodeClient, draftStore, req.requestId, params);
    default:
      nodeClient.sendInvokeResult({
        requestId: req.requestId,
        ok: false,
        errorCode: 'UNKNOWN_COMMAND',
        errorMessage: `Unknown invoke command: ${req.command}`,
      });
  }
}

const SYSTEM_RUN_TIMEOUT_MS = 30_000;

function handleSystemRun(
  nodeClient: NodeClient,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  let command = '';
  const raw = params.command;
  if (typeof raw === 'string') {
    command = raw;
  } else if (Array.isArray(raw)) {
    command = raw.map(String).join(' ');
  }

  if (!command) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "command" parameter',
    });
    return Promise.resolve();
  }

  console.log(`[InvokeHandler] system.run: ${command}`);

  return new Promise<void>((resolve) => {
    const child = exec(command, { timeout: SYSTEM_RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      nodeClient.sendInvokeResult({
        requestId,
        ok: true,
        payload: {
          stdout,
          stderr,
          exitCode: child.exitCode ?? (err ? 1 : 0),
        },
      });
      resolve();
    });
  });
}

async function handleFileRead(
  nodeClient: NodeClient,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const filePath = params.path as string | undefined;

  if (!filePath) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "path" parameter',
    });
    return;
  }

  if (filePath.includes('..')) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'SECURITY_ERROR',
      errorMessage: 'Path traversal not allowed',
    });
    return;
  }

  try {
    await stat(filePath);
  } catch {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'FILE_NOT_FOUND',
      errorMessage: `File not found: ${filePath}`,
    });
    return;
  }

  const content = await readFile(filePath, 'utf-8');
  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { content, path: filePath },
  });
}

async function handleFileWrite(
  nodeClient: NodeClient,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const filePath = params.path as string | undefined;
  const content = params.content as string | undefined;

  if (!filePath) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "path" parameter',
    });
    return;
  }

  if (content === undefined || content === null) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "content" parameter',
    });
    return;
  }

  if (filePath.includes('..')) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'SECURITY_ERROR',
      errorMessage: 'Path traversal not allowed',
    });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { success: true, path: filePath },
  });
}

function handleUserContextSearch(
  nodeClient: NodeClient,
  matrixSync: MatrixSyncManager,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const query = (params.query as string) ?? '';
  const limit = (params.limit as number) ?? 20;

  if (!query) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "query" parameter',
    });
    return Promise.resolve();
  }

  const rooms = matrixSync.getRooms();
  const results: Array<{ roomId: string; roomName: string; sender: string; body: string; timestamp: number }> = [];

  const lowerQuery = query.toLowerCase();
  for (const room of rooms) {
    if (room.lastMessage && room.lastMessage.body.toLowerCase().includes(lowerQuery)) {
      results.push({
        roomId: room.roomId,
        roomName: room.name,
        sender: room.lastMessage.sender,
        body: room.lastMessage.body,
        timestamp: room.lastMessage.timestamp,
      });
    }
    if (results.length >= limit) break;
  }

  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { results, totalMatches: results.length },
  });
  return Promise.resolve();
}

function handleUserContextRooms(
  nodeClient: NodeClient,
  matrixSync: MatrixSyncManager,
  requestId: string,
): Promise<void> {
  const rooms = matrixSync.getRooms().map((r) => ({
    roomId: r.roomId,
    name: r.name,
    type: r.type,
    unreadCount: r.unreadCount,
    memberCount: r.members.length,
  }));

  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { rooms },
  });
  return Promise.resolve();
}

async function handleUserContextMessages(
  nodeClient: NodeClient,
  matrixSync: MatrixSyncManager,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const roomId = params.roomId as string | undefined;
  const limit = (params.limit as number) ?? 50;

  if (!roomId) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "roomId" parameter',
    });
    return;
  }

  const messages = await matrixSync.getMessages(roomId, limit);
  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { messages },
  });
}

function handleShadowDraftCreate(
  nodeClient: NodeClient,
  draftStore: DraftStore,
  requestId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const targetRoomId = params.targetRoomId as string | undefined;
  const targetRoomName = (params.targetRoomName as string) ?? 'Unknown';
  const draftBody = params.draftBody as string | undefined;

  if (!targetRoomId) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "targetRoomId" parameter',
    });
    return Promise.resolve();
  }

  if (!draftBody) {
    nodeClient.sendInvokeResult({
      requestId,
      ok: false,
      errorCode: 'INVALID_PARAMS',
      errorMessage: 'Missing required "draftBody" parameter',
    });
    return Promise.resolve();
  }

  const draft = draftStore.create({ targetRoomId, targetRoomName, draftBody });
  console.log(`[InvokeHandler] shadow.draft.create: draft #${draft.id} for room ${targetRoomId}`);

  nodeClient.sendInvokeResult({
    requestId,
    ok: true,
    payload: { created: true, draftId: draft.id },
  });
  return Promise.resolve();
}
