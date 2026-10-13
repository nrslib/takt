#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';

const LOCK_DIRECTORY_NAME = '.runtime-state-lock';
const CLEANUP_BARRIER_FILE = 'cleanup-blocked';
const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 10;
const CLEANUP_BLOCKED_MESSAGE =
  'DeepSeek Harness runtime cleanup is unconfirmed; no new runtime can start. Confirm that all previous DeepSeek runtimes, supervisors, and tool processes have exited, then manually remove .runtime-state-lock and cleanup-blocked from deepseek-harness/state/ under the TAKT config directory.';
export const DEEPSEEK_RUNTIME_BUSY_MESSAGE =
  'DeepSeek Harness managed runtime home is in use by another TAKT process; wait for that process to close its runtimes or use a separate TAKT config directory. Do not remove runtime state while those processes are alive.';

/** Return the fixed fail-closed diagnostic, including guarded manual recovery. */
function cleanupBlockedError() {
  return new Error(CLEANUP_BLOCKED_MESSAGE);
}

/** Probe a runtime group; treat permission denial as alive and uncertainty separately. */
function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return undefined;
  }
}

/** Probe supervisor liveness without attempting PID-based lock recovery. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return undefined;
  }
}

/** Validate that cleanup only targets TAKT-owned temporary directories and a state-owned receipt. */
export function validateDeepSeekRuntimeCleanup(stateDirectory, cleanupPaths, cleanupConfirmationPath, cleanupRoot) {
  if (!Array.isArray(cleanupPaths) || !cleanupPaths.every((path) => typeof path === 'string')) {
    throw cleanupBlockedError();
  }

  let normalizedCleanupRoot;
  if (cleanupRoot !== undefined) {
    normalizedCleanupRoot = resolve(cleanupRoot);
    if (normalizedCleanupRoot !== cleanupRoot || dirname(normalizedCleanupRoot) === normalizedCleanupRoot) {
      throw cleanupBlockedError();
    }
  }
  const normalizedPaths = cleanupPaths.map((path) => resolve(path));
  if (normalizedPaths.some((path, index) => path !== cleanupPaths[index]
    || normalizedCleanupRoot === undefined
    || dirname(path) !== normalizedCleanupRoot
    || !basename(path).startsWith('takt-deepseek-'))
    || new Set(normalizedPaths).size !== normalizedPaths.length
    || (cleanupPaths.length > 0 && normalizedCleanupRoot === undefined)
    || (cleanupPaths.length === 0 && normalizedCleanupRoot !== undefined)) {
    throw cleanupBlockedError();
  }

  if (cleanupConfirmationPath !== undefined) {
    const receiptPath = resolve(cleanupConfirmationPath);
    if (receiptPath !== cleanupConfirmationPath
      || dirname(receiptPath) !== resolve(stateDirectory, 'cleanup-receipts')
      || !basename(receiptPath).startsWith('takt-deepseek-')
      || !basename(receiptPath).endsWith('.confirmed')) {
      throw cleanupBlockedError();
    }
  } else if (cleanupPaths.length > 0) {
    throw cleanupBlockedError();
  }

  return { cleanupPaths: normalizedPaths, cleanupConfirmationPath, cleanupRoot: normalizedCleanupRoot };
}

