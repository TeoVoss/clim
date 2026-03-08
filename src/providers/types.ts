/**
 * Provider registration interface.
 *
 * Providers extend clim with optional capabilities (e.g. AI agent platforms).
 * Each provider can register CLI commands and daemon-side features.
 */

import type { Command } from 'commander';
import type { IpcServer } from '../ipc/server.js';
import type { MatrixSyncManager } from '../daemon/matrix-sync.js';
import type { StoredCredentials } from '../shared/profile.js';

export interface ProviderDaemonContext {
  matrixSync: MatrixSyncManager;
  ipc: IpcServer;
  credentials: StoredCredentials;
  localizeUrl: (url: string) => string;
}

export interface ProviderRegistration {
  /** Unique provider name (e.g. 'openclaw') */
  name: string;

  /** Register CLI commands (called during CLI setup) */
  registerCommands?: (program: Command) => void;

  /** Initialize daemon-side features (called during daemon startup) */
  initDaemon?: (context: ProviderDaemonContext) => Promise<void>;

  /** Cleanup on daemon shutdown */
  shutdownDaemon?: () => Promise<void>;

  /** Check if provider is available for this user's credentials */
  isAvailable?: (credentials: StoredCredentials) => boolean;
}
