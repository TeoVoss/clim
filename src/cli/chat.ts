import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Command } from 'commander';
import { IpcClient } from '../ipc/client.js';
import { EXIT_CODES } from '../shared/constants.js';
import { createMessageMeta, type MessageIntent, type ClimEventMeta } from '../shared/events.js';
import { ensureDaemonAndConnect, fail, requireProfileDir } from '../shared/daemon-connection.js';
import { printData, printError, printInfo, printJson, printWarning } from '../shared/output.js';
import { resolveTarget } from '../shared/resolve-target.js';
import { createSession, loadSession, saveSession, type ChatSession } from '../shared/session.js';
import { ProfileManager } from '../shared/profile.js';

const MAX_CONTEXT_FILE_BYTES = 100 * 1024;

type ResolvedTarget = {
  roomId: string;
  displayName: string;
  type: 'agent' | 'human' | 'unknown';
};

interface RoomInfo {
  roomId: string;
  name: string;
  type: 'agent' | 'human' | 'unknown';
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text.length > 0 ? text : null;
}

function composeMessage(args: string[], stdinText: string | null): string {
  const argText = args.join(' ').trim();

  if (argText && stdinText) {
    return `${argText}\n\n${stdinText}`;
  }

  if (argText) {
    return argText;
  }

  if (stdinText) {
    return stdinText;
  }

  throw new Error('No message provided. Pass message as argument or pipe via stdin.');
}

