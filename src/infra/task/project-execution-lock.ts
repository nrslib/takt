import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getProcessIdentity, getSelfProcessIdentity, hasProcessIdentityMismatch, isProcessAlive, sameProcessIdentity,
  type ProcessIdentity,
} from './process.js';

export type ProjectExecutionKind = 'run' | 'watch';
export type ProjectExecutionState = 'starting' | 'running' | 'stopping';

interface ExecutionOwner {
  readonly ownerId: string;
  readonly pid: number;
  readonly processIdentity: ProcessIdentity;
  readonly kind: ProjectExecutionKind;
  readonly state: ProjectExecutionState;
}

export interface ProjectExecutionLock {
  readonly owner: ExecutionOwner;
  updateState(state: ProjectExecutionState): void;
  release(): void;
}

export class ProjectExecutionAlreadyRunningError extends Error {
  constructor(owner: ExecutionOwner) {
    super(`TAKT ${owner.kind} is already running for this project (PID ${owner.pid})`);
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OwnerSnapshot {
  readonly owner: ExecutionOwner;
  readonly directoryIdentity: DirectoryIdentity;
}

const LOCK_DIRECTORY = 'execution.lock';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ACQUISITION_ATTEMPTS = 8;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isPublicationConflict(error: unknown, directory: string): boolean {
  if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY')) return true;
  if (process.platform !== 'win32' || !hasCode(error, 'EPERM')) return false;
  // Windows also reports directory collisions as EPERM; it is not sufficient
  // on its own to distinguish an existing lock from a permission failure.
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
}

function ownerFileName(ownerId: string): string {
  return `owner-${ownerId}.json`;
}

function readDirectoryIdentity(directory: string): DirectoryIdentity {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Invalid project execution lock directory: ${directory}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function matchesDirectory(directory: string, expected: DirectoryIdentity): boolean {
  try {
    const current = readDirectoryIdentity(directory);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function parseOwner(value: unknown): ExecutionOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid project execution lock owner record');
  }
  const raw = value as Record<string, unknown>;
  const identity = raw.processIdentity;
  if (
    typeof raw.ownerId !== 'string' || !UUID.test(raw.ownerId)
    || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0
    || (raw.kind !== 'run' && raw.kind !== 'watch')
    || (raw.state !== 'starting' && raw.state !== 'running' && raw.state !== 'stopping')
    || identity === null || typeof identity !== 'object' || Array.isArray(identity)
    || !('startTime' in identity) || typeof identity.startTime !== 'string'
    || identity.startTime.trim().length === 0
  ) {
    throw new Error('Invalid project execution lock owner record');
  }
  return {
    ownerId: raw.ownerId, pid: raw.pid as number, kind: raw.kind, state: raw.state,
    processIdentity: { startTime: identity.startTime },
  };
}

function readOwnerFile(path: string): ExecutionOwner {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Invalid project execution lock owner file: ${path}`);
    }
    return parseOwner(JSON.parse(readFileSync(descriptor, 'utf8')) as unknown);
  } finally {
    closeSync(descriptor);
  }
}

function readOwner(directory: string): OwnerSnapshot | undefined {
  try {
    const directoryIdentity = readDirectoryIdentity(directory);
    const names = readdirSync(directory);
    const ownerNames = names.filter((name) => name.startsWith('owner-') && name.endsWith('.json'));
    if (ownerNames.length === 0 && names.length === 0) {
      removeEmptyDirectory(directory);
      return undefined;
    }
    if (ownerNames.length !== 1) throw new Error('Project execution lock has no unique owner record');
    const owner = readOwnerFile(join(directory, ownerNames[0]!));
    if (ownerNames[0] !== ownerFileName(owner.ownerId)
      || names.some((name) => name !== ownerNames[0] && !isOwnerTemporary(name, owner.ownerId))) {
      throw new Error('Invalid project execution lock contents');
    }
    if (!matchesDirectory(directory, directoryIdentity)) return undefined;
    return { owner, directoryIdentity };
  } catch (error) {
    // Another contender may finish recovery between directory listing and read.
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function isOwnerTemporary(name: string, ownerId: string): boolean {
  const prefix = `${ownerFileName(ownerId)}.`;
  return name.startsWith(prefix) && name.endsWith('.tmp')
    && UUID.test(name.slice(prefix.length, -4));
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error;
  }
}

function removeOwner(directory: string, snapshot: OwnerSnapshot): void {
  if (!matchesDirectory(directory, snapshot.directoryIdentity)) return;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  // Keep the complete record until temporary files are gone, so interrupted
  // recovery still leaves enough information for the next acquisition.
  for (const name of names.filter((name) => isOwnerTemporary(name, snapshot.owner.ownerId))) {
    if (!matchesDirectory(directory, snapshot.directoryIdentity)) return;
    unlinkIfPresent(join(directory, name));
  }
  if (!matchesDirectory(directory, snapshot.directoryIdentity)) return;
  unlinkIfPresent(join(directory, ownerFileName(snapshot.owner.ownerId)));
  // A delayed remover cannot remove a new holder's nonempty directory.
  removeEmptyDirectory(directory);
}

function writeOwner(path: string, owner: ExecutionOwner): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function recoverOwner(directory: string, nextOwnerId: string): void {
  const snapshot = readOwner(directory);
  if (snapshot === undefined) return;
  const { owner } = snapshot;
  if (isProcessAlive(owner.pid)) {
    const currentIdentity = getProcessIdentity(owner.pid);
    if (!hasProcessIdentityMismatch(owner.processIdentity, currentIdentity)) {
      throw new ProjectExecutionAlreadyRunningError(owner);
    }
  }
  if (owner.ownerId === nextOwnerId) {
    throw new Error('Project execution owner ID collides with a previous owner');
  }
  removeOwner(directory, snapshot);
}

export function getProjectExecutionOwner(cwd: string): ExecutionOwner | undefined {
  const directory = join(cwd, '.takt', LOCK_DIRECTORY);
  const snapshot = readOwner(directory);
  if (snapshot === undefined) return undefined;
  if (isProcessAlive(snapshot.owner.pid)
    && !hasProcessIdentityMismatch(snapshot.owner.processIdentity, getProcessIdentity(snapshot.owner.pid))) {
    return snapshot.owner;
  }
  removeOwner(directory, snapshot);
  return undefined;
}

export function acquireProjectExecutionLock(cwd: string, kind: ProjectExecutionKind): ProjectExecutionLock {
  const processIdentity = getSelfProcessIdentity();
  if (processIdentity === undefined) {
    throw new Error('Cannot acquire project execution lock: process start time is unavailable');
  }
  let owner: ExecutionOwner = {
    ownerId: randomUUID(), pid: process.pid, processIdentity: { ...processIdentity }, kind, state: 'starting',
  };
  const parent = join(cwd, '.takt');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = join(parent, LOCK_DIRECTORY);
  const staging = mkdtempSync(`${directory}.`);
  const directoryIdentity = readDirectoryIdentity(staging);
  let acquired = false;
  try {
    writeOwner(join(staging, ownerFileName(owner.ownerId)), owner);
    for (let attempt = 0; attempt < ACQUISITION_ATTEMPTS; attempt++) {
      try {
        // Only completed records become visible. Rename cannot replace an
        // existing nonempty directory, even if the generated IDs collide.
        renameSync(staging, directory);
        acquired = true;
        break;
      } catch (error) {
        if (!isPublicationConflict(error, directory)) throw error;
        recoverOwner(directory, owner.ownerId);
      }
    }
    if (!acquired) throw new Error('Could not acquire project execution lock after concurrent ownership changes');
  } finally {
    if (!acquired) removeOwner(staging, { owner, directoryIdentity });
  }

  let released = false;
  return {
    get owner(): ExecutionOwner {
      return { ...owner, processIdentity: { ...owner.processIdentity } };
    },
    updateState(state): void {
      if (released) throw new Error('Project execution lock is already released');
      const snapshot = readOwner(directory);
      if (snapshot === undefined || !matchesDirectory(directory, directoryIdentity)
        || snapshot.owner.ownerId !== owner.ownerId || snapshot.owner.pid !== owner.pid
        || !sameProcessIdentity(snapshot.owner.processIdentity, owner.processIdentity)) {
        throw new Error('Project execution lock ownership changed');
      }
      const updated = { ...owner, state };
      const temporary = join(directory, `${ownerFileName(owner.ownerId)}.${randomUUID()}.tmp`);
      try {
        writeOwner(temporary, updated);
        if (!matchesDirectory(directory, directoryIdentity)) throw new Error('Project execution lock ownership changed');
        renameSync(temporary, join(directory, ownerFileName(owner.ownerId)));
        owner = updated;
      } finally {
        if (matchesDirectory(directory, directoryIdentity)) unlinkIfPresent(temporary);
      }
    },
    release(): void {
      if (released) return;
      removeOwner(directory, { owner, directoryIdentity });
      released = true;
    },
  };
}
