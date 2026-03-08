import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { HooksStore, HookDefinition, HookAction } from '../shared/hooks-store.js';
import type { StructuredEvent } from '../shared/events.js';
import { matchesFilter, parseFilter } from '../shared/filter.js';

export interface HookLogEntry {
  hookId: string;
  hookName: string;
  eventType: string;
  timestamp: number;
  ok: boolean;
  error?: string;
}

const MAX_LOG_ENTRIES = 50;

export class HookEngine {
  private hooks: HookDefinition[] = [];
  private log: HookLogEntry[] = [];

  constructor(private store: HooksStore) {}

  async start(): Promise<void> {
    this.hooks = await this.store.load();
  }

  async reload(): Promise<void> {
    this.hooks = await this.store.load();
  }

  async dispatch(event: StructuredEvent): Promise<void> {
    const eventRecord = event as unknown as Record<string, unknown>;

    for (const hook of this.hooks) {
      if (!hook.enabled) continue;

      const filter = parseFilter(hook.filter);
      if (filter.size === 0) continue;
      if (!matchesFilter(eventRecord, filter)) continue;

      this.executeAction(hook.action, event).then(() => {
        this.addLog(hook, event.type, true);
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.addLog(hook, event.type, false, msg);
        console.error(`[HookEngine] hook "${hook.name}" (${hook.id}) failed: ${msg}`);
      });
    }
  }

  async dispatchToHook(hookId: string, event: StructuredEvent): Promise<{ ok: boolean; error?: string }> {
    const hook = this.hooks.find((h) => h.id === hookId);
    if (!hook) return { ok: false, error: 'Hook not found' };

    try {
      await this.executeAction(hook.action, event);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getLog(): HookLogEntry[] {
    return [...this.log];
  }

  stop(): void {
    this.hooks = [];
  }

  private addLog(hook: HookDefinition, eventType: string, ok: boolean, error?: string): void {
    this.log.push({ hookId: hook.id, hookName: hook.name, eventType, timestamp: Date.now(), ok, error });
    if (this.log.length > MAX_LOG_ENTRIES) this.log.shift();
  }

  private async executeAction(action: HookAction, event: StructuredEvent): Promise<void> {
    switch (action.type) {
      case 'webhook':
        await this.executeWebhook(action, event);
        break;
      case 'exec':
        this.executeCommand(action, event);
        break;
      case 'log':
        await this.executeLog(action, event);
        break;
    }
  }

  private async executeWebhook(
    action: Extract<HookAction, { type: 'webhook' }>,
    event: StructuredEvent,
  ): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...action.headers,
    };

    if (action.secret) {
      const signature = createHmac('sha256', action.secret).update(body).digest('hex');
      headers['X-Clim-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(action.url, {
        method: action.method ?? 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error(`[HookEngine] webhook ${action.url} returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private executeCommand(
    action: Extract<HookAction, { type: 'exec' }>,
    event: StructuredEvent,
  ): void {
    const child = spawn(action.command, action.args ?? [], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false,
    });

    if (child.stdin) {
      child.stdin.write(JSON.stringify(event) + '\n');
      child.stdin.end();
    }

    child.on('error', (err) => {
      console.error(`[HookEngine] exec "${action.command}" error: ${err.message}`);
    });
  }

  private async executeLog(
    action: Extract<HookAction, { type: 'log' }>,
    event: StructuredEvent,
  ): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    if (action.path) {
      await appendFile(action.path, line, 'utf8');
    } else {
      process.stdout.write(line);
    }
  }
}