function normalizeContextFiles(input: unknown): string[] {
  if (!input) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  const flattened = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return flattened.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

async function loadContextSections(filePaths: string[]): Promise<string[]> {
  const sections: string[] = [];

  for (const filePath of filePaths) {
    let fileData: Buffer;
    try {
      fileData = await readFile(filePath);
    } catch {
      throw new Error(`Context file not found: ${filePath}`);
    }

    let content = fileData.toString('utf-8');
    if (fileData.byteLength > MAX_CONTEXT_FILE_BYTES) {
      content = `${fileData.subarray(0, MAX_CONTEXT_FILE_BYTES).toString('utf-8')}\n[... truncated at 100KB]`;
    }

    sections.push(`[Context from ${basename(filePath)}]\n${content}\n---`);
  }

  return sections;
}

function prependContext(message: string, contextSections: string[]): string {
  if (contextSections.length === 0) {
    return message;
  }

  return `${contextSections.join('\n\n')}\n\n${message}`;
}

function getMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case '.txt':
      return 'text/plain';
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.csv':
      return 'text/csv';
    case '.xml':
      return 'application/xml';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

async function createNewSession(profileDir: string, roomId: string, targetName: string): Promise<ChatSession> {
  let attempts = 0;

  while (attempts < 20) {
    const id = randomBytes(4).toString('hex');

    try {
      await loadSession(profileDir, id);
      attempts += 1;
      continue;
    } catch {
      const session = createSession(id, roomId, targetName);
      await saveSession(profileDir, session);
      return session;
    }
  }

  throw new Error('Failed to create a unique session ID');
}

async function lookupRoom(ipc: IpcClient, roomId: string): Promise<RoomInfo | undefined> {
  const rooms = (await ipc.call('get_rooms', {})) as RoomInfo[];
  return rooms.find((room) => room.roomId === roomId);
}

interface ChatOptions {
  json?: boolean;
  wait?: boolean;
  timeout?: string;
  verbose?: boolean;
  quiet?: boolean;
  session?: string;
  contextFile?: unknown;
  file?: string;
  jsonOutput?: boolean;
  intent?: string;
  structured?: string;
  agentId?: string;
}

interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Send a message and optionally wait for reply')
    .argument('[target]', 'Agent name, @username, or room ID')
    .argument('[message...]', 'Message text')
    .option('--json', 'JSON output')
    .option('--wait', 'Wait for reply (default for agents)')
    .option('--no-wait', 'Do not wait for reply')
    .option('--timeout <seconds>', 'Reply timeout in seconds', '120')
    .option('--verbose', 'Include sender and timestamp in output')
    .option('--quiet', 'Suppress all stderr output')
    .option('--session <id>', 'Use local chat session ID, or "new" to create one')
    .option('--context-file <path...>', 'Attach local text context before the message')
    .option('--file <path>', 'Upload and send a file attachment')
    .option('--json-output', 'Ask reply in JSON and parse it when waiting')
    .option('--intent <type>', 'Message intent (conversation, inform, request, decision, action_complete, draft_proposal, summary, tool_result, error)')
    .option('--structured <json>', 'Structured data as JSON string')
    .option('--agent-id <id>', 'Source agent ID')
    .action(async (targetArg: string | undefined, messageArgs: string[], opts: ChatOptions) => {
      let ipc: IpcClient | null = null;

      try {
        const profileDir = await requireProfileDir();
        ipc = await ensureDaemonAndConnect(profileDir);

        const sessionOption = opts.session?.trim();
        const contextFiles = normalizeContextFiles(opts.contextFile);
        let session: ChatSession | null = null;
        let resolvedFromTarget = false;

        if (sessionOption && sessionOption !== 'new') {
          session = await loadSession(profileDir, sessionOption);
        }

        let targetInput = targetArg?.trim();
        if (targetInput === '') {
          targetInput = undefined;
        }

        let resolved: ResolvedTarget | null = null;

        if (targetInput) {
          try {
            const targetResolved = await resolveTarget(targetInput, ipc);
            resolved = {
              roomId: targetResolved.roomId,
              displayName: targetResolved.displayName,
              type: targetResolved.type,
            };
            resolvedFromTarget = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const canTreatAsMessage = Boolean(session && message.includes('Cannot resolve target') && messageArgs.length === 0);

            if (!canTreatAsMessage) {
              if (message.includes('Cannot resolve target')) {
                const pm = new ProfileManager();
                const creds = await pm.loadCredentials().catch(() => null);
                if (creds && !creds.gatewayUrl) {
                  printError(`Target "${targetInput}" not found. If this is an AI agent, run \`clim agents provision\` first.`);
                  fail(EXIT_CODES.NOT_FOUND);
                }
              }
              throw error;
            }

            messageArgs = [targetInput, ...messageArgs];
          }
        }

        if (!resolved && session) {
          const room = await lookupRoom(ipc, session.roomId);
          resolved = {
            roomId: session.roomId,
            displayName: room?.name ?? session.targetName,
            type: room?.type ?? 'unknown',
          };
        }

        if (!resolved && sessionOption === 'new') {
          throw new Error('Target is required when creating a new session.');
        }

        if (!resolved) {
          throw new Error('Target is required. Provide a target or use --session <id>.');
        }

        if (sessionOption === 'new') {
          session = await createNewSession(profileDir, resolved.roomId, resolved.displayName);
          if (!opts.quiet) {
            printInfo(`Session ID: ${session.id}`);
          }
        }

        if (session) {
          if (resolvedFromTarget) {
            session.roomId = resolved.roomId;
            session.targetName = resolved.displayName;
          }
          await saveSession(profileDir, session);
        }

        const stdinText = await readStdin();
        const hasMessageInput = messageArgs.join(' ').trim().length > 0 || (stdinText?.length ?? 0) > 0;

        if ((contextFiles.length > 0 || opts.jsonOutput) && !hasMessageInput) {
          throw new Error('Message text is required when using --context-file or --json-output.');
        }

        let body: string | null = null;
        if (hasMessageInput) {
          body = composeMessage(messageArgs, stdinText);
          if (contextFiles.length > 0) {
            const sections = await loadContextSections(contextFiles);
            body = prependContext(body, sections);
          }

          if (opts.jsonOutput) {
            body = `${body}\n\n[INSTRUCTION: Respond in valid JSON format only]`;
          }
        }

        if (!body && !opts.file) {
          throw new Error('No message provided. Pass message as argument or pipe via stdin.');
        }

        // Build structured event metadata
        const validIntents: MessageIntent[] = ['conversation', 'inform', 'request', 'decision', 'action_complete', 'draft_proposal', 'summary', 'tool_result', 'error'];
        let parsedStructured: Record<string, unknown> | undefined;
        if (opts.structured) {
          try {
            parsedStructured = JSON.parse(opts.structured) as Record<string, unknown>;
          } catch {
            throw new Error('Invalid JSON for --structured option.');
          }
        }
        const intentValue = opts.intent as MessageIntent | undefined;
        if (intentValue && !validIntents.includes(intentValue)) {
          throw new Error(`Invalid --intent value: ${opts.intent}. Valid: ${validIntents.join(', ')}`);
        }
        const eventMeta: ClimEventMeta = createMessageMeta(
          { via: 'cli', interactive: Boolean(process.stdin.isTTY), agent_id: opts.agentId },
          { intent: intentValue, structured: parsedStructured },
        );

        let sendResult: { eventId: string } | null = null;
        if (body) {
          sendResult = (await ipc.call('send_message', {
            roomId: resolved.roomId,
            body,
            eventMeta,
          })) as { eventId: string };
        }

        let fileSendResult: { eventId: string } | null = null;
        if (opts.file) {
          let fileData: Buffer;
          try {
            fileData = await readFile(opts.file);
          } catch {
            throw new Error(`File not found: ${opts.file}`);
          }

          const fileName = basename(opts.file);
          const mimeType = getMimeType(opts.file);

          fileSendResult = (await ipc.call('upload_and_send_file', {
            roomId: resolved.roomId,
            filePath: opts.file,
            fileName,
            mimeType,
            fileDataBase64: fileData.toString('base64'),
          })) as { eventId: string };
        }

        if (!opts.quiet) {
          printInfo(`Sent to ${resolved.displayName}`);
        }

        if (session) {
          session.lastActiveAt = Date.now();
          session.messageCount += 1;
          await saveSession(profileDir, session);
        }

        const shouldWait = opts.wait !== undefined
          ? opts.wait
          : resolved.type === 'agent';

        if (!shouldWait) {
          if (opts.json) {
            printJson({
              sent: true,
              target: resolved.displayName,
              roomId: resolved.roomId,
              eventId: sendResult?.eventId ?? fileSendResult?.eventId ?? null,
              fileEventId: fileSendResult?.eventId ?? null,
              reply: null,
            });
          }
          return;
        }

        const timeoutMs = Math.max(1, Number(opts.timeout) || 120) * 1000;

        if (!opts.quiet) {
          printInfo(`Waiting for reply (timeout: ${Math.round(timeoutMs / 1000)}s)...`);
        }

        const reply = (await ipc.call(
          'wait_for_reply',
          { roomId: resolved.roomId, timeout: timeoutMs },
          timeoutMs + 5000,
        )) as MessageInfo;

        // Mark as read after receiving reply
        await ipc.call('send_read_receipt', { roomId: resolved.roomId, eventId: reply.eventId }, 5000).catch(() => undefined);

        if (opts.json) {
          printJson({
            sent: true,
            target: resolved.displayName,
            roomId: resolved.roomId,
            eventId: sendResult?.eventId ?? fileSendResult?.eventId ?? null,
            fileEventId: fileSendResult?.eventId ?? null,
            reply: {
              sender: reply.sender,
              senderDisplayName: reply.senderDisplayName,
              body: reply.body,
              timestamp: reply.timestamp,
              eventId: reply.eventId,
            },
          });
          return;
        }

        if (opts.jsonOutput) {
          try {
            const parsed = JSON.parse(reply.body) as unknown;
            printJson(parsed);
          } catch {
            printData(reply.body);
            if (!opts.quiet) {
              printWarning('Reply is not valid JSON; printing raw output.');
            }
          }
          return;
        }

        if (opts.verbose) {
          const time = new Date(reply.timestamp).toLocaleTimeString();
          printData(`[${time}] ${reply.senderDisplayName}: ${reply.body}`);
        } else {
          printData(reply.body);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Timed out')) {
          if (!opts.quiet) {
            printError('Timed out waiting for reply');
          }
          fail(EXIT_CODES.TIMEOUT);
        }

        if (message.includes('Cannot resolve target')) {
          printError(message);
          fail(EXIT_CODES.NOT_FOUND);
        }

        if (
          message.includes('Target is required') ||
          message.includes('No message provided') ||
          message.includes('Session not found') ||
          message.includes('Invalid session file') ||
          message.includes('Context file not found') ||
          message.includes('File not found')
        ) {
          printError(message);
          fail(EXIT_CODES.INVALID_ARGS);
        }

        if (message.includes('IPC')) {
          printError(`Cannot connect to daemon: ${message}`);
          fail(EXIT_CODES.NETWORK_ERROR);
        }

        printError(message);
        fail(EXIT_CODES.ERROR);
      } finally {
        if (ipc) {
          await ipc.close().catch(() => undefined);
        }
      }
    });
}
