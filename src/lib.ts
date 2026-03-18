/**
 * clim library entry point.
 *
 * Use this to embed clim's messaging capabilities into other applications
 * (e.g. as a plugin backend). Provides IPC client for daemon communication,
 * daemon lifecycle management, and profile/config utilities.
 */

// ─── IPC (daemon communication) ───
export { IpcClient } from './ipc/client.js';
export type { IpcRequest, IpcResponse, IpcNotification, IpcEventNotification, IpcMessage } from './ipc/protocol.js';

// ─── Daemon lifecycle ───
export { DaemonManager } from './daemon/lifecycle.js';

// ─── Profile & config ───
export {
  ProfileManager,
  getDaemonSockPath,
  getClimDir,
  getProfilesDir,
  getProfileDir,
  getCurrentProfilePath,
  type StoredCredentials,
} from './shared/profile.js';
export { loadConfig, saveConfig, type ClimConfig } from './shared/config.js';

// ─── Daemon connection helper ───
export { ensureDaemonAndConnect, requireProfileDir } from './shared/daemon-connection.js';

// ─── Events & types ───
export {
  type StructuredEvent,
  type EventType,
  type MessageTextPayload,
  type MessageFilePayload,
  type DraftPayload,
  type NodeStatusPayload,
  type ClimEventMeta,
  type MessageIntent,
  type MessageSource,
  type MessageProvenance,
  createEvent,
  createMessageMeta,
  EVENT_VERSION,
  CLIM_EVENT_KEY,
  CLIM_EVENT_VERSION,
} from './shared/events.js';

// ─── Room & message types (from MatrixSyncManager) ───
export type { RoomInfo, RoomMember, MessageInfo, SearchMessageInfo } from './daemon/matrix-sync.js';

// ─── Constants ───
export { VERSION, EXIT_CODES, CLIM_DIR } from './shared/constants.js';
