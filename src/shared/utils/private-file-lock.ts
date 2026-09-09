import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensurePrivateDirectory,
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
  type PrivateFileState,
} from './private-file.js';

const LOCK_MODE = 0o600;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface LockHolder {
  pid: number;
  token: string;
}

interface AcquiredPrivateFileLock {
  state: Extract<PrivateFileState, { exists: true }>;
  content: string;
}

function waitForLock(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseLockHolder(content: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null
      || typeof parsed !== 'object'
      || !Number.isSafeInteger((parsed as Record<string, unknown>).pid)
      || typeof (parsed as Record<string, unknown>).token !== 'string') {
      return undefined;
    }
    return parsed as LockHolder;
  } catch {
    return undefined;
  }
}

function sameState(
  left: Extract<PrivateFileState, { exists: true }>,
  right: Extract<PrivateFileState, { exists: true }>,
): boolean {
  return left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.contentSha256 === right.contentSha256;
}

function removeLockIfUnchanged(
  lockPath: string,
  expected: AcquiredPrivateFileLock,
): boolean {
  for (let verification = 0; verification < 2; verification += 1) {
    const current = readPrivateFileState(lockPath);
    if (!current.state.exists
      || !('content' in current)
      || !sameState(expected.state, current.state)
      || current.content.toString('utf-8') !== expected.content) {
      return false;
    }
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function recoverDeadHolder(lockPath: string): void {
  const current = readPrivateFileState(lockPath);
  if (!current.state.exists) {
    return;
  }
  if (!('content' in current)) {
    throw new Error(`Private file lock content is missing: ${lockPath}`);
  }
  const content = current.content.toString('utf-8');
  const holder = parseLockHolder(content);
  if (holder === undefined || isProcessAlive(holder.pid)) {
    return;
  }
  removeLockIfUnchanged(lockPath, { state: current.state, content });
}

function acquirePrivateFileLock(lockPath: string): AcquiredPrivateFileLock {
  ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const holder: LockHolder = { pid: process.pid, token: randomUUID() };
    const content = JSON.stringify(holder);
    try {
      writeNewPrivateFileWithMode(lockPath, content, LOCK_MODE);
      const acquired = readPrivateFileState(lockPath);
      if (!acquired.state.exists
        || !('content' in acquired)
        || acquired.content.toString('utf-8') !== content) {
        throw new Error(`Private file lock identity changed after acquisition: ${lockPath}`);
      }
      return { state: acquired.state, content };
    } catch (error) {
      if (!(error instanceof PrivateArtifactPublicationConflictError)
        && !String(error).includes('already exists')) {
        throw error;
      }
    }
    recoverDeadHolder(lockPath);
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for private file lock: ${lockPath}`);
    }
    waitForLock();
  }
}

export function runPrivateFileExclusive<Result>(
  lockPath: string,
  action: () => Result,
): Result {
  const acquired = acquirePrivateFileLock(lockPath);
  let result!: Result;
  let actionError: unknown;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  let releaseError: unknown;
  try {
    if (!removeLockIfUnchanged(lockPath, acquired)) {
      throw new Error(`Private file lock ownership changed before release: ${lockPath}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (actionError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [actionError, releaseError],
      `Private file action and lock release both failed: ${lockPath}`,
    );
  }
  if (actionError !== undefined) {
    throw actionError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result;
}
