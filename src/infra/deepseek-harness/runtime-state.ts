import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalConfigDir } from '../config/paths.js';
import {
  assertDeepSeekRuntimeCreationAllowedLocked,
  DEEPSEEK_RUNTIME_BUSY_MESSAGE,
  markDeepSeekCleanupBarrierLocked,
  withDeepSeekRuntimeStateFileLock,
} from './runtime-state-lock.mjs';

const STATE_DIRECTORY = 'deepseek-harness';
const SESSION_DIRECTORY = 'sessions';
const OWNER_DIRECTORY = 'runtime-owners';
const CLEANUP_BLOCKED_MESSAGE =
  'DeepSeek Harness runtime cleanup is unconfirmed; no new runtime can start. Confirm that all previous DeepSeek runtimes, supervisors, and tool processes have exited, then manually remove .runtime-state-lock and cleanup-blocked from deepseek-harness/state/ under the TAKT config directory.';
const CONTINUATION_MESSAGE =
  'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.';

export class DeepSeekRuntimeCreationBlockedError extends Error {
  /** Create the fixed durable-cleanup-blocker error exposed by runtime admission checks. */
  constructor() {
    super(CLEANUP_BLOCKED_MESSAGE);
    this.name = 'DeepSeekRuntimeCreationBlockedError';
  }
}

/** A healthy foreign owner holds the shared runtime home; no cleanup failed. */
export class DeepSeekRuntimeBusyError extends Error {
  /** Create the distinct busy-home error for a healthy foreign runtime owner. */
  constructor() {
    super(DEEPSEEK_RUNTIME_BUSY_MESSAGE);
    this.name = 'DeepSeekRuntimeBusyError';
  }
}

export interface DeepSeekRuntimePaths {
  root: string;
  dshHome: string;
  state: string;
  sessions: string;
  owners: string;
}

let runtimeStateQueue: Promise<void> = Promise.resolve();

/** Serialize parent-side state operations without holding a promise across rejection. */
async function withRuntimeStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = runtimeStateQueue;
  let release: () => void = () => {};
  runtimeStateQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Derive managed runtime/state paths independently of the user's credential home. */
export function getDeepSeekRuntimePaths(): DeepSeekRuntimePaths {
  const root = join(getGlobalConfigDir(), STATE_DIRECTORY);
  return {
    root,
    dshHome: join(root, 'dsh-home'),
    state: join(root, 'state'),
    sessions: join(root, SESSION_DIRECTORY),
    owners: join(root, OWNER_DIRECTORY),
  };
}

/** Hash session IDs into path-safe durable usage marker names. */
export function getDeepSeekSessionMarkerPath(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(getDeepSeekRuntimePaths().sessions, `${digest}.used`);
}

/** Create private state directories before session markers or owner records are written. */
async function ensureRuntimeDirectories(): Promise<void> {
  const paths = getDeepSeekRuntimePaths();
  await Promise.all([
    mkdir(paths.root, { recursive: true, mode: 0o700 }),
    mkdir(paths.dshHome, { recursive: true, mode: 0o700 }),
    mkdir(paths.state, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessions, { recursive: true, mode: 0o700 }),
    mkdir(paths.owners, { recursive: true, mode: 0o700 }),
  ]);
}

/** Check durable session usage without treating unreadable state as a fresh session. */
export async function hasDeepSeekSessionMarker(sessionId: string): Promise<boolean> {
  try {
    await readFile(getDeepSeekSessionMarkerPath(sessionId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Atomically mark a generated SDK ID; false indicates an already-used identity. */
export async function markDeepSeekSessionUsed(sessionId: string): Promise<boolean> {
  const markerPath = getDeepSeekSessionMarkerPath(sessionId);
  await ensureRuntimeDirectories();
  try {
    const marker = await open(markerPath, 'wx', 0o600);
    await marker.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Publish cleanup evidence under the shared lock or retain the lock on failure. */
async function markDeepSeekCleanupFailureUnlocked(): Promise<void> {
  const paths = getDeepSeekRuntimePaths();
  await ensureRuntimeDirectories();
  await withDeepSeekRuntimeStateFileLock(paths.state, async (lock) => {
    try {
      await markDeepSeekCleanupBarrierLocked(paths.state, paths.owners);
    } catch {
      lock.retain();
      throw new DeepSeekRuntimeCreationBlockedError();
    }
  });
}

/** Serialize cleanup barrier publication against subsequent parent-side startup. */
export async function markDeepSeekCleanupFailure(): Promise<void> {
  await withRuntimeStateLock(markDeepSeekCleanupFailureUnlocked);
}

/** Refuse a new subprocess while an unowned or unconfirmed runtime group may still run. */
async function assertDeepSeekRuntimeCreationAllowedUnderQueue(): Promise<void> {
  try {
    await ensureRuntimeDirectories();
    const paths = getDeepSeekRuntimePaths();
    await withDeepSeekRuntimeStateFileLock(paths.state, () =>
      assertDeepSeekRuntimeCreationAllowedLocked(paths.state, paths.owners, process.pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'DEEPSEEK_RUNTIME_BUSY') {
      throw new DeepSeekRuntimeBusyError();
    }
    throw new DeepSeekRuntimeCreationBlockedError();
  }
}

/** Coordinate the cleanup barrier check and the SDK runtime's initial start operation. */
export async function withDeepSeekRuntimeCreation<T>(
  create: () => Promise<T>,
  cleanupAfterFailure?: () => Promise<boolean>,
): Promise<T> {
  return withRuntimeStateLock(async () => {
    await assertDeepSeekRuntimeCreationAllowedUnderQueue();
    try {
      return await create();
    } catch (error) {
      if (cleanupAfterFailure === undefined) throw error;
      let cleanupConfirmed = false;
      try {
        cleanupConfirmed = await cleanupAfterFailure();
      } catch {
        cleanupConfirmed = false;
      }
      if (!cleanupConfirmed) {
        await markDeepSeekCleanupFailureUnlocked();
        throw new DeepSeekRuntimeCreationBlockedError();
      }
      throw error;
    }
  });
}

/** Refuse unconfirmed cleanup and distinguish healthy foreign runtime ownership. */
export async function assertDeepSeekRuntimeCreationAllowed(): Promise<void> {
  await withRuntimeStateLock(assertDeepSeekRuntimeCreationAllowedUnderQueue);
}

export const deepSeekContinuationMessage = (): string => CONTINUATION_MESSAGE;
export const deepSeekCleanupBlockedMessage = (): string => CLEANUP_BLOCKED_MESSAGE;