/** Remove owned temporary resources and publish the receipt only after every removal succeeds. */
export async function cleanupDeepSeekRuntimeResources(
  stateDirectory,
  cleanupPaths,
  cleanupConfirmationPath,
  cleanupRoot,
) {
  const cleanup = validateDeepSeekRuntimeCleanup(stateDirectory, cleanupPaths, cleanupConfirmationPath, cleanupRoot);
  for (const path of cleanup.cleanupPaths) {
    await rm(path, { recursive: true, force: true });
  }
  if (cleanup.cleanupConfirmationPath === undefined) return;

  const receiptPath = cleanup.cleanupConfirmationPath;
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, 'confirmed\n', { mode: 0o600 });
  try {
    await rename(temporaryPath, receiptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** Require complete, validated cleanup metadata before acting on a durable runtime owner. */
function ownerCleanup(owner, stateDirectory) {
  const hasPaths = Object.hasOwn(owner, 'cleanupPaths');
  const hasReceipt = Object.hasOwn(owner, 'cleanupConfirmationPath');
  const hasRoot = Object.hasOwn(owner, 'cleanupRoot');
  if (!hasPaths && !hasReceipt && !hasRoot) return undefined;
  if (!hasPaths || !hasReceipt || !hasRoot || typeof owner.cleanupConfirmationPath !== 'string'
    || typeof owner.cleanupRoot !== 'string') {
    throw cleanupBlockedError();
  }
  return validateDeepSeekRuntimeCleanup(
    stateDirectory,
    owner.cleanupPaths,
    owner.cleanupConfirmationPath,
    owner.cleanupRoot,
  );
}

/** Atomically retain resource ownership after cleanup fails. */
async function persistCleanupFailure(ownerPath, owner) {
  const temporaryPath = `${ownerPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ ...owner, cleanupFailed: true })}\n`, { mode: 0o600 });
  try {
    await rename(temporaryPath, ownerPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** Persist failed cleanup or retain the state lock so uncertain resources cannot be reused. */
async function failClosedAfterCleanupError(lock, stateDirectory, ownerDirectory, ownerPath, owner) {
  try {
    await persistCleanupFailure(ownerPath, owner);
  } catch {
    // The durable process-group barrier below remains the fallback owner.
  }
  try {
    await markDeepSeekCleanupBarrierLocked(stateDirectory, ownerDirectory, owner.runtimePid);
  } catch {
    lock.retain();
  }
  throw cleanupBlockedError();
}

/** Validate durable cleanup evidence; malformed or unreadable barriers fail closed. */
async function readCleanupBarrier(stateDirectory) {
  const barrierPath = join(stateDirectory, CLEANUP_BARRIER_FILE);
  let content;
  try {
    content = await readFile(barrierPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw cleanupBlockedError();
  }
  try {
    const barrier = JSON.parse(content);
    const runtimePids = barrier?.runtimePids;
    const unknownRuntime = barrier?.unknownRuntime;
    if (unknownRuntime !== true && !Array.isArray(runtimePids)) {
      throw cleanupBlockedError();
    }
    if (!Array.isArray(runtimePids)
      || !runtimePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
      throw cleanupBlockedError();
    }
    return { path: barrierPath, runtimePids, unknownRuntime };
  } catch {
    throw cleanupBlockedError();
  }
}

/** Serialize runtime publication/cleanup across processes; never steal a stale lock. */
export async function withDeepSeekRuntimeStateFileLock(stateDirectory, operation) {
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw cleanupBlockedError();
  }

  const lockDirectory = join(stateDirectory, LOCK_DIRECTORY_NAME);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw cleanupBlockedError();
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }

  let retainLock = false;
  const lock = { retain: () => { retainLock = true; } };
  let operationFailed = false;
  let operationError;
  let result;
  try {
    try {
      await writeFile(join(lockDirectory, 'owner'), `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
    } catch {
      lock.retain();
      throw cleanupBlockedError();
    }
    result = await operation(lock);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  if (!retainLock) {
    try {
      await rm(lockDirectory, { recursive: true });
    } catch {
      throw cleanupBlockedError();
    }
  }
  if (operationFailed) throw operationError;
  return result;
}

/** Caller must hold `withDeepSeekRuntimeStateFileLock` for `stateDirectory`. */
export async function assertDeepSeekRuntimeCreationAllowedLocked(
  stateDirectory,
  ownerDirectory,
  parentPid,
  lock,
) {
  try {
    await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw cleanupBlockedError();
  }

  let ownerEntries;
  try {
    ownerEntries = await readdir(ownerDirectory);
  } catch {
    throw cleanupBlockedError();
  }

  const barrier = await readCleanupBarrier(stateDirectory);
  if (barrier !== undefined) {
    if (barrier.unknownRuntime === true) throw cleanupBlockedError();
    for (const pid of barrier.runtimePids) {
      if (isProcessGroupAlive(pid) !== false) throw cleanupBlockedError();
    }
    try {
      await rm(barrier.path, { force: true });
    } catch {
      throw cleanupBlockedError();
    }
  }

  for (const entry of ownerEntries) {
    const ownerPath = join(ownerDirectory, entry);
    let owner;
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (![owner?.parentPid, owner?.supervisorPid, owner?.runtimePid]
        .every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
        throw cleanupBlockedError();
      }
    } catch {
      throw cleanupBlockedError();
    }

    const groupAlive = isProcessGroupAlive(owner.runtimePid);
    if (groupAlive === false) {
      let cleanup;
      try {
        cleanup = ownerCleanup(owner, stateDirectory);
        if (cleanup !== undefined) {
          await cleanupDeepSeekRuntimeResources(
            stateDirectory,
            cleanup.cleanupPaths,
            cleanup.cleanupConfirmationPath,
            cleanup.cleanupRoot,
          );
          if (isProcessAlive(owner.parentPid) !== false) continue;
          await rm(owner.cleanupConfirmationPath, { force: true });
        }
        await rm(ownerPath, { force: true });
      } catch {
        await failClosedAfterCleanupError(lock, stateDirectory, ownerDirectory, ownerPath, owner);
      }
      continue;
    }
    if (owner.cleanupFailed === true) throw cleanupBlockedError();
    if (isProcessAlive(owner.supervisorPid) === true) {
      if (owner.parentPid === parentPid) continue;
      const error = new Error(DEEPSEEK_RUNTIME_BUSY_MESSAGE);
      error.code = 'DEEPSEEK_RUNTIME_BUSY';
      throw error;
    }
    throw cleanupBlockedError();
  }
}

/**
 * Acknowledge one completed runtime after its process group and resources are gone.
 * Returns true on confirmation, false for a live owned group, null for an unowned blocking barrier,
 * or undefined when no owner or receipt exists.
 */
export async function acknowledgeDeepSeekRuntimeCleanup(stateDirectory, ownerDirectory, cleanupConfirmationPath) {
  const cleanup = validateDeepSeekRuntimeCleanup(stateDirectory, [], cleanupConfirmationPath);
  return withDeepSeekRuntimeStateFileLock(stateDirectory, async (lock) => {
    const barrier = await readCleanupBarrier(stateDirectory);
    let barrierBlocksCleanup = false;
    let barrierConfirmsGroupExit = false;
    if (barrier !== undefined) {
      if (barrier.unknownRuntime === true
        || barrier.runtimePids.some((pid) => isProcessGroupAlive(pid) !== false)) {
        barrierBlocksCleanup = true;
      } else {
        barrierConfirmsGroupExit = barrier.runtimePids.length > 0;
        try {
          await rm(barrier.path, { force: true });
        } catch {
          throw cleanupBlockedError();
        }
      }
    }

    let matchingOwner;
    let matchingOwnerPath;
    let ownerEntries;
    try {
      await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
      ownerEntries = await readdir(ownerDirectory);
    } catch {
      throw cleanupBlockedError();
    }
    for (const entry of ownerEntries) {
      const ownerPath = join(ownerDirectory, entry);
      let owner;
      try {
        owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (![owner?.parentPid, owner?.supervisorPid, owner?.runtimePid]
          .every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
          throw cleanupBlockedError();
        }
      } catch {
        throw cleanupBlockedError();
      }
      if (owner.cleanupConfirmationPath !== cleanup.cleanupConfirmationPath) continue;
      if (matchingOwner !== undefined) throw cleanupBlockedError();
      matchingOwner = owner;
      matchingOwnerPath = ownerPath;
    }

    if (matchingOwner === undefined || matchingOwnerPath === undefined) {
      let receipt;
      try {
        receipt = await readFile(cleanup.cleanupConfirmationPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          if (barrierBlocksCleanup) return null;
          return barrierConfirmsGroupExit ? true : undefined;
        }
        throw cleanupBlockedError();
      }
      if (receipt !== 'confirmed\n') throw cleanupBlockedError();
      await rm(cleanup.cleanupConfirmationPath, { force: true });
      return true;
    }

    if (isProcessGroupAlive(matchingOwner.runtimePid) !== false) return false;
    let ownerResources;
    try {
      ownerResources = ownerCleanup(matchingOwner, stateDirectory);
      if (ownerResources === undefined) throw cleanupBlockedError();
      await cleanupDeepSeekRuntimeResources(
        stateDirectory,
        ownerResources.cleanupPaths,
        ownerResources.cleanupConfirmationPath,
        ownerResources.cleanupRoot,
      );
      await rm(matchingOwnerPath, { force: true });
      await rm(cleanup.cleanupConfirmationPath, { force: true });
    } catch {
      await failClosedAfterCleanupError(
        lock,
        stateDirectory,
        ownerDirectory,
        matchingOwnerPath,
        matchingOwner,
      );
    }
    return true;
  });
}

/** Caller must hold `withDeepSeekRuntimeStateFileLock` for `stateDirectory`. */
export async function markDeepSeekCleanupBarrierLocked(stateDirectory, ownerDirectory, unregisteredRuntimePid) {
  let runtimePids = [];
  let unknownRuntime = false;
  try {
    const entries = await readdir(ownerDirectory);
    unknownRuntime = entries.length === 0 && unregisteredRuntimePid === undefined;
    runtimePids = await Promise.all(entries.map(async (entry) => {
      const owner = JSON.parse(await readFile(join(ownerDirectory, entry), 'utf8'));
      if (!Number.isSafeInteger(owner?.runtimePid) || owner.runtimePid <= 0) {
        throw cleanupBlockedError();
      }
      return owner.runtimePid;
    }));
  } catch {
    unknownRuntime = true;
  }
  if (unregisteredRuntimePid !== undefined) {
    if (Number.isSafeInteger(unregisteredRuntimePid) && unregisteredRuntimePid > 0) {
      runtimePids.push(unregisteredRuntimePid);
    } else {
      unknownRuntime = true;
    }
  }
  // An empty registry alone cannot rule out a supervisor not yet published.
  // The parent skips this barrier only with its own supervisor's exit receipt.

  const barrierPath = join(stateDirectory, CLEANUP_BARRIER_FILE);
  try {
    await writeFile(barrierPath, `${JSON.stringify({ runtimePids, unknownRuntime })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw cleanupBlockedError();
  }
  // EEXIST alone is not confirmation: reject a directory, malformed/partial
  // file, or a prior barrier that does not cover this failed runtime cleanup.
  const persisted = await readCleanupBarrier(stateDirectory);
  if (persisted === undefined || typeof persisted.unknownRuntime !== 'boolean'
    || (persisted.unknownRuntime !== true
      && (unknownRuntime || runtimePids.some((pid) => !persisted.runtimePids.includes(pid))))) {
    throw cleanupBlockedError();
  }
}
