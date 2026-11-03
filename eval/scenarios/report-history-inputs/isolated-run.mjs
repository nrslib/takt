import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publishEvaluation } from './public-artifacts.mjs';

export function createEvaluationEnvironment(sourceEnv) {
  const root = realpathSync(mkdtempSync('/tmp/takt-report-history-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const home = join(root, 'home');
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'tmp'), { mode: 0o700 });
    const authHome = sourceEnv.CODEX_HOME || join(sourceEnv.HOME || homedir(), '.codex');
    copyFileSync(join(authHome, 'auth.json'), join(codexHome, 'auth.json'));
    chmodSync(join(codexHome, 'auth.json'), 0o600);
    const env = {
      ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => sourceEnv[key] !== undefined).map(key => [key, sourceEnv[key]])),
      HOME: home, CODEX_HOME: codexHome, TMPDIR: join(root, 'tmp'), TAKT_CONFIG_DIR: join(home, '.takt'),
    };
    return { root, env, cleanup };
  } catch {
    cleanup();
    throw new Error('Unable to prepare isolated evaluation authentication');
  }
}

export async function runIsolatedEvaluation({ worker, args, destination, sourceEnv, signal }) {
  let isolated;
  try {
    isolated = createEvaluationEnvironment(sourceEnv);
    const { root, env } = isolated;
    const outcome = await new Promise(resolve => {
      const child = spawn(process.execPath, [worker, ...args], {
        cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const logs = [];
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => logs.push(chunk));
      const abort = () => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.on('error', () => { /* The close event owns publication and cleanup. */ });
      child.on('close', (code, exitSignal) => {
        signal.removeEventListener('abort', abort);
        writeFileSync(join(root, 'worker.log'), Buffer.concat(logs), { mode: 0o600 });
        resolve({ code, interrupted: signal.aborted || exitSignal !== null });
      });
    });
    return publishEvaluation(join(root, 'raw'), destination, {
      isolated: true, failed: outcome.code !== 0, interrupted: outcome.interrupted,
    });
  } catch {
    return publishEvaluation(undefined, destination, { isolated: false, failed: true, interrupted: signal.aborted });
  } finally {
    isolated?.cleanup();
  }
}
