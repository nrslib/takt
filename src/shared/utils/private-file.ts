import {
  appendFileSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync,
  linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { hasMatchingDirectoryIdentity, hasMatchingIdentity, lstatOrUndefined } from './private-path-identity.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export class PrivateArtifactPublicationConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrivateArtifactPublicationConflictError';
  }
}

export class PrivateArtifactContentWriteFailedError extends Error {
  readonly code = 'ENOSPC';
  constructor(message: string, readonly errno: number | undefined, options: ErrorOptions) { super(message, options); }
}

export interface PrivateDirectoryReadSnapshot {
  readonly path: string;
  readonly stat: Stats;
}

export type PrivateFileState =
  | { readonly path: string; readonly exists: false }
  | { readonly path: string; readonly exists: true; readonly stat: Stats; readonly contentSha256: string };
export type PrivateFileReadSnapshot =
  | { readonly state: Extract<PrivateFileState, { exists: false }> }
  | { readonly state: Extract<PrivateFileState, { exists: true }>; readonly content: Buffer };
type PublicationGuardResult = boolean | { publish: boolean; content: string | Buffer };

export function ensurePrivateDirectory(path: string): void {
  const absolute = resolve(path);
  const firstCreated = mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    if (firstCreated !== undefined) {
      let current = firstCreated;
      chmodSync(current, 0o700);
      for (const component of relative(firstCreated, absolute).split(sep).filter(Boolean)) {
        current = join(current, component);
        chmodSync(current, 0o700);
      }
    }
    repairPrivateDirectory(absolute);
  }
}

export function repairPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Private artifact path is not a directory: ${path}`);
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function fileStat(path: string): Stats | undefined {
  const stat = lstatOrUndefined(path);
  if (stat !== undefined && !stat.isFile()) throw new Error(`Private artifact path is not a regular file: ${path}`);
  return stat;
}

function sha256(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }

export function readRegularFileNoFollow(path: string, expected: Stats): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || !hasMatchingIdentity(expected, stat)) throw new PrivateArtifactPublicationConflictError(`Private file changed: ${path}`);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

export function readPrivateFileState(path: string): PrivateFileReadSnapshot {
  const absolute = resolve(path);
  const stat = fileStat(absolute);
  if (stat === undefined) return { state: { path: absolute, exists: false } };
  const content = readRegularFileNoFollow(absolute, stat);
  const current = fileStat(absolute);
  if (current === undefined || !hasMatchingIdentity(stat, current)) throw new PrivateArtifactPublicationConflictError(`Private file changed: ${absolute}`);
  return { state: { path: absolute, exists: true, stat: current, contentSha256: sha256(content) }, content };
}

function assertExpected(path: string, expected: PrivateFileState): void {
  if (expected.path !== path) throw new Error('Expected file state belongs to another path');
  const actual = readPrivateFileState(path);
  if (expected.exists !== actual.state.exists || expected.exists && actual.state.exists
    && (!hasMatchingIdentity(expected.stat, actual.state.stat) || expected.contentSha256 !== actual.state.contentSha256)) {
    throw new PrivateArtifactPublicationConflictError(`Private file changed before publication: ${path}`);
  }
}

function withCleanup(action: () => void, cleanup: () => void): void {
  let failed = false;
  let failure: unknown;
  try { action(); } catch (error) { failed = true; failure = error; }
  try { cleanup(); } catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Private file operation and cleanup failed');
    throw error;
  }
  if (failed) throw failure;
}

function writeAtomic(path: string, initialContent: string | Buffer, mode: number, rejectExisting: boolean,
  guard?: () => PublicationGuardResult, expected?: PrivateFileState): { published: boolean; stat?: Stats } {
  const absolute = resolve(path);
  const original = fileStat(absolute);
  if (expected !== undefined) assertExpected(absolute, expected);
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`);
  let created = false;
  let published = false;
  let stat: Stats | undefined;
  withCleanup(() => {
    let content = initialContent;
    const descriptor = openSync(temporary, 'wx', mode);
    created = true;
    withCleanup(() => {
      try {
        fchmodSync(descriptor, mode);
        writeFileSync(descriptor, content);
        const decision = guard?.();
        if (decision === false || typeof decision === 'object' && !decision.publish) return;
        if (typeof decision === 'object') {
          content = decision.content;
          const replacement = openSync(temporary, 'w');
          try { writeFileSync(replacement, content); } finally { closeSync(replacement); }
        }
        fsyncSync(descriptor);
        stat = fstatSync(descriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
          throw new PrivateArtifactContentWriteFailedError(error instanceof Error ? error.message : String(error), (error as NodeJS.ErrnoException).errno, { cause: error });
        }
        throw error;
      }
    }, () => closeSync(descriptor));
    if (stat === undefined) return;
    if (expected !== undefined) assertExpected(absolute, expected);
    const current = fileStat(absolute);
    if (original === undefined ? current !== undefined : current === undefined || !hasMatchingIdentity(original, current)) {
      throw new PrivateArtifactPublicationConflictError(`Private file changed before publication: ${absolute}`);
    }
    const temporaryStat = fileStat(temporary);
    if (temporaryStat === undefined || !hasMatchingIdentity(stat, temporaryStat)) throw new PrivateArtifactPublicationConflictError(`Temporary private file changed: ${temporary}`);
    if (rejectExisting) {
      try { linkSync(temporary, absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PrivateArtifactPublicationConflictError(`Private artifact file already exists: ${absolute}`, { cause: error });
        throw error;
      }
    } else renameSync(temporary, absolute);
    published = true;
  }, () => {
    if (created) {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  });
  return { published, stat };
}

export function appendPrivateFile(path: string, content: string): void {
  fileStat(path);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, 0o600);
  try { fchmodSync(descriptor, 0o600); appendFileSync(descriptor, content, 'utf8'); }
  finally { closeSync(descriptor); }
}

