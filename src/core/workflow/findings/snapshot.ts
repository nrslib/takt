import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, type Stats } from 'node:fs';

const HASH_CHUNK_BYTES = 1024 * 1024;
const CAPTURE_ATTEMPTS = 3;
const SNAPSHOT_FORMAT = Buffer.from('review-scope-snapshot-v2');

class ReviewScopeSnapshotError extends Error {
  constructor(operation: string, path: string, cause: unknown) {
    super(`ReviewScopeSnapshotError: ${operation} failed for ${path}: ${describeCause(cause)}`, { cause });
    this.name = 'ReviewScopeSnapshotError';
  }
}

interface TrackedEntry {
  indexMode: Buffer;
  indexObject: Buffer;
  path: Buffer;
  stage: Buffer;
}

interface SnapshotEntry {
  path: Buffer;
  record: Buffer;
  sortOrder: number;
  stage: Buffer;
}

interface CapturedSnapshot {
  inventory: Buffer;
  snapshotId: string;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fail(operation: string, path: string, cause: unknown): never {
  throw new ReviewScopeSnapshotError(operation, path, cause);
}

function displayPath(path: Buffer): string {
  return `0x${path.toString('hex')}`;
}

function absolutePath(cwd: string, path: Buffer): Buffer {
  return Buffer.concat([Buffer.from(cwd), Buffer.from('/'), path]);
}

function decodeRepositoryPath(path: Buffer): string {
  const decoded = path.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(path)) {
    return fail('path encoding', displayPath(path), new Error('repository path is not reversibly UTF-8 encoded'));
  }
  return decoded;
}

function runGit(cwd: string, args: string[]): Buffer {
  const operation = `git ${args.join(' ')}`;
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    return fail(operation, cwd, cause);
  }
}

function parseNulEntries(output: Buffer, operation: string, path: string): Buffer[] {
  if (output.length === 0) {
    return [];
  }
  if (output[output.length - 1] !== 0) {
    return fail(operation, path, new Error('NUL-terminated output is missing its final delimiter'));
  }

  const entries: Buffer[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) {
      return fail(operation, path, new Error('NUL-terminated output contains an unterminated entry'));
    }
    if (end === start) {
      return fail(operation, path, new Error('NUL-terminated output contains an empty path'));
    }
    entries.push(Buffer.from(output.subarray(start, end)));
    start = end + 1;
  }
  return entries;
}

function parseTrackedEntry(record: Buffer, cwd: string): TrackedEntry {
  const firstSpace = record.indexOf(0x20);
  const secondSpace = record.indexOf(0x20, firstSpace + 1);
  const tab = record.indexOf(0x09, secondSpace + 1);
  if (firstSpace <= 0 || secondSpace <= firstSpace + 1 || tab <= secondSpace + 1 || tab === record.length - 1) {
    return fail('git ls-files --cached --stage -z parse', cwd, new Error('invalid index stage record'));
  }

  const indexMode = record.subarray(0, firstSpace);
  const indexObject = record.subarray(firstSpace + 1, secondSpace);
  const stage = record.subarray(secondSpace + 1, tab);
  if (!/^[0-7]{6}$/.test(indexMode.toString('ascii')) || !/^[0-9a-f]{40,64}$/.test(indexObject.toString('ascii')) || !/^[0-3]$/.test(stage.toString('ascii'))) {
    return fail('git ls-files --cached --stage -z parse', cwd, new Error('invalid index stage fields'));
  }

  return {
    indexMode: Buffer.from(indexMode),
    indexObject: Buffer.from(indexObject),
    path: Buffer.from(record.subarray(tab + 1)),
    stage: Buffer.from(stage),
  };
}

function lengthPrefixed(value: Buffer | string | number): Buffer {
  const bytes = typeof value === 'number'
    ? Buffer.from(String(value))
    : typeof value === 'string'
      ? Buffer.from(value)
      : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function normalizeRecord(fields: Array<[string, Buffer | string | number]>): Buffer {
  return Buffer.concat([
    lengthPrefixed(SNAPSHOT_FORMAT),
    ...fields.flatMap(([name, value]) => [lengthPrefixed(name), lengthPrefixed(value)]),
  ]);
}

function actualMode(stat: Stats): number {
  return stat.mode;
}

function fileKind(stat: Stats): string {
  if (stat.isFile()) {
    return 'file';
  }
  if (stat.isSymbolicLink()) {
    return 'symlink';
  }
  if (stat.isDirectory()) {
    return 'directory';
  }
  if (stat.isBlockDevice()) {
    return 'block-device';
  }
  if (stat.isCharacterDevice()) {
    return 'character-device';
  }
  if (stat.isFIFO()) {
    return 'fifo';
  }
  if (stat.isSocket()) {
    return 'socket';
  }
  return 'other';
}

function hasMatchingFileIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && actualMode(expected) === actualMode(actual)
    && fileKind(expected) === fileKind(actual);
}

