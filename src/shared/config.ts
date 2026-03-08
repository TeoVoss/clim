import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE } from './constants.js';
import { getClimDir } from './profile.js';

export interface ClimConfig {
  provisioningUrl: string;
  feishuAppId?: string;      // Feishu OAuth App ID (or use FEISHU_APP_ID env var)
  defaultAgent?: string;     // default agent name for shell/chat
  timeout?: number;          // default timeout in seconds (default: 120)
  outputFormat?: 'text' | 'json';  // default output format
}

const DEFAULT_CONFIG: ClimConfig = {
  provisioningUrl: 'https://pocket-claw-dev.vibelandapp.com',
};

function getConfigPath(): string {
  return join(getClimDir(), CONFIG_FILE);
}

export async function loadConfig(): Promise<ClimConfig> {
  try {
    const content = await readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(content) as Partial<ClimConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: Partial<ClimConfig>): Promise<void> {
  const existing = await loadConfig();
  const merged: ClimConfig = {
    ...existing,
    ...config,
  };

  await mkdir(getClimDir(), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
}
