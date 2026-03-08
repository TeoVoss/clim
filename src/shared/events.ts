/**
 * Structured event model v1 for ChatCLI IPC.
 * All events broadcast from daemon follow this schema.
 */

export const EVENT_VERSION = 1 as const;

export type EventType =
  | 'message.text'
  | 'message.file'
  | 'message.image'
  | 'draft.created'
  | 'draft.approved'
  | 'draft.rejected'
  | 'typing.start'
  | 'typing.stop'
  | 'node.connected'
  | 'node.disconnected';

export interface StructuredEvent {
  version: typeof EVENT_VERSION;
  type: EventType;
  timestamp: number;
  roomId?: string;
  sender?: string;
  senderDisplayName?: string;
  payload: Record<string, unknown>;
}


export interface MessageTextPayload {
  eventId: string;
  body: string;
}

export interface MessageFilePayload {
  eventId: string;
  fileName: string;
  mimeType: string;
  size?: number;
  url?: string;
}

export interface DraftPayload {
  draftId: number;
  targetRoomId: string;
  targetRoomName: string;
  draftBody: string;
}

export interface NodeStatusPayload {
  deviceId?: string;
  commands?: string[];
}

export function createEvent(
  type: EventType,
  data: {
    roomId?: string;
    sender?: string;
    senderDisplayName?: string;
    payload: Record<string, unknown>;
  }
): StructuredEvent {
  return {
    version: EVENT_VERSION,
    type,
    timestamp: Date.now(),
    roomId: data.roomId,
    sender: data.sender,
    senderDisplayName: data.senderDisplayName,
    payload: data.payload,
  };
}

// ─── com.clim.event: Matrix message metadata ───

export const CLIM_EVENT_KEY = 'com.clim.event' as const;
export const CLIM_EVENT_VERSION = 1 as const;

export type MessageIntent =
  | 'conversation'
  | 'inform'
  | 'request'
  | 'decision'
  | 'action_complete'
  | 'draft_proposal'
  | 'summary'
  | 'tool_result'
  | 'error';

export interface MessageSource {
  via: 'cli' | 'app' | 'gateway';
  interactive: boolean;
  agent_id?: string;
}

export interface MessageProvenance {
  model?: string;
  tools_used?: string[];
  latency_ms?: number;
  token_count?: number;
}

export interface ClimEventMeta {
  v: typeof CLIM_EVENT_VERSION;
  source: MessageSource;
  intent?: MessageIntent;
  structured?: Record<string, unknown>;
  provenance?: MessageProvenance;
}

export function createMessageMeta(
  source: MessageSource,
  opts?: {
    intent?: MessageIntent;
    structured?: Record<string, unknown>;
    provenance?: MessageProvenance;
  },
): ClimEventMeta {
  const meta: ClimEventMeta = {
    v: CLIM_EVENT_VERSION,
    source,
  };
  if (opts?.intent && opts.intent !== 'conversation') meta.intent = opts.intent;
  if (opts?.structured) meta.structured = opts.structured;
  if (opts?.provenance) meta.provenance = opts.provenance;
  return meta;
}
