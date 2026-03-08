import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ChatSession {
  id: string;
  roomId: string;
  targetName: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
}

export function getSessionsDir(profileDir: string): string {
  return join(profileDir, 'sessions');
}

function getSessionFilePath(profileDir: string, sessionId: string): string {
  return join(getSessionsDir(profileDir), `${sessionId}.json`);
}

export async function loadSession(profileDir: string, sessionId: string): Promise<ChatSession> {
  const filePath = getSessionFilePath(profileDir, sessionId);
  let content: string;

  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Session not found: ${sessionId}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid session file: ${sessionId}`);
  }

  if (!isChatSession(parsed)) {
    throw new Error(`Invalid session file: ${sessionId}`);
  }

  return parsed;
}

export async function saveSession(profileDir: string, session: ChatSession): Promise<void> {
  const sessionsDir = getSessionsDir(profileDir);
  await mkdir(sessionsDir, { recursive: true });

  const filePath = getSessionFilePath(profileDir, session.id);
  await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

export function createSession(sessionId: string, roomId: string, targetName: string): ChatSession {
  const now = Date.now();

  return {
    id: sessionId,
    roomId,
    targetName,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatSession(value: unknown): value is ChatSession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.roomId === 'string' &&
    typeof value.targetName === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.lastActiveAt === 'number' &&
    typeof value.messageCount === 'number'
  );
}
