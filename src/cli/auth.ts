import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';
import { Command } from 'commander';
import {
  ProvisioningClient,
  ProvisioningError,
  isNetworkError,
} from '../client/provisioning.js';
import { loadConfig } from '../shared/config.js';
import { EXIT_CODES } from '../shared/constants.js';
import { printData, printError, printInfo, printJson, printSuccess } from '../shared/output.js';
import { ProfileManager, type StoredCredentials } from '../shared/profile.js';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function fail(code: number): never {
  process.exit(code);
}

function handleAuthError(error: unknown, provisioningUrl: string): never {
  if (isNetworkError(error)) {
    printError(`Cannot reach Provisioning at ${provisioningUrl}. Check network.`);
    fail(EXIT_CODES.NETWORK_ERROR);
  }

  if (error instanceof ProvisioningError) {
    if (error.statusCode === 401 || error.statusCode === 404) {
      printError('Login failed: invalid email or password');
      fail(EXIT_CODES.AUTH_FAILED);
    }

    if (error.statusCode === 409) {
      printError("Signup failed: email already registered. Run 'clim login' instead.");
      fail(EXIT_CODES.AUTH_FAILED);
    }

    if (error.statusCode === 400) {
      printError(`Request rejected by Provisioning: ${error.message}`);
      fail(EXIT_CODES.INVALID_ARGS);
    }

    printError(error.message);
    fail(EXIT_CODES.ERROR);
  }

  printError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  fail(EXIT_CODES.ERROR);
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Log in to your clim account')
    .option('--email <email>', 'Email address')
    .option('--password <password>', 'Password')
    .option('--feishu', 'Log in via Feishu OAuth')
    .option('--json', 'JSON output')
    .action(async (opts: { email?: string; password?: string; feishu?: boolean; json?: boolean }) => {
      if (opts.feishu) {
        await handleFeishuLogin(opts.json);
      } else if (opts.email && opts.password) {
        await handleEmailLogin(opts.email, opts.password, opts.json);
      } else {
        printError('Usage: clim login --email <email> --password <pw>  OR  clim login --feishu');
        fail(EXIT_CODES.INVALID_ARGS);
      }
    });

  program
    .command('signup')
    .description('Create a new clim account')
    .requiredOption('--email <email>', 'Email address')
    .requiredOption('--password <password>', 'Password')
    .option('--json', 'JSON output')
    .action(async (opts: { email: string; password: string; json?: boolean }) => {
      if (!isValidEmail(opts.email)) {
        printError('Invalid email format');
        fail(EXIT_CODES.INVALID_ARGS);
      }

      if (opts.password.length < 6) {
        printError('Password must be at least 6 characters');
        fail(EXIT_CODES.INVALID_ARGS);
      }

      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);
      const profileManager = new ProfileManager();

      try {
        const auth = await client.signup(opts.email, opts.password);
        const bootstrap = await client.bootstrap(auth.accessToken);

        const stored: StoredCredentials = {
          email: auth.user.email,
          userId: auth.user.id,
          displayName: auth.user.displayName,
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
          matrixCredentials: bootstrap.matrixCredentials,
          gatewayUrl: bootstrap.gatewayUrl,
          gatewayToken: bootstrap.gatewayToken,
          nodeDeviceKeyPem: bootstrap.nodeDeviceKeyPem,
          cliNodeDeviceKeyPem: bootstrap.cliNodeDeviceKeyPem,
        };

        await profileManager.saveCredentials(auth.user.email, stored);

        printSuccess(`Signed up and logged in as ${auth.user.email}`);
        if (opts.json) {
          printJson({
            ok: true,
            email: auth.user.email,
            userId: auth.user.id,
            displayName: auth.user.displayName,
          });
        }
      } catch (error) {
        handleAuthError(error, config.provisioningUrl);
      }
    });

  program
    .command('logout')
    .description('Log out from current account')
    .option('--purge', 'Remove all local data for this account')
    .option('--json', 'JSON output')
    .action(async (opts: { purge?: boolean; json?: boolean }) => {
      const profileManager = new ProfileManager();
      const email = await profileManager.getCurrentEmail();

      if (!email) {
        printError('Not logged in');
        fail(EXIT_CODES.AUTH_FAILED);
      }

      if (opts.purge) {
        await profileManager.purgeProfile(email);
        printSuccess(`Logged out and purged profile ${email}`);
      } else {
        await profileManager.deleteCredentials(email);
        printSuccess(`Logged out ${email}`);
      }

      if (opts.json) {
        printJson({ ok: true, email, purged: !!opts.purge });
      }
    });

  program
    .command('whoami')
    .description('Show current identity')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const profileManager = new ProfileManager();

      try {
        const credentials = await profileManager.loadCredentials();
        if (opts.json) {
          printJson(credentials);
          return;
        }

        printData(
          `${credentials.email} (userId: ${credentials.userId}, matrix: ${credentials.matrixCredentials.userId})`,
        );
      } catch {
        printError('Not logged in');
        fail(EXIT_CODES.AUTH_FAILED);
      }
    });
}

