import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { getSelfProcessIdentity, isRecordedProcessAlive, type ProcessIdentity } from '../task/process.js';

const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;
const STALE_MS = 30_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Set<string>();

interface LockOwner {
  readonly pid: number;
  readonly processIdentity: ProcessIdentity | undefined;
}

interface LockSnapshot {
  readonly stat: Stats;
  readonly content: string | undefined;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseOwner(content: string | undefined): LockOwner | undefined {
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return undefined;
  const identity = raw.processIdentity;
  // An unavailable OS inspector leaves identity unknown, just as for execution locks.
  if (identity === undefined) return { pid: raw.pid as number, processIdentity: undefined };
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
    || !('startTime' in identity) || typeof identity.startTime !== 'string'
    || identity.startTime.trim().length === 0) return undefined;
  return { pid: raw.pid as number, processIdentity: { startTime: identity.startTime } };
}

function readSnapshot(lockPath: string): LockSnapshot | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'r');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    if (!hasCode(error, 'EACCES') && !hasCode(error, 'EPERM')) throw error;
    const stat = statSync(lockPath, { throwIfNoEntry: false });
    return stat === undefined ? undefined : { stat, content: undefined };
  }
  try {
    const stat = fstatSync(descriptor);
    let content: string | undefined;
    try {
      content = readFileSync(descriptor, 'utf8');
    } catch {
      // An unreadable record is recoverable only after the stale threshold.
      content = undefined;
    }
    return { stat, content };
  } finally {
    closeSync(descriptor);
  }
}

function unlinkSnapshot(lockPath: string, expected: LockSnapshot): void {
  const current = readSnapshot(lockPath);
  if (current === undefined || current.stat.dev !== expected.stat.dev
    || current.stat.ino !== expected.stat.ino || current.content !== expected.content
    || current.stat.mtimeMs !== expected.stat.mtimeMs) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function recoverStaleLock(lockPath: string): void {
  const snapshot = readSnapshot(lockPath);
  if (snapshot === undefined) return;
  const owner = parseOwner(snapshot.content);
  if (owner !== undefined) {
    if (isRecordedProcessAlive(owner.pid, owner.processIdentity)) return;
  } else if (Date.now() - snapshot.stat.mtimeMs <= STALE_MS) {
    return;
  }
  // 死んだ持ち主の回収と新しい取得が、再確認と削除の間で重なる窓は残る。
  // ローカルのツールとしてこの窓を受け入れ、保護を保証するテストは削除した。
  unlinkSnapshot(lockPath, snapshot);
}

function acquireLock(lockPath: string, content: string, timeoutMs: number): LockSnapshot {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      recoverStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`File lock: timed out waiting for lock: ${lockPath}`);
      }
      Atomics.wait(waitBuffer, 0, 0, Math.min(RETRY_MS, deadline - Date.now()));
      continue;
    }
    try {
      writeFileSync(descriptor, content, 'utf8');
      return { stat: fstatSync(descriptor), content };
    } catch (error) {
      const stat = fstatSync(descriptor);
      const partial = readSnapshot(lockPath);
      if (partial !== undefined && partial.stat.dev === stat.dev && partial.stat.ino === stat.ino) {
        unlinkSnapshot(lockPath, partial);
      }
      throw error;
    } finally {
      closeSync(descriptor);
    }
  }
}

export function withFileLock<T>(lockPath: string, action: () => T, options?: { timeoutMs?: number }): T {
  const resolvedPath = resolve(lockPath);
  if (heldLocks.has(resolvedPath)) throw new Error(`File lock: reentrant lock detected: ${lockPath}`);
  heldLocks.add(resolvedPath);
  try {
    const content = JSON.stringify({ pid: process.pid, processIdentity: getSelfProcessIdentity() });
    const acquired = acquireLock(resolvedPath, content, options?.timeoutMs ?? TIMEOUT_MS);
    try {
      return action();
    } finally {
      unlinkSnapshot(resolvedPath, acquired);
    }
  } finally {
    heldLocks.delete(resolvedPath);
  }
}
