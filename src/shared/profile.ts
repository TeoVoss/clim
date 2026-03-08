import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIALS_FILE,
  CURRENT_PROFILE_FILE,
  CLIM_DIR,
  PROFILES_DIR,
} from './constants.js';

/**
 * macOS limits Unix socket paths to 104 bytes.
 * Profile dirs can exceed that (temp dirs + email).
 * Use a short hash in /tmp instead.
 */
export function getDaemonSockPath(profileDir: string): string {
  const hash = createHash('sha256').update(profileDir).digest('hex').slice(0, 12);
  return join('/tmp', `clim-${hash}.sock`);
}

export interface StoredCredentials {
  email: string;
  userId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  matrixCredentials: {
    homeserver: string;
    userId: string;
    accessToken: string;
    deviceId: string;
  };
  gatewayUrl: string | null;
  gatewayToken: string | null;
  nodeDeviceKeyPem: string | null;
  cliNodeDeviceKeyPem?: string | null;
}

export function getClimDir(): string {
  return join(homedir(), CLIM_DIR);
}

export function getProfilesDir(): string {
  return join(getClimDir(), PROFILES_DIR);
}

export function getProfileDir(email: string): string {
  return join(getProfilesDir(), email);
}

export function getCurrentProfilePath(): string {
  return join(getClimDir(), CURRENT_PROFILE_FILE);
}

function getCredentialsPath(email: string): string {
  return join(getProfileDir(email), CREDENTIALS_FILE);
}

export class ProfileManager {
  async saveCredentials(email: string, credentials: StoredCredentials): Promise<void> {
    const profileDir = getProfileDir(email);
    const credentialsPath = getCredentialsPath(email);

    await mkdir(profileDir, { recursive: true });
    await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), 'utf8');

    await mkdir(getClimDir(), { recursive: true });
    await writeFile(getCurrentProfilePath(), email, 'utf8');
  }

  async loadCredentials(email?: string): Promise<StoredCredentials> {
    const activeEmail = email ?? (await this.getCurrentEmail());
    if (!activeEmail) {
      throw new Error('Not logged in');
    }

    const credentialsPath = getCredentialsPath(activeEmail);
    let content: string;
    try {
      content = await readFile(credentialsPath, 'utf8');
    } catch {
      throw new Error(`Credentials not found for profile: ${activeEmail}`);
    }

    try {
      return JSON.parse(content) as StoredCredentials;
    } catch {
      throw new Error(`Invalid credentials file for profile: ${activeEmail}`);
    }
  }

  async getCurrentEmail(): Promise<string | null> {
    try {
      const content = await readFile(getCurrentProfilePath(), 'utf8');
      const email = content.trim();
      return email.length > 0 ? email : null;
    } catch {
      return null;
    }
  }

  async deleteCredentials(email: string): Promise<void> {
    const credentialsPath = getCredentialsPath(email);
    await unlink(credentialsPath).catch(() => undefined);

    const currentEmail = await this.getCurrentEmail();
    if (currentEmail === email) {
      await unlink(getCurrentProfilePath()).catch(() => undefined);
    }
  }

  async purgeProfile(email: string): Promise<void> {
    const profileDir = getProfileDir(email);
    await rm(profileDir, { recursive: true, force: true });

    const currentEmail = await this.getCurrentEmail();
    if (currentEmail === email) {
      await unlink(getCurrentProfilePath()).catch(() => undefined);
    }
  }

  async listProfiles(): Promise<Array<{ email: string; hasCredentials: boolean }>> {
    const profilesDir = getProfilesDir();

    try {
      const entries = await readdir(profilesDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          email: entry.name,
          hasCredentials: true,
        }))
        .map(async (profile) => {
          try {
            await readFile(getCredentialsPath(profile.email), 'utf8');
            return profile;
          } catch {
            return { ...profile, hasCredentials: false };
          }
        })
        .reduce<Promise<Array<{ email: string; hasCredentials: boolean }>>>(
          async (accPromise, profilePromise) => {
            const acc = await accPromise;
            acc.push(await profilePromise);
            return acc;
          },
          Promise.resolve([]),
        );
    } catch {
      return [];
    }
  }
}
