export const VERSION = '0.6.0';

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  INVALID_ARGS: 2,
  AUTH_FAILED: 3,
  NETWORK_ERROR: 4,
  TIMEOUT: 5,
  NOT_FOUND: 6,
} as const;

export const CLIM_DIR = '.clim';
export const PROFILES_DIR = 'profiles';
export const CREDENTIALS_FILE = 'credentials.json';
export const CURRENT_PROFILE_FILE = 'current-profile';
export const DAEMON_PID_FILE = 'daemon.pid';
export const DAEMON_SOCK_FILE = 'daemon.sock';
export const SYNC_STATE_DB = 'sync-state.db';
export const CONFIG_FILE = 'config.json';