function hashFileContent(absPath: Buffer, path: Buffer, expectedStat: Stats): Buffer {
  if (constants.O_NOFOLLOW === undefined) {
    return fail('open', displayPath(path), new Error('O_NOFOLLOW is unavailable on this platform'));
  }

  let fd: number;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    return fail('open', displayPath(path), cause);
  }

  const hash = createHash('sha256');
  let failure: unknown;
  try {
    let openedStat: Stats;
    try {
      openedStat = fstatSync(fd);
    } catch (cause) {
      failure = cause;
      return fail('fstat', displayPath(path), cause);
    }
    if (!hasMatchingFileIdentity(expectedStat, openedStat) || !openedStat.isFile()) {
      failure = new Error('lstat and fstat file identities differ');
      return fail('verify opened file', displayPath(path), failure);
    }

    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      } catch (cause) {
        failure = cause;
        return fail('read', displayPath(path), cause);
      }
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    try {
      closeSync(fd);
    } catch (cause) {
      if (failure === undefined) {
        return fail('close', displayPath(path), cause);
      }
    }
  }
  return hash.digest();
}

function readSymlinkTarget(absPath: Buffer, path: Buffer): Buffer {
  try {
    return readlinkSync(absPath, { encoding: 'buffer' });
  } catch (cause) {
    return fail('readlink', displayPath(path), cause);
  }
}

function lstatPath(absPath: Buffer, path: Buffer, allowMissing: true): Stats | undefined;
function lstatPath(absPath: Buffer, path: Buffer, allowMissing: false): Stats;
function lstatPath(absPath: Buffer, path: Buffer, allowMissing: boolean): Stats | undefined {
  try {
    return lstatSync(absPath);
  } catch (cause) {
    if (allowMissing && isMissingPath(cause)) {
      return undefined;
    }
    return fail('lstat', displayPath(path), cause);
  }
}

function isMissingPath(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function assertGitlinkDirectory(stat: Stats, path: Buffer): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return fail('submodule path', displayPath(path), new Error('gitlink working tree must be a non-symlink directory'));
  }
}

function trackedSnapshotEntry(cwd: string, entry: TrackedEntry, visitedDirectories: Set<string>): SnapshotEntry {
  const absPath = absolutePath(cwd, entry.path);
  const stat = lstatPath(absPath, entry.path, true);
  const baseFields: Array<[string, Buffer | string | number]> = [
    ['path', entry.path],
    ['tracked', 1],
    ['indexMode', entry.indexMode],
    ['indexObject', entry.indexObject],
    ['stage', entry.stage],
  ];
  if (stat === undefined) {
    return {
      path: entry.path,
      record: normalizeRecord([
        ...baseFields,
        ['kind', 'deleted'],
        ['actualMode', ''],
        ['deleted', 1],
      ]),
      sortOrder: 0,
      stage: entry.stage,
    };
  }

  const fields = [...baseFields, ['kind', fileKind(stat)], ['actualMode', actualMode(stat)], ['deleted', 0]] as Array<[string, Buffer | string | number]>;
  if (entry.indexMode.equals(Buffer.from('160000'))) {
    assertGitlinkDirectory(stat, entry.path);
    let digest: string;
    try {
      digest = computeStableSnapshot(decodeRepositoryPath(absPath), visitedDirectories);
    } catch (cause) {
      return fail('submodule digest', displayPath(entry.path), cause);
    }
    fields[5] = ['kind', 'submodule'];
    fields.push(['submoduleGitlink', entry.indexObject], ['submoduleWorkingTreeDigest', digest]);
  } else if (stat.isSymbolicLink()) {
    fields.push(['symlinkTarget', readSymlinkTarget(absPath, entry.path)]);
  } else if (stat.isFile()) {
    fields.push(['contentDigest', hashFileContent(absPath, entry.path, stat)]);
  }

  return {
    path: entry.path,
    record: normalizeRecord(fields),
    sortOrder: 0,
    stage: entry.stage,
  };
}

