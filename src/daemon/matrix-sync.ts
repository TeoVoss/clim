import { readFile, writeFile } from 'node:fs/promises';
import * as sdk from 'matrix-js-sdk';
import { createEvent, type StructuredEvent, type ClimEventMeta, CLIM_EVENT_KEY } from '../shared/events.js';

export interface RoomMember {
  userId: string;
  displayName: string;
}

export interface RoomInfo {
  roomId: string;
  name: string;
  type: 'agent' | 'human' | 'unknown';
  unreadCount: number;
  members: RoomMember[];
  lastMessage?: {
    sender: string;
    body: string;
    timestamp: number;
    eventId: string;
  };
}

export interface MessageInfo {
  eventId: string;
  sender: string;
  senderDisplayName: string;
  body: string;
  timestamp: number;
  roomId: string;
}

export interface SearchMessageInfo extends MessageInfo {
  roomName: string;
}

export interface MatrixSyncConfig {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  syncTokenPath?: string;
}

type ReplyWaiter = {
  resolve: (msg: MessageInfo) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class MatrixSyncManager {
  private client: sdk.MatrixClient | null = null;
  private syncing = false;
  private ownUserId: string | null = null;
  private eventListeners: Array<(event: MessageInfo) => void> = [];
  private structuredEventListeners: Array<(event: StructuredEvent) => void> = [];
  private replyWaiters = new Map<string, ReplyWaiter>();
  private currentConfig: MatrixSyncConfig | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncTokenPath: string | null = null;
  private syncTokenSaveTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private autoJoinAttempted = new Set<string>();
  async start(config: MatrixSyncConfig): Promise<void> {
    this.currentConfig = config;
    this.syncTokenPath = config.syncTokenPath ?? null;
    this.stopping = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      return;
    }

    this.ownUserId = config.userId;

    const client = sdk.createClient({
      baseUrl: config.homeserver,
      accessToken: config.accessToken,
      userId: config.userId,
      deviceId: config.deviceId,
    });
    this.client = client;

    const persistedSyncToken = await this.loadSyncToken();
    if (persistedSyncToken) {
      this.setClientSyncToken(client, persistedSyncToken);
      console.log('[MatrixSync] restored sync token from disk');
    }

    client.on(sdk.ClientEvent.Sync, (state) => {
      void this.handleSyncState(state);
    });

    client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) {
        return;
      }

      const message = this.toMessageInfo(event, room);
      if (!message) {
        return;
      }

      for (const listener of this.eventListeners) {
        listener(message);
      }

      const waiter = this.replyWaiters.get(message.roomId);
      if (waiter && message.sender !== this.ownUserId) {
        clearTimeout(waiter.timer);
        this.replyWaiters.delete(message.roomId);
        waiter.resolve(message);
      }
    });

    client.on(sdk.RoomMemberEvent.Typing, (_event, member) => {
      if (member.userId === this.ownUserId) {
        return;
      }

      const roomId = member.roomId;
      if (!roomId) {
        return;
      }

      const room = this.client?.getRoom(roomId);
      this.emitStructuredEvent(
        createEvent(member.typing ? 'typing.start' : 'typing.stop', {
          roomId,
          sender: member.userId,
          senderDisplayName: room?.getMember(member.userId)?.name ?? member.userId,
          payload: {},
        })
      );
    });

    // Auto-join group invites (same approach as Flutter App).
    // DM invites are auto-joined by Synapse (groupPolicy: open);
    // group invites need explicit client-side join.
    client.on(sdk.RoomEvent.MyMembership, (room, membership) => {
      if (membership === 'invite') {
        this.tryAutoJoinRoom(room);
      }
    });
    this.startSyncTokenAutoSave();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, 30000);

      const onSync = (state: sdk.SyncState): void => {
        if (state === 'PREPARED') {
          cleanup();
          resolve();
        }
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        client.off(sdk.ClientEvent.Sync, onSync);
      };

      client.on(sdk.ClientEvent.Sync, onSync);
      client.startClient({ initialSyncLimit: 20 });
    });

    // After initial sync, check for any pending group invites.
    this.autoJoinPendingInvites();
  }

  private async handleSyncState(state: sdk.SyncState): Promise<void> {
    if (state === 'PREPARED' || state === 'SYNCING' || state === 'CATCHUP') {
      this.syncing = true;
      this.reconnectAttempt = 0;
      await this.saveSyncToken();
      return;
    }

    if (state === 'ERROR') {
      this.syncing = false;

      if (this.stopping) {
        return;
      }

      console.error('[MatrixSync] sync error, scheduling reconnect...');
      await this.teardownClient({ clearReplyWaiters: false, saveSyncToken: true });
      this.scheduleReconnect();
      return;
    }

    this.syncing = state !== 'STOPPED';
  }

  private scheduleReconnect(): void {
    if (this.stopping) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(1000 * (2 ** this.reconnectAttempt), 30000);
    this.reconnectAttempt += 1;

    console.log(`[MatrixSync] reconnect attempt ${this.reconnectAttempt} in ${delayMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.stopping || !this.currentConfig) {
        return;
      }

      void this.start(this.currentConfig).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MatrixSync] reconnect failed: ${message}`);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private async loadSyncToken(): Promise<string | null> {
    if (!this.syncTokenPath) {
      return null;
    }

    try {
      const token = (await readFile(this.syncTokenPath, 'utf-8')).trim();
      return token.length > 0 ? token : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MatrixSync] failed to read sync token: ${message}`);
      }
      return null;
    }
  }

  private startSyncTokenAutoSave(): void {
    if (this.syncTokenSaveTimer) {
      clearInterval(this.syncTokenSaveTimer);
    }

    this.syncTokenSaveTimer = setInterval(() => {
      void this.saveSyncToken();
    }, 30000);
  }

  private async saveSyncToken(): Promise<void> {
    if (!this.syncTokenPath || !this.client) {
      return;
    }

    const token = this.getClientSyncToken(this.client);
    if (!token) {
      return;
    }

    try {
      await writeFile(this.syncTokenPath, token, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MatrixSync] failed to write sync token: ${message}`);
    }
  }

  private setClientSyncToken(client: sdk.MatrixClient, token: string): void {
    type MatrixStore = {
      setSyncToken?: (value: string) => void;
    };
    type MatrixClientWithStore = sdk.MatrixClient & {
      getStore?: () => MatrixStore | undefined;
    };

    const typedClient = client as MatrixClientWithStore;
    typedClient.getStore?.()?.setSyncToken?.(token);
  }

  private getClientSyncToken(client: sdk.MatrixClient): string | null {
    type MatrixStore = {
      getSyncToken?: () => string | null | undefined;
    };
    type MatrixClientWithSyncToken = sdk.MatrixClient & {
      getSyncToken?: () => string | null | undefined;
      getStore?: () => MatrixStore | undefined;
    };

    const typedClient = client as MatrixClientWithSyncToken;
    return typedClient.getSyncToken?.() ?? typedClient.getStore?.()?.getSyncToken?.() ?? null;
  }

  private async teardownClient(options: { clearReplyWaiters: boolean; saveSyncToken: boolean }): Promise<void> {
    if (options.saveSyncToken) {
      await this.saveSyncToken();
    }

    if (this.client) {
      this.client.stopClient();
      this.client.removeAllListeners();
      this.client = null;
    }

    if (this.syncTokenSaveTimer) {
      clearInterval(this.syncTokenSaveTimer);
      this.syncTokenSaveTimer = null;
    }

    if (options.clearReplyWaiters) {
      for (const [roomId, waiter] of this.replyWaiters.entries()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Wait for reply cancelled for room ${roomId}`));
      }
      this.replyWaiters.clear();
    }

    this.syncing = false;
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.teardownClient({ clearReplyWaiters: true, saveSyncToken: true });

    this.currentConfig = null;
    this.syncTokenPath = null;
    this.reconnectAttempt = 0;
  }
  isSyncing(): boolean {
    return this.syncing;
  }

  private tryAutoJoinRoom(room: sdk.Room): void {
    const roomId = room.roomId;

    // Skip if already attempted.
    if (this.autoJoinAttempted.has(roomId)) {
      return;
    }

    // Skip DM rooms — Synapse handles those via groupPolicy: open.
    const isDirect = room.getDMInviter() !== undefined;
    if (isDirect) {
      return;
    }

    this.autoJoinAttempted.add(roomId);
    console.log(`[MatrixSync] auto-joining group invite ${roomId}`);

    this.client?.joinRoom(roomId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MatrixSync] auto-join failed for ${roomId}: ${message}`);
      this.autoJoinAttempted.delete(roomId); // Allow retry on next sync
    });
  }

  private autoJoinPendingInvites(): void {
    if (!this.client) {
      return;
    }

    const rooms = this.client.getRooms();
    for (const room of rooms) {
      if (String(room.getMyMembership()).toLowerCase() === 'invite') {
        this.tryAutoJoinRoom(room);
      }
    }
  }


  getRooms(): RoomInfo[] {
    const client = this.requireClient();

    const rooms = client
      .getRooms()
      .filter((room) => String(room.getMyMembership()).toLowerCase() === 'join')
      .map((room) => {
        const lastMessage = this.getLastMessage(room);
        const members = this.getOtherMembers(room);

        return {
          roomId: room.roomId,
          name: room.name || room.roomId,
          type: this.detectRoomType(room),
          unreadCount: room.getUnreadNotificationCount(),
          members,
          lastMessage,
        } satisfies RoomInfo;
      });

    return rooms.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
  }

  async sendMessage(roomId: string, body: string, eventMeta?: ClimEventMeta): Promise<{ eventId: string }> {
    const client = this.requireClient();
    const content: Record<string, unknown> = { msgtype: sdk.MsgType.Text, body };
    if (eventMeta) {
      content[CLIM_EVENT_KEY] = eventMeta;
    }
    const result = await client.sendMessage(roomId, content);
    return { eventId: result.event_id };
  }

  async sendFile(
    roomId: string,
    filePath: string,
    fileName: string,
    mimeType: string,
    fileData: Buffer,
  ): Promise<{ eventId: string }> {
    const client = this.requireClient();
    const uploadResult = await client.uploadContent(new Uint8Array(fileData), { name: fileName, type: mimeType });
    const mxcUrl = typeof uploadResult === 'string' ? uploadResult : uploadResult.content_uri;

    if (!mxcUrl) {
      throw new Error(`Failed to upload file: ${filePath}`);
    }

    const result = await client.sendMessage(roomId, {
      msgtype: sdk.MsgType.File,
      body: fileName,
      url: mxcUrl,
      info: {
        mimetype: mimeType,
        size: fileData.byteLength,
      },
    });

    return { eventId: result.event_id };
  }

  async getMessages(roomId: string, limit: number): Promise<MessageInfo[]> {
    const client = this.requireClient();
    const room = client.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const normalizedLimit = Math.max(1, Math.min(limit, 200));

    let attempts = 0;
    while (attempts < 5) {
      const messages = this.extractMessages(room);
      if (messages.length >= normalizedLimit) {
        return messages.slice(-normalizedLimit);
      }

      const beforeCount = room.getLiveTimeline().getEvents().length;
      await client.scrollback(room, normalizedLimit);
      const afterCount = room.getLiveTimeline().getEvents().length;

      if (afterCount <= beforeCount) {
        break;
      }
      attempts += 1;
    }

    return this.extractMessages(room).slice(-normalizedLimit);
  }

  async searchMessages(query: string, roomId?: string, limit = 20): Promise<SearchMessageInfo[]> {
    const client = this.requireClient();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(limit, 1000));
    const joinedRooms = client
      .getRooms()
      .filter((room) => String(room.getMyMembership()).toLowerCase() === 'join');

    const targetRooms = roomId
      ? joinedRooms.filter((room) => room.roomId === roomId)
      : joinedRooms;

    if (roomId && targetRooms.length === 0) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const matches: SearchMessageInfo[] = [];

    for (const room of targetRooms) {
      const roomName = room.name || room.roomId;
      const messages = this.extractMessages(room);

      for (const message of messages) {
        if (message.body.toLowerCase().includes(normalizedQuery)) {
          matches.push({ ...message, roomName });
        }
      }
    }

    return matches
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, normalizedLimit);
  }

  waitForReply(roomId: string, timeout: number): Promise<MessageInfo> {
    this.requireClient();

    if (this.replyWaiters.has(roomId)) {
      throw new Error(`Already waiting for reply in room ${roomId}`);
    }

    return new Promise<MessageInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replyWaiters.delete(roomId);
        reject(new Error(`Timed out waiting for reply in room ${roomId}`));
      }, timeout);

      this.replyWaiters.set(roomId, { resolve, reject, timer });
    });
  }

  onEvent(listener: (event: MessageInfo) => void): () => void {
    this.eventListeners.push(listener);

    return () => {
      this.eventListeners = this.eventListeners.filter((current) => current !== listener);
    };
  }

  onStructuredEvent(listener: (event: StructuredEvent) => void): () => void {
    this.structuredEventListeners.push(listener);

    return () => {
      this.structuredEventListeners = this.structuredEventListeners.filter((current) => current !== listener);
    };
  }

  private emitStructuredEvent(event: StructuredEvent): void {
    for (const listener of this.structuredEventListeners) {
      listener(event);
    }
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    const client = this.requireClient();
    const room = client.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const event = room.findEventById(eventId);
    if (!event) {
      throw new Error(`Event not found in room ${roomId}: ${eventId}`);
    }

    await client.sendReadReceipt(event);
  }

  private requireClient(): sdk.MatrixClient {
    if (!this.client) {
      throw new Error('Matrix client not started');
    }

    return this.client;
  }

  private detectRoomType(room: sdk.Room): 'agent' | 'human' | 'unknown' {
    const ownUserId = this.ownUserId;
    const members = room.getJoinedMembers();

    if (members.length === 0) {
      return 'unknown';
    }

    let hasHuman = false;
    for (const member of members) {
      const userId = member.userId;
      if (userId === ownUserId) {
        continue;
      }

      const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
      if (localpart.startsWith('agent.')) {
        return 'agent';
      }

      hasHuman = true;
    }

    return hasHuman ? 'human' : 'unknown';
  }

  private getOtherMembers(room: sdk.Room): RoomMember[] {
    return room
      .getJoinedMembers()
      .filter((m) => m.userId !== this.ownUserId)
      .map((m) => ({ userId: m.userId, displayName: m.name || m.userId }));
  }

  private getLastMessage(room: sdk.Room): RoomInfo['lastMessage'] {
    const messages = this.extractMessages(room);
    const last = messages.at(-1);

    if (!last) {
      return undefined;
    }

    return {
      sender: last.sender,
      body: last.body,
      timestamp: last.timestamp,
      eventId: last.eventId,
    };
  }

  private extractMessages(room: sdk.Room): MessageInfo[] {
    const events = room.getLiveTimeline().getEvents();
    const messages = events
      .map((event) => this.toMessageInfo(event, room))
      .filter((message): message is MessageInfo => message !== null)
      .sort((a, b) => a.timestamp - b.timestamp);

    return messages;
  }

  private toMessageInfo(event: sdk.MatrixEvent, room?: sdk.Room | null): MessageInfo | null {
    if (event.getType() !== 'm.room.message') {
      return null;
    }

    const content = event.getContent() as Record<string, unknown>;
    const body = content.body;
    if (typeof body !== 'string') {
      return null;
    }

    const sender = event.getSender() ?? 'unknown';
    const eventId = event.getId() ?? '';
    const roomId = room?.roomId ?? event.getRoomId();
    if (!roomId) {
      return null;
    }

    const senderDisplayName = room?.getMember(sender)?.name ?? sender;

    return {
      eventId,
      sender,
      senderDisplayName,
      body,
      timestamp: event.getTs(),
      roomId,
    };
  }
}
