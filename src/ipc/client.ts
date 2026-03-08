import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { type IpcNotification, type IpcRequest, type IpcResponse } from './protocol.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIpcResponse(value: unknown): value is IpcResponse {
  if (!isObject(value)) {
    return false;
  }

  if (value.jsonrpc !== '2.0' || typeof value.id !== 'string') {
    return false;
  }

  if (value.error === undefined) {
    return true;
  }

  if (!isObject(value.error)) {
    return false;
  }

  return typeof value.error.code === 'number' && typeof value.error.message === 'string';
}

function isIpcNotification(value: unknown): value is IpcNotification {
  if (!isObject(value)) {
    return false;
  }

  return value.jsonrpc === '2.0' && typeof value.method === 'string' && isObject(value.params);
}

export class IpcClient {
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private notificationHandlers: Array<(notification: IpcNotification) => void> = [];

  async connect(socketPath: string, timeout = 5000): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    this.buffer = '';

    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath);
      this.socket = socket;
      socket.setEncoding('utf8');

      let connected = false;
      let settled = false;

      const timer = setTimeout(() => {
        const error = new Error(`IPC connect timeout after ${timeout}ms`);
        if (!settled) {
          settled = true;
          reject(error);
        }
        socket.destroy(error);
      }, timeout);

      const settleResolve = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };

      const settleReject = (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };

      socket.on('connect', () => {
        connected = true;
        settleResolve();
      });

      socket.on('data', (chunk: string) => {
        this.buffer += chunk;

        while (true) {
          const newlineIndex = this.buffer.indexOf('\n');
          if (newlineIndex === -1) {
            break;
          }

          const rawLine = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);

          if (rawLine.length === 0) {
            continue;
          }

          this.handleLine(rawLine);
        }
      });

      socket.on('error', (error) => {
        if (!connected) {
          settleReject(error);
        }
      });

      socket.on('close', () => {
        this.socket = null;
        this.rejectAllPending(new Error('IPC socket closed'));
      });
    });
  }

  async call(method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('IPC client is not connected');
    }

    const id = randomUUID();
    const request: IpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC request timeout after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.socket.write(`${JSON.stringify(request)}\n`);

    return responsePromise;
  }

  onNotification(handler: (notification: IpcNotification) => void): void {
    this.notificationHandlers.push(handler);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;

    this.rejectAllPending(new Error('IPC client closed'));

    if (!socket || socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }, 100);
    });
  }

  private handleLine(rawLine: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return;
    }

    if (isIpcResponse(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);

      if (parsed.error) {
        const error = new Error(parsed.error.message);
        (error as Error & { code?: number; data?: unknown }).code = parsed.error.code;
        (error as Error & { code?: number; data?: unknown }).data = parsed.error.data;
        pending.reject(error);
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (isIpcNotification(parsed)) {
      for (const handler of this.notificationHandlers) {
        handler(parsed);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