// --- Email/password login (extracted from inline action) ---

async function handleEmailLogin(email: string, password: string, json?: boolean): Promise<void> {
  const config = await loadConfig();
  const client = new ProvisioningClient(config.provisioningUrl);
  const profileManager = new ProfileManager();

  try {
    const auth = await client.login(email, password);
    const bootstrap = await client.bootstrap(auth.accessToken);

    const stored: StoredCredentials = {
      email: auth.user.email,
      userId: auth.user.id,
      displayName: auth.user.displayName,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      matrixCredentials: bootstrap.matrixCredentials,
      gatewayUrl: bootstrap.gatewayUrl,
      gatewayToken: bootstrap.gatewayToken,
      nodeDeviceKeyPem: bootstrap.nodeDeviceKeyPem,
      cliNodeDeviceKeyPem: bootstrap.cliNodeDeviceKeyPem,
    };

    await profileManager.saveCredentials(auth.user.email, stored);

    printSuccess(`Logged in as ${auth.user.email}`);
    if (json) {
      printJson({
        ok: true,
        email: auth.user.email,
        userId: auth.user.id,
        displayName: auth.user.displayName,
      });
    }
  } catch (error) {
    handleAuthError(error, config.provisioningUrl);
  }
}

// --- Feishu OAuth login ---

const FEISHU_LOGIN_TIMEOUT = 60_000; // 60 seconds

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to get port')));
      }
    });
    srv.on('error', reject);
  });
}

interface FeishuAuthResult {
  user: { id: string; email?: string; displayName?: string; avatarUrl?: string };
  accessToken: string;
  refreshToken: string;
}

async function handleFeishuLogin(json?: boolean): Promise<void> {
  const config = await loadConfig();

  // Resolve Feishu App ID: config > env var
  const feishuAppId = config.feishuAppId || process.env.FEISHU_APP_ID || '';
  if (!feishuAppId) {
    printError('Feishu App ID not configured. Set via: clim config set feishuAppId YOUR_APP_ID');
    fail(EXIT_CODES.INVALID_ARGS);
  }

  const port = await findFreePort();
  const nonce = randomBytes(16).toString('hex');

  // Build Feishu authorize URL
  const redirectUri = `${config.provisioningUrl}/v1/auth/feishu/callback/cli`;
  const state = JSON.stringify({ port, nonce });
  const authorizeUrl =
    `https://open.feishu.cn/open-apis/authen/v1/authorize` +
    `?app_id=${feishuAppId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  // Start localhost callback server and wait for auth result
  const authResult = await waitForFeishuCallback(port, authorizeUrl);

  // Exchange for bootstrap credentials
  const client = new ProvisioningClient(config.provisioningUrl);
  const profileManager = new ProfileManager();

  try {
    const bootstrap = await client.bootstrap(authResult.accessToken);
    const profileKey = authResult.user.email || `feishu:${authResult.user.id}`;

    const stored: StoredCredentials = {
      email: profileKey,
      userId: authResult.user.id,
      displayName: authResult.user.displayName ?? profileKey,
      accessToken: authResult.accessToken,
      refreshToken: authResult.refreshToken,
      matrixCredentials: bootstrap.matrixCredentials,
      gatewayUrl: bootstrap.gatewayUrl,
      gatewayToken: bootstrap.gatewayToken,
      nodeDeviceKeyPem: bootstrap.nodeDeviceKeyPem,
      cliNodeDeviceKeyPem: bootstrap.cliNodeDeviceKeyPem,
    };

    await profileManager.saveCredentials(profileKey, stored);

    printSuccess(`Logged in as ${profileKey} via Feishu`);
    if (json) {
      printJson({
        ok: true,
        email: profileKey,
        userId: authResult.user.id,
        displayName: authResult.user.displayName,
        method: 'feishu',
      });
    }
  } catch (error) {
    handleAuthError(error, config.provisioningUrl);
  }
}

function waitForFeishuCallback(port: number, authorizeUrl: string): Promise<FeishuAuthResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: Server;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        server?.close();
        reject(new Error('Feishu login timed out (60s). Try again.'));
      }
    }, FEISHU_LOGIN_TIMEOUT);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const data = url.searchParams.get('data');
      if (!data) {
        res.writeHead(400);
        res.end('Missing data');
        return;
      }

      try {
        const decoded = JSON.parse(
          Buffer.from(data, 'base64url').toString('utf8'),
        ) as FeishuAuthResult;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Login successful. You can close this tab.</p></body></html>');

        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          resolve(decoded);
        }
      } catch {
        res.writeHead(400);
        res.end('Invalid data');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      printInfo('Opening browser for Feishu login... Waiting for callback...');
      openBrowser(authorizeUrl);
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}