function untrackedSnapshotEntry(cwd: string, path: Buffer, visitedDirectories: Set<string>): SnapshotEntry {
  const absPath = absolutePath(cwd, path);
  const stat = lstatPath(absPath, path, false);

  const fields: Array<[string, Buffer | string | number]> = [
    ['path', path],
    ['tracked', 0],
    ['kind', fileKind(stat)],
    ['actualMode', actualMode(stat)],
    ['indexMode', ''],
    ['indexObject', ''],
    ['stage', ''],
    ['deleted', 0],
  ];
  if (stat.isSymbolicLink()) {
    fields.push(['symlinkTarget', readSymlinkTarget(absPath, path)]);
  } else if (stat.isFile()) {
    fields.push(['contentDigest', hashFileContent(absPath, path, stat)]);
  } else if (stat.isDirectory()) {
    let digest: string;
    try {
      digest = computeStableSnapshot(decodeRepositoryPath(absPath), visitedDirectories);
    } catch (cause) {
      return fail('embedded repository digest', displayPath(path), cause);
    }
    fields.push(['embeddedRepositoryWorkingTreeDigest', digest]);
  }

  return { path, record: normalizeRecord(fields), sortOrder: 1, stage: Buffer.alloc(0) };
}

function captureSnapshot(cwd: string, visitedDirectories: Set<string>): CapturedSnapshot {
  const trackedOutput = runGit(cwd, ['ls-files', '--cached', '--stage', '-z']);
  const untrackedOutput = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const head = runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  const tracked = parseNulEntries(trackedOutput, 'git ls-files --cached --stage -z parse', cwd)
    .map((record) => parseTrackedEntry(record, cwd));
  const untracked = parseNulEntries(untrackedOutput, 'git ls-files --others --exclude-standard -z parse', cwd);
  const entries = [
    ...tracked.map((entry) => trackedSnapshotEntry(cwd, entry, visitedDirectories)),
    ...untracked.map((path) => untrackedSnapshotEntry(cwd, path, visitedDirectories)),
  ];
  entries.sort((left, right) => Buffer.compare(left.path, right.path)
    || left.sortOrder - right.sortOrder
    || Buffer.compare(left.stage, right.stage));

  const inventory = Buffer.concat([
    lengthPrefixed(normalizeRecord([['repositoryHead', head]])),
    ...entries.map((entry) => lengthPrefixed(entry.record)),
  ]);
  const hash = createHash('sha256');
  hash.update(lengthPrefixed(SNAPSHOT_FORMAT));
  hash.update(lengthPrefixed(inventory));
  return { inventory, snapshotId: hash.digest('hex') };
}

function directoryIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

function captureDirectoryIdentity(cwd: string): string {
  let stat: Stats;
  try {
    stat = lstatSync(cwd);
  } catch (cause) {
    return fail('lstat capture directory', cwd, cause);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return fail('capture directory', cwd, new Error('expected a non-symlink directory'));
  }
  return directoryIdentity(stat);
}

function computeStableSnapshot(cwd: string, visitedDirectories: Set<string>): string {
  const identity = captureDirectoryIdentity(cwd);
  if (visitedDirectories.has(identity)) {
    return fail('capture recursion', cwd, new Error('directory cycle detected'));
  }
  visitedDirectories.add(identity);
  try {
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      const first = captureSnapshot(cwd, visitedDirectories);
      const second = captureSnapshot(cwd, visitedDirectories);
      if (first.snapshotId === second.snapshotId && first.inventory.equals(second.inventory)) {
        return second.snapshotId;
      }
    }
    return fail('capture', cwd, new Error(`working tree changed during ${CAPTURE_ATTEMPTS} consecutive capture attempts`));
  } finally {
    visitedDirectories.delete(identity);
  }
}

/**
 * cwd のレビュー対象を内容アドレスする不透明なトークン。追跡・未追跡（ignored
 * を除く）を実体から収集し、連続する2回の完全一致を確認してから返す。
 */
export function computeReviewScopeSnapshotId(cwd: string): string {
  return computeStableSnapshot(cwd, new Set());
}
