import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, removeDaemonOwner } from '../../infra/daemon/owner.js';
import { packageVersion } from '../../shared/package-info.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { createLogger } from '../../shared/utils/debug.js';
import { ensurePrivateDirectory } from '../../infra/daemon/privateFile.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { isConversationIpcReady } from './conversationReadiness.js';

const PROCESS_WAIT_MS = 5_000;
// 子の終了猶予（5秒）に加え、強制終了・保存・watcher/IPC の後片付けを待つ。
const STOP_WAIT_MS = 30_000;
const PROCESS_POLL_MS = 50;
const log = createLogger('daemon');
const io = () => ({ signal: new AbortController().signal, timeoutMs: PROCESS_WAIT_MS });
export const daemonEntryPath = (): string => fileURLToPath(new URL('../../app/daemon/index.js', import.meta.url));

export async function stopDaemon(): Promise<void> {
  const directory = resolve(getGlobalConfigDir());
  const owner = await readDaemonOwner(directory);
  if (owner === undefined) return;
  if (await isDaemonOwnerRunning(owner, io())) {
    try { process.kill(owner.pid, 'SIGTERM'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    const deadline = Date.now() + STOP_WAIT_MS;
    while (await isDaemonOwnerRunning(owner, io())) {
      if (Date.now() >= deadline) throw new Error(`Daemon did not stop (PID ${owner.pid})`);
      await delay(PROCESS_POLL_MS);
    }
  }
  await removeDaemonOwner(directory, owner, io());
  log.info('Daemon exit confirmed', { pid: owner.pid });
}

export async function ensureDaemon(): Promise<void> {
  const directory = await resolveDaemonConfigDirectory(getGlobalConfigDir());
  const cliPath = daemonEntryPath();
  const args = [cliPath];
  const owner = await readDaemonOwner(directory);
  if (owner !== undefined && await isDaemonOwnerRunning(owner, io())) {
    if (owner.version === packageVersion && owner.cliPath === cliPath) {
      const deadline = Date.now() + PROCESS_WAIT_MS;
      while (Date.now() < deadline) {
        if (!await isDaemonOwnerRunning(owner, io())) {
          await removeDaemonOwner(directory, owner, io());
          break;
        }
        if (await isConversationIpcReady(directory, owner)) return;
        await delay(PROCESS_POLL_MS);
      }
      if (await isDaemonOwnerRunning(owner, io())) throw new Error('Daemon IPC readiness was not confirmed');
    } else {
      await stopDaemon();
    }
  }
  const logs = join(directory, 'logs');
  await ensurePrivateDirectory(logs);
  const descriptor = await open(join(logs, `daemon-start-${randomUUID()}.log`), 'wx', 0o600);
  try {
    const env = buildChildProcessEnv();
    env.TAKT_CONFIG_DIR = directory;
    const child = spawn(process.execPath, args, {
      cwd: directory, detached: true, shell: false, stdio: ['ignore', descriptor.fd, descriptor.fd], env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    const deadline = Date.now() + PROCESS_WAIT_MS;
    while (Date.now() < deadline) {
      const started = await readDaemonOwner(directory);
      // A concurrent caller may have started the same daemon first; the child then exits as the loser.
      if (started !== undefined && await isDaemonOwnerRunning(started, io())
        && (started.pid === child.pid || (started.version === packageVersion && started.cliPath === cliPath))) {
        if (await isConversationIpcReady(directory, started)) {
          log.info('Daemon startup confirmed', { pid: started.pid });
          return;
        }
      } else if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      await delay(PROCESS_POLL_MS);
    }
    throw new Error('Daemon startup was not confirmed; see the global logs directory');
  } finally {
    await descriptor.close();
  }
}

/** 手動起動も daemon 専用入口に入り、端末・シグナル・終了状態を引き継ぐ。 */
export async function runDaemonForeground(): Promise<void> {
  const child = spawn(process.execPath, [daemonEntryPath()], { stdio: 'inherit', shell: false, env: buildChildProcessEnv() });
  const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
  const interrupt = (): void => forward('SIGINT');
  const terminate = (): void => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    process.exitCode = code;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
