import { createPrivateKey, createPublicKey, createHash, sign, randomUUID } from 'node:crypto';

export interface NodeClientConfig {
  gatewayUrl: string;
  gatewayToken: string;
  deviceKeyPem: string;
}

export interface InvokeRequest {
  requestId: string;
  command: string;
  paramsJSON: string | null;
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const COMMANDS = [
  'user_context.search',
  'user_context.rooms',
  'user_context.messages',
  'system.run',
  'file.read',
  'file.write',
  'shadow.draft.create',
] as const;

const CLIENT_ID = 'node-host';
const RECONNECT_DELAY_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 10000;

export class NodeClient {
  private ws: WebSocket | null = null;
  private config: NodeClientConfig | null = null;
  private privateKey: ReturnType<typeof createPrivateKey> | null = null;
  private deviceId: string | null = null;
  private publicKeyB64url: string | null = null;
  private connected = false;
  private intentionalDisconnect = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private challengeNonce: string | null = null;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingInvokes: InvokeRequest[] = [];

  private _onInvokeRequest: ((req: InvokeRequest) => void) | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  get currentDeviceId(): string | null {
    return this.deviceId;
  }

  get commands(): readonly string[] {
    return COMMANDS;
  }

  set onInvokeRequest(handler: ((req: InvokeRequest) => void) | null) {
    this._onInvokeRequest = handler;
    if (handler && this.pendingInvokes.length > 0) {
      const buffered = [...this.pendingInvokes];
      this.pendingInvokes = [];
      for (const inv of buffered) {
        handler(inv);
      }
    }
  }

  async connect(config: NodeClientConfig): Promise<void> {
    if (this.connected) return;

    this.config = config;
    this.intentionalDisconnect = false;

    this.loadKeyPair(config.deviceKeyPem);

    try {
      const ws = new WebSocket(config.gatewayUrl);
      this.ws = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connect timeout'));
          ws.close();
        }, 5000);

        ws.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        ws.addEventListener('error', (ev) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${String(ev)}`));
        }, { once: true });
      });

      ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
      ws.addEventListener('close', () => this.onClose());
      ws.addEventListener('error', () => { /* handled by close */ });

      // Wait for handshake (challenge → connect → hello-ok)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Handshake timeout'));
        }, HANDSHAKE_TIMEOUT_MS);

        this.handshakeResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        this.handshakeReject = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      this.connected = true;
      console.log(`[NodeClient] connected as node (device: ${this.deviceId?.substring(0, 16)}...)`);
    } catch (err) {
      console.error(`[NodeClient] connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.cleanup();
      this.scheduleReconnect();
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
  }

  sendInvokeResult(params: {
    requestId: string;
    ok: boolean;
    payload?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  }): void {
    if (!this.ws || !this.connected) return;

    const id = randomUUID();
    const resultParams: Record<string, unknown> = {
      id: params.requestId,
      nodeId: this.deviceId ?? CLIENT_ID,
      ok: params.ok,
    };

    if (params.payload) {
      resultParams.payloadJSON = JSON.stringify(params.payload);
    }

    if (!params.ok) {
      resultParams.error = {
        code: params.errorCode ?? 'UNKNOWN',
        message: params.errorMessage ?? 'Unknown error',
      };
    }

    this.send({
      type: 'req',
      id,
      method: 'node.invoke.result',
      params: resultParams,
    });
  }



  private loadKeyPair(pem: string): void {
    this.privateKey = createPrivateKey({
      key: pem,
      format: 'pem',
      type: 'pkcs8',
    });

    const publicKey = createPublicKey(this.privateKey);

    // Export raw public key bytes (32 bytes for Ed25519)
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    // SPKI DER for Ed25519: 12-byte prefix + 32-byte key
    const rawPubKey = pubDer.subarray(pubDer.length - 32);

    // deviceId = SHA256 hex of raw public key
    this.deviceId = createHash('sha256').update(rawPubKey).digest('hex');

    // base64url no padding
    this.publicKeyB64url = rawPubKey.toString('base64url');
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type as string | undefined;

    if (type === 'event') {
      const event = msg.event as string | undefined;
      if (event === 'connect.challenge') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        this.challengeNonce = (payload?.nonce as string) ?? null;
        this.sendConnectRequest().catch((err) => {
          console.error(`[NodeClient] connect request failed: ${err}`);
        });
      } else if (event === 'node.invoke.request') {
        this.handleInvokeRequest(msg.payload as Record<string, unknown> | undefined);
      }
    } else if (type === 'res') {
      const id = msg.id as string | undefined;
      if (id) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
      }

      // Check for hello-ok in response
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload?.type === 'hello-ok' && this.handshakeResolve) {
        this.handshakeResolve();
        this.handshakeResolve = null;
        this.handshakeReject = null;
      }
    }
  }

  private async sendConnectRequest(): Promise<void> {
    if (!this.privateKey || !this.challengeNonce || !this.config) return;

    const id = randomUUID();
    const signedAt = Date.now();
    const scopes = [...COMMANDS];

    // Signature payload: v2|deviceId|clientId|node|role|scopes|signedAt|authToken|nonce
    const signPayload = `v2|${this.deviceId}|${CLIENT_ID}|node|node|${scopes.join(',')}|${signedAt}|${this.config.gatewayToken}|${this.challengeNonce}`;

    const signature = sign(null, Buffer.from(signPayload), this.privateKey);
    const signatureB64url = signature.toString('base64url');

    const request = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        role: 'node',
        client: {
          id: CLIENT_ID,
          displayName: 'Pocket Claw CLI Node',
          version: '0.4.0',
          platform: 'cli',
          mode: 'node',
        },
        commands: [...COMMANDS],
        scopes,
        auth: { token: this.config.gatewayToken },
        device: {
          id: this.deviceId,
          publicKey: this.publicKeyB64url,
          signature: signatureB64url,
          signedAt,
          nonce: this.challengeNonce,
        },
      },
    };

    // Track pending request
    const completer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Connect request timeout'));
      }, HANDSHAKE_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });

    this.send(request);

    // The response will be picked up by onMessage → check for hello-ok
    const response = await completer;
    const payload = (response as Record<string, unknown>).payload as Record<string, unknown> | undefined;
    if (payload?.type === 'hello-ok' && this.handshakeResolve) {
      this.handshakeResolve();
      this.handshakeResolve = null;
      this.handshakeReject = null;
    }
  }

  private handleInvokeRequest(payload: Record<string, unknown> | undefined): void {
    if (!payload) return;

    const requestId = payload.id as string | undefined;
    const command = payload.command as string | undefined;
    const paramsJSON = (payload.paramsJSON as string) ?? null;

    if (!requestId || !command) return;

    const invokeReq: InvokeRequest = { requestId, command, paramsJSON };

    if (this._onInvokeRequest) {
      this._onInvokeRequest(invokeReq);
    } else {
      this.pendingInvokes.push(invokeReq);
    }
  }

  private onClose(): void {
    const wasConnected = this.connected;
    this.cleanup();
    if (wasConnected && !this.intentionalDisconnect) {
      console.log('[NodeClient] disconnected, scheduling reconnect...');
      this.scheduleReconnect();
    }
  }

  private cleanup(): void {
    this.connected = false;
    this.handshakeResolve = null;
    this.handshakeReject = null;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('NodeClient disconnected'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || !this.config) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      if (!this.connected && this.config) {
        this.connect(this.config).catch(() => { /* reconnect will retry */ });
      }
    }, RECONNECT_DELAY_MS);
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[NodeClient] send failed: ${err}`);
    }
  }
}
