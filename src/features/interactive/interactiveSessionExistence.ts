import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getClaudeProjectSessionsDir } from '../../infra/config/project/sessionStore.js';
import { acquireOpenCodeClient, type AcquiredOpenCodeClient } from '../../infra/opencode/server-pool.js';
import { kiroSessionExists } from '../../infra/kiro/sessionExistence.js';

const SESSION_EXISTS_TIMEOUT_MS = 10_000;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isMissingOpenCodeSession(error: unknown, sessionId: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('name' in error && error.name === 'NotFoundError') return true;
  return '_tag' in error && error._tag === 'SessionNotFoundError'
    && 'sessionID' in error && error.sessionID === sessionId;
}

function fileExists(path: string): boolean | undefined {
  try { return statSync(path).isFile(); }
  catch (error) { return isMissing(error) ? false : undefined; }
}

function findCodexRollout(directory: string, sessionId: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && findCodexRollout(join(directory, entry.name), sessionId)) return true;
    const match = entry.name.match(/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (entry.isFile() && match?.[1] === sessionId) return true;
  }
  return false;
}

function acquireOpenCodeClientUntilAborted(signal: AbortSignal): Promise<AcquiredOpenCodeClient> {
  const acquisition = acquireOpenCodeClient(undefined, undefined, undefined, signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('OpenCode session existence check timed out'));
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    void acquisition.then(
      (acquired) => {
        if (settled || signal.aborted) {
          acquired.release();
          onAbort();
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(acquired);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function interactiveSessionExists(cwd: string, provider: string, sessionId: string): Promise<boolean | undefined> {
  if (basename(sessionId) !== sessionId || !sessionId) return false;
  if (provider === 'claude' || provider === 'claude-sdk' || provider === 'claude-headless' || provider === 'claude-terminal') {
    return fileExists(join(getClaudeProjectSessionsDir(cwd), `${sessionId}.jsonl`));
  }
  if (provider === 'codex') {
    try { return findCodexRollout(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'), sessionId); }
    catch (error) { return isMissing(error) ? false : undefined; }
  }
  if (provider === 'opencode') {
    const timeoutSignal = AbortSignal.timeout(SESSION_EXISTS_TIMEOUT_MS);
    try {
      const { client, release, invalidationSignal } = await acquireOpenCodeClientUntilAborted(timeoutSignal);
      try {
        const signal = AbortSignal.any([invalidationSignal, timeoutSignal]);
        const result = await client.session.get({ sessionID: sessionId, directory: cwd }, { signal });
        if (result.data !== undefined) return true;
        const error = result.error;
        return isMissingOpenCodeSession(error, sessionId) ? false : undefined;
      } finally { release(); }
    } catch (error) {
      return isMissingOpenCodeSession(error, sessionId) ? false : undefined;
    }
  }
  if (provider === 'kiro') return kiroSessionExists(cwd, sessionId);
  return undefined;
}
