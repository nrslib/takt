import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, removeDaemonOwner } from '../../infra/daemon/owner.js';
import { packageVersion } from '../../shared/package-info.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { resolveCliInvocation } from '../../shared/utils/cli-invocation.js';
import { createLogger } from '../../shared/utils/debug.js';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';

const PROCESS_WAIT_MS = 5_000;
const PROCESS_POLL_MS = 50;
const log = createLogger('daemon');

export async function stopDaemon(): Promise<void> {
  const directory = resolve(getGlobalConfigDir());
  const owner = readDaemonOwner(directory);
  if (owner === undefined) return;
  if (isDaemonOwnerRunning(owner)) {
    try { process.kill(owner.pid, 'SIGTERM'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    const deadline = Date.now() + PROCESS_WAIT_MS;
    while (isDaemonOwnerRunning(owner)) {
      if (Date.now() >= deadline) throw new Error(`Daemon did not stop (PID ${owner.pid})`);
      await delay(PROCESS_POLL_MS);
    }
  }
  removeDaemonOwner(directory);
  log.info('Daemon exit confirmed', { pid: owner.pid });
}

export async function ensureDaemon(): Promise<void> {
  const directory = resolve(getGlobalConfigDir());
  const { cliPath, args } = resolveCliInvocation('daemon');
  const owner = readDaemonOwner(directory);
  if (owner !== undefined && isDaemonOwnerRunning(owner)) {
    if (owner.version === packageVersion && owner.cliPath === cliPath) return;
    await stopDaemon();
  }
  const logs = join(directory, 'logs');
  ensurePrivateDirectory(logs);
  const descriptor = openSync(join(logs, `daemon-start-${randomUUID()}.log`), 'wx', 0o600);
  try {
    const env = buildChildProcessEnv();
    env.TAKT_CONFIG_DIR = directory;
    const child = spawn(process.execPath, args, {
      cwd: directory, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor], env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    const deadline = Date.now() + PROCESS_WAIT_MS;
    while (Date.now() < deadline) {
      const started = readDaemonOwner(directory);
      if (started !== undefined && started.pid === child.pid && isDaemonOwnerRunning(started)) {
        log.info('Daemon startup confirmed', { pid: started.pid });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(PROCESS_POLL_MS);
    }
    throw new Error('Daemon startup was not confirmed; see the global logs directory');
  } finally {
    closeSync(descriptor);
  }
}
