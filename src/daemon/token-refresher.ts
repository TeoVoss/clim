import { readFile, writeFile } from 'node:fs/promises';
import { ProvisioningClient } from '../client/provisioning.js';

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 300_000] as const;

type TimerHandle = ReturnType<typeof setTimeout>;

export class TokenRefresher {
  private currentAccessToken = '';
  private currentRefreshToken = '';
  private refreshTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private retryAttempt = 0;
  private stopped = false;

  constructor(private options: {
    provisioningUrl: string;
    credentialsPath: string;
    onTokenRefreshed: (newAccessToken: string) => Promise<void>;
  }) {}

  start(currentAccessToken: string, currentRefreshToken: string): void {
    this.stopped = false;
    this.clearTimers();

    this.currentAccessToken = currentAccessToken;
    this.currentRefreshToken = currentRefreshToken;
    this.retryAttempt = 0;

    const expMs = this.parseJwtExpMillis(currentAccessToken);
    if (!expMs) {
      console.error('[TokenRefresher] refresh failed: invalid access token payload');
      this.scheduleRetry();
      return;
    }

    const refreshAtMs = expMs - REFRESH_SKEW_MS;
    const now = Date.now();

    if (now >= refreshAtMs) {
      void this.refresh();
      return;
    }

    const delayMs = refreshAtMs - now;
    const minutes = Math.floor(delayMs / 60_000);
    const seconds = Math.floor((delayMs % 60_000) / 1000);
    console.log(`[TokenRefresher] scheduled refresh in ${minutes}m ${seconds}s`);

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private parseJwtExpMillis(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length < 2) {
        return null;
      }

      const payloadJson = this.decodeBase64Url(parts[1]);
      const payload = JSON.parse(payloadJson) as { exp?: unknown };
      if (typeof payload.exp !== 'number') {
        return null;
      }

      return payload.exp * 1000;
    } catch {
      return null;
    }
  }

  private decodeBase64Url(input: string): string {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const paddingNeeded = normalized.length % 4;
    const padded = paddingNeeded === 0
      ? normalized
      : normalized + '='.repeat(4 - paddingNeeded);

    return Buffer.from(padded, 'base64').toString('utf8');
  }

  private async refresh(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      const client = new ProvisioningClient(this.options.provisioningUrl);
      const { accessToken, refreshToken } = await client.refresh(this.currentRefreshToken);

      this.currentAccessToken = accessToken;
      this.currentRefreshToken = refreshToken;

      const credentialsRaw = await readFile(this.options.credentialsPath, 'utf-8');
      const credentials = JSON.parse(credentialsRaw) as {
        accessToken?: string;
        refreshToken?: string;
      } & Record<string, unknown>;

      const updatedCredentials = {
        ...credentials,
        accessToken,
        refreshToken,
      };

      await writeFile(this.options.credentialsPath, JSON.stringify(updatedCredentials, null, 2), 'utf-8');

      await this.options.onTokenRefreshed(accessToken);

      this.retryAttempt = 0;
      console.log('[TokenRefresher] token refreshed successfully');
      this.start(accessToken, refreshToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TokenRefresher] refresh failed: ${message}`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }

    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      return;
    }

    const delay = RETRY_DELAYS_MS[this.retryAttempt];
    this.retryAttempt += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
  }
}
