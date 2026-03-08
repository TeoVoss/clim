/**
 * Persistent storage for hook definitions.
 * Hooks are stored in `~/.clim/profiles/<email>/hooks.json`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type HookActionWebhook = {
  type: 'webhook';
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  secret?: string;
};

export type HookActionExec = {
  type: 'exec';
  command: string;
  args?: string[];
};

export type HookActionLog = {
  type: 'log';
  path?: string; // default: append to daemon stdout
};

export type HookAction = HookActionWebhook | HookActionExec | HookActionLog;

export interface HookDefinition {
  id: string;
  name: string;
  filter: string;       // "type=message.text,sender=@bob*"
  action: HookAction;
  enabled: boolean;
  createdAt: number;    // epoch ms
}

export class HooksStore {
  private hooks: HookDefinition[] | null = null;

  constructor(private hooksFilePath: string) {}

  async load(): Promise<HookDefinition[]> {
    try {
      const data = await readFile(this.hooksFilePath, 'utf8');
      this.hooks = JSON.parse(data) as HookDefinition[];
    } catch {
      this.hooks = [];
    }
    return this.hooks;
  }

  async save(hooks: HookDefinition[]): Promise<void> {
    this.hooks = hooks;
    await mkdir(dirname(this.hooksFilePath), { recursive: true });
    await writeFile(this.hooksFilePath, JSON.stringify(hooks, null, 2), 'utf8');
  }

  async list(): Promise<HookDefinition[]> {
    if (!this.hooks) await this.load();
    return this.hooks!;
  }

  async get(id: string): Promise<HookDefinition | null> {
    const hooks = await this.list();
    return hooks.find((h) => h.id === id) ?? null;
  }

  async add(hook: Omit<HookDefinition, 'id' | 'createdAt'>): Promise<HookDefinition> {
    const hooks = await this.list();
    const maxId = hooks.reduce((max, h) => {
      const num = Number.parseInt(h.id, 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);

    const newHook: HookDefinition = {
      ...hook,
      id: String(maxId + 1),
      createdAt: Date.now(),
    };

    hooks.push(newHook);
    await this.save(hooks);
    return newHook;
  }

  async remove(id: string): Promise<boolean> {
    const hooks = await this.list();
    const idx = hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;

    hooks.splice(idx, 1);
    await this.save(hooks);
    return true;
  }

  async enable(id: string): Promise<boolean> {
    return this.setEnabled(id, true);
  }

  async disable(id: string): Promise<boolean> {
    return this.setEnabled(id, false);
  }

  private async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const hooks = await this.list();
    const hook = hooks.find((h) => h.id === id);
    if (!hook) return false;

    hook.enabled = enabled;
    await this.save(hooks);
    return true;
  }
}
