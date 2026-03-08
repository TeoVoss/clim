import { fork } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { kill } from 'node:process';
import { join } from 'node:path';
import { DAEMON_PID_FILE } from '../shared/constants.js';
import { IpcClient } from '../ipc/client.js';
import { getDaemonSockPath } from '../shared/profile.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DaemonManager {
  constructor(private profileDir: string) {}

  private get pidPath(): string {
    return join(this.profileDir, DAEMON_PID_FILE);
  }

  private get sockPath(): string {
    return getDaemonSockPath(this.profileDir);
  }

  async isRunning(): Promise<boolean> {
    const pid = await this.getPid();
    if (!pid) {
      return false;
    }

    if (isAlive(pid)) {
      return true;
    }

    await unlink(this.pidPath).catch(() => undefined);
    return false;
  }

  async start(daemonScript: string): Promise<number> {
    const existingPid = await this.getPid();
    if (existingPid && isAlive(existingPid)) {
      return existingPid;
    }

    if (existingPid) {
      await unlink(this.pidPath).catch(() => undefined);
    }

    const child = fork(daemonScript, ['--profile-dir', this.profileDir], {
      detached: true,
      stdio: 'ignore',
      execPath: process.execPath,
    });

    child.unref();
    if (child.connected) {
      child.disconnect();
    }

    if (!child.pid) {
      throw new Error('Failed to start daemon process');
    }

    await writeFile(this.pidPath, `${child.pid}\n`, 'utf8');

    const maxAttempts = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!child.pid || !isAlive(child.pid)) {
        throw new Error('Daemon process exited before IPC server became ready');
      }

      const client = new IpcClient();
      try {
        await client.connect(this.sockPath, 200);
        await client.call('ping', {}, 1000);
        await client.close();
        return child.pid;
      } catch {
        await client.close().catch(() => undefined);
        await sleep(100);
      }
    }

    throw new Error('Timed out waiting for daemon IPC socket');
  }

  async stop(timeout = 5000): Promise<void> {
    const pid = await this.getPid();
    if (!pid) {
      await unlink(this.sockPath).catch(() => undefined);
      return;
    }

    if (isAlive(pid)) {
      kill(pid, 'SIGTERM');

      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!isAlive(pid)) {
          break;
        }

        await sleep(100);
      }

      if (isAlive(pid)) {
        kill(pid, 'SIGKILL');

        const forceDeadline = Date.now() + 2000;
        while (Date.now() < forceDeadline) {
          if (!isAlive(pid)) {
            break;
          }
          await sleep(50);
        }
      }
    }

    await unlink(this.pidPath).catch(() => undefined);
    await unlink(this.sockPath).catch(() => undefined);
  }

  async getPid(): Promise<number | null> {
    try {
      const content = await readFile(this.pidPath, 'utf8');
      const pid = Number.parseInt(content.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<{ running: boolean; pid: number | null; sockExists: boolean }> {
    const pid = await this.getPid();
    const running = pid !== null ? isAlive(pid) : false;

    if (pid !== null && !running) {
      await unlink(this.pidPath).catch(() => undefined);
    }

    const sockExists = await access(this.sockPath)
      .then(() => true)
      .catch(() => false);

    return {
      running,
      pid: running ? pid : null,
      sockExists,
    };
  }
}