export function writePrivateFile(path: string, content: string): void { writePrivateFileWithMode(path, content, 0o600); }
export function writePrivateFileWithMode(path: string, content: string | Buffer, mode: number): void { writeAtomic(path, content, mode, false); }
export function writePrivateFileWithModeGuarded(path: string, content: string | Buffer, mode: number, guard: () => PublicationGuardResult): boolean {
  return writeAtomic(path, content, mode, false, guard).published;
}
export function writePrivateFileWithModeExpected(path: string, content: string | Buffer, mode: number, expected: PrivateFileState): void {
  writeAtomic(path, content, mode, false, undefined, expected);
}
export function publishPrivateFileWithModeExpected(path: string, content: string | Buffer, mode: number, expected: PrivateFileState): Stats {
  const result = writeAtomic(path, content, mode, false, undefined, expected);
  if (result.stat === undefined || !result.published) throw new Error('Private file was not published');
  return result.stat;
}
export function writePrivateFileWithModeExpectedGuarded(path: string, content: string | Buffer, mode: number,
  expected: PrivateFileState, guard: () => PublicationGuardResult): boolean {
  return writeAtomic(path, content, mode, false, guard, expected).published;
}
export function writeNewPrivateFileWithMode(path: string, content: string | Buffer, mode: number): void { writeAtomic(path, content, mode, true); }

export function capturePrivateDirectoryReadSnapshot(path: string): PrivateDirectoryReadSnapshot {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) throw new Error(`Private artifact path is not a directory: ${absolute}`);
  return { path: absolute, stat };
}
export function assertPrivateDirectoryReadSnapshot(snapshot: PrivateDirectoryReadSnapshot): void {
  const stat = lstatSync(snapshot.path);
  if (!hasMatchingDirectoryIdentity(snapshot.stat, stat)) throw new Error('Private directory changed during traversal');
}
export function publishPrivateDirectory(parentPath: string, staging: string, target: string, _parentStat: Stats, stagingStat: Stats, targetStat: Stats | undefined): void {
  if (dirname(resolve(staging)) !== resolve(parentPath) || dirname(resolve(target)) !== resolve(parentPath)) throw new Error('Private directory must be an immediate child');
  if (!hasMatchingDirectoryIdentity(stagingStat, lstatSync(staging))) throw new Error('Staging directory changed');
  const current = lstatOrUndefined(target);
  if (targetStat === undefined ? current !== undefined : current === undefined || !hasMatchingDirectoryIdentity(targetStat, current)) throw new Error('Publication directory changed');
  renameSync(staging, target);
}
export function removePrivateDirectory(parentPath: string, staging: string, _parentStat: Stats, stagingStat: Stats): void {
  if (dirname(resolve(staging)) !== resolve(parentPath)) throw new Error('Private directory must be an immediate child');
  const current = lstatOrUndefined(staging);
  if (current === undefined) return;
  if (!hasMatchingDirectoryIdentity(stagingStat, current)) throw new Error('Staging directory changed');
  rmSync(staging, { recursive: true });
}
