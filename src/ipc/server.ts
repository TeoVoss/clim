import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { IPC_ERRORS, type IpcNotification, type IpcRequest, type IpcResponse } from './protocol.js';

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIpcRequest(value: unknown): value is IpcRequest {
  if (!isObject(value)) {
    return false;
  }

  return (
    value.jsonrpc === '2.0' &&
    typeof value.id === 'string' &&
    typeof value.method === 'string' &&
    (value.params === undefined || isObject(value.params))
  );
}

function isValidNotification(value: unknown): value is IpcNotification {
  if (!isObject(value)) {
    return false;
  }

  return value.jsonrpc === '2.0' && typeof value.method === 'string' && isObject(value.params);
}

export class IpcServer {
  private server: Server | null = null;
  private handlers = new Map<string, MethodHandler>();
  private clients = new Set<Socket>();
  private socketPath: string | null = null;

  registerMethod(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  async start(socketPath: string): Promise<void> {
    if (this.server) {
      throw new Error('IPC server already started');
    }

    this.socketPath = socketPath;

    await unlink(socketPath).catch(() => undefined);

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.clients.add(socket);
        socket.setEncoding('utf8');

        let buffer = '';

        socket.on('data', (chunk: string) => {
          buffer += chunk;

          while (true) {
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) {
              break;
            }

            const rawLine = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (rawLine.length === 0) {
              continue;
            }

            this.handleLine(socket, rawLine).catch(() => undefined);
          }
        });

        const cleanup = () => {
          this.clients.delete(socket);
        };

        socket.on('close', cleanup);
        socket.on('error', cleanup);
      });

      server.on('error', (error) => {
        reject(error);
      });

      server.listen(socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    const server = this.server;
    this.server = null;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (this.socketPath) {
      await unlink(this.socketPath).catch(() => undefined);
      this.socketPath = null;
    }
  }

  broadcast(notification: IpcNotification): void {
    if (!isValidNotification(notification)) {
      return;
    }

    const payload = `${JSON.stringify(notification)}\n`;

    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload);
      }
    }
  }

  private async handleLine(socket: Socket, rawLine: string): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.writeResponse(socket, {
        jsonrpc: '2.0',
        id: '',
        error: {
          code: IPC_ERRORS.PARSE_ERROR,
          message: 'Parse error',
        },
      });
      return;
    }

    if (!isIpcRequest(parsed)) {
      const id = isObject(parsed) && typeof parsed.id === 'string' ? parsed.id : '';
      this.writeResponse(socket, {
        jsonrpc: '2.0',
        id,
        error: {
          code: IPC_ERRORS.INVALID_REQUEST,
          message: 'Invalid Request',
        },
      });
      return;
    }

    const handler = this.handlers.get(parsed.method);
    if (!handler) {
      this.writeResponse(socket, {
        jsonrpc: '2.0',
        id: parsed.id,
        error: {
          code: IPC_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${parsed.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(parsed.params ?? {});
      this.writeResponse(socket, {
        jsonrpc: '2.0',
        id: parsed.id,
        result,
      });
    } catch (error) {
      this.writeResponse(socket, {
        jsonrpc: '2.0',
        id: parsed.id,
        error: {
          code: IPC_ERRORS.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      });
    }
  }

  private writeResponse(socket: Socket, response: IpcResponse): void {
    if (socket.destroyed) {
      return;
    }

    socket.write(`${JSON.stringify(response)}\n`);
  }
}
