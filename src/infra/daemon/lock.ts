import { open, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AsyncLock, IoOptions } from '../../core/daemon/io.js';
import { ensurePrivateDirectory, hasCode, readPrivateFile } from './privateFile.js';
import { ioScope } from './io.js';
import { observeProcess, readProcessOwner } from './process.js';

const RETRY_MS = 25;
const STALE_MS = 30_000;

async function removeUnchanged(path: string, content: Buffer): Promise<boolean> {
  const current = await readPrivateFile(path, 16 * 1024);
  if (current === undefined || !content.equals(current)) return false;
  await unlink(path);
  return true;
}

async function recover(path: string, options: IoOptions): Promise<void> {
  const content = await readPrivateFile(path, 16 * 1024);
  if (content === undefined) return;
  let owner: unknown;
  try { owner = JSON.parse(content.toString('utf8')) as unknown; } catch { owner = undefined; }
  if (owner !== null && typeof owner === 'object' && 'pid' in owner && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
    const value = owner as { pid: number; startTime?: string; processIdentity?: { startTime: string } };
    const startTime = value.startTime ?? value.processIdentity?.startTime;
    if (typeof startTime === 'string') {
      const observed = await observeProcess({ pid: value.pid, startTime }, options);
      if (observed.kind !== 'dead') return;
    } else {
      try { process.kill(value.pid, 0); return; } catch (error) { if (!hasCode(error, 'ESRCH')) return; }
    }
  } else {
    const metadata = await stat(path).catch((error: unknown) => { if (hasCode(error, 'ENOENT')) return undefined; throw error; });
    if (metadata === undefined || Date.now() - metadata.mtimeMs <= STALE_MS) return;
  }
  // ローカルの協調ロック。再確認と削除の間の競合は許容する。
  try { await removeUnchanged(path, content); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}

export class FileAsyncLock implements AsyncLock {
  async exclusive<T>(path: string, action: () => Promise<T>, options: IoOptions): Promise<T> {
    const scope = ioScope(options);
    const absolute = resolve(path);
    let content: Buffer | undefined;
    try {
      await ensurePrivateDirectory(dirname(absolute));
      const owner = await readProcessOwner(process.pid, { signal: scope.signal, timeoutMs: options.timeoutMs });
      content = Buffer.from(JSON.stringify({ pid: process.pid, startTime: owner?.startTime, token: randomUUID() }));
      while (true) {
        scope.signal.throwIfAborted();
        const file = await open(absolute, 'wx', 0o600).catch((error: unknown) => {
          if (hasCode(error, 'EEXIST')) return undefined;
          throw error;
        });
        if (file !== undefined) {
          const failures: unknown[] = [];
          try { await file.chmod(0o600); await file.writeFile(content); } catch (error) { failures.push(error); }
          try { await file.close(); } catch (error) { failures.push(error); }
          if (failures.length > 0) {
            try { await unlink(absolute); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            throw new AggregateError(failures, 'Lock acquisition and cleanup failed');
          }
          break;
        }
        await recover(absolute, { signal: scope.signal, timeoutMs: options.timeoutMs });
        try { await delay(RETRY_MS, undefined, { signal: scope.signal }); } catch (error) {
          scope.signal.throwIfAborted();
          throw error;
        }
      }
      let value!: T;
      let failure: unknown;
      let failed = false;
      try { scope.signal.throwIfAborted(); value = await action(); scope.signal.throwIfAborted(); } catch (error) { failed = true; failure = error; }
      try {
        if (!await removeUnchanged(absolute, content)) throw new Error(`Lock ownership changed: ${absolute}`);
      } catch (error) {
        if (failed) throw new AggregateError([failure, error], 'Lock action and release failed');
        throw error;
      }
      if (failed) throw failure;
      return value;
    } finally { scope.close(); }
  }
}
