
import type { StructuredEvent } from '../shared/events.js';
export interface IpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface IpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export interface IpcEventNotification {
  jsonrpc: '2.0';
  method: 'event';
  params: StructuredEvent;
}

export type IpcMessage = IpcRequest | IpcResponse | IpcNotification | IpcEventNotification;


export const IPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
