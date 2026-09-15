import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
} from '../../shared/utils/private-file.js';

const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const OWNER_NAME = /^owner-([1-9]\d*)-[a-f0-9-]{36}$/u;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isPublicationContention(error: unknown, directory: string): boolean {
  if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY')) return true;
  if (!hasCode(error, 'EPERM') && !hasCode(error, 'EACCES')) return false;
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (statError) {
    if (hasCode(statError, 'ENOENT')) return false;
    throw statError;
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) {
      throw error;
    }
  }
}

function removeOwner(directory: string, ownerName: string): void {
  try {
    unlinkSync(join(directory, ownerName));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }
  // Every acquisition publishes a nonempty directory. A delayed remover can
  // remove only its unique owner file; rmdir cannot delete a new holder.
  removeEmptyDirectory(directory);
}

function recoverDeadOwner(directory: string): void {
  let names: string[];
  let directoryIdentity: { readonly dev: number; readonly ino: number };
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`TaskStore: unsafe lock guard directory: ${directory}`);
    }
    directoryIdentity = stat;
    names = readdirSync(directory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  for (const name of names) {
    const match = OWNER_NAME.exec(name);
    if (match === null) {
      throw new Error(`TaskStore: invalid lock guard owner: ${directory}`);
    }
    // Reject symlinks and unsafe ancestors before removing the owner entry.
    let snapshot;
    try {
      snapshot = readPrivateFileState(join(directory, name));
    } catch (error) {
      // Publication checks also reject a disappearing ancestor. The holder may
      // legitimately have released this guard between readdir and the read.
      try {
        const current = lstatSync(directory);
        if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) return;
      } catch (statError) {
        if (hasCode(statError, 'ENOENT')) return;
        throw statError;
      }
      throw error;
    }
    if (!snapshot.state.exists) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) {
      throw new Error(`TaskStore: invalid lock guard PID: ${directory}`);
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (hasCode(error, 'ESRCH')) removeOwner(directory, name);
    }
  }
  removeEmptyDirectory(directory);
}

/** Serialize legacy lock acquisition, recovery, and release across TaskStore processes. */
export function guardTaskStoreLock<Result>(lockPath: string, action: () => Result): Result {
  const directory = `${lockPath}.guard`;
  const staging = mkdtempSync(`${directory}.`);
  const ownerName = `owner-${process.pid}-${randomUUID()}`;
  let acquired = false;
  try {
    writeNewPrivateFileWithMode(join(staging, ownerName), '', 0o600);
    const deadline = Date.now() + TIMEOUT_MS;
    while (!acquired) {
      try {
        // The owner is present before publication, so no empty acquisition gap
        // permits a stale remover to delete a freshly acquired directory.
        renameSync(staging, directory);
        acquired = true;
      } catch (error) {
        if (!isPublicationContention(error, directory)) {
          throw error;
        }
        try {
          recoverDeadOwner(directory);
        } catch (recoveryError) {
          if (!(recoveryError instanceof PrivateArtifactPublicationConflictError) && !hasCode(recoveryError, 'ENOENT')) {
            throw recoveryError;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`TaskStore: timed out waiting for lock: ${lockPath}`);
        }
        Atomics.wait(waitBuffer, 0, 0, RETRY_MS);
      }
    }
    return action();
  } finally {
    removeOwner(acquired ? directory : staging, ownerName);
  }
}
