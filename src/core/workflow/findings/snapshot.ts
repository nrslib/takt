import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, type Stats } from 'node:fs';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import {
  collectTaskReviewScope,
  resolveReviewScopeBaseRange,
  type ReviewScopeBaseRange,
  type TaskReviewScope,
} from '../review-scope.js';

const HASH_CHUNK_BYTES = 1024 * 1024;
const CAPTURE_ATTEMPTS = 3;
const SNAPSHOT_FORMAT = Buffer.from('review-scope-snapshot');
const SNAPSHOT_DIFF_MAX_BYTES = 20_000;
const SNAPSHOT_DIFF_CAPTURE_MAX_BYTES = 128 * 1024;
const SNAPSHOT_UNTRACKED_CONTENT_MAX_BYTES = 20_000;
const SNAPSHOT_QUERY_CONTENT_MAX_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_QUERY_FILE_MAX_BYTES = 1024 * 1024;

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
  untrackedEvidence?: ReviewScopeUntrackedEvidence;
  queryEntry: ReviewScopeQueryInventoryEntry;
}

interface CapturedSnapshot {
  inventory: Buffer;
  snapshotId: string;
  trackedDiff: string | undefined;
  untrackedEvidence: ReviewScopeUntrackedEvidence[];
  presentationDigest: string;
  queryInventory: ReviewScopeQueryInventoryEntry[];
  changedPaths: string[];
}

export interface ReviewScopeUntrackedEvidence {
  path: string;
  kind: string;
  contentDigest?: string;
  content?: string;
  contentEncoding?: 'utf8' | 'base64';
  truncated?: boolean;
}

export interface ReviewScopeSnapshot {
  reviewScopeSnapshotId: string;
  trackedDiff: string | undefined;
  untrackedEvidence: ReviewScopeUntrackedEvidence[];
}

export interface ReviewScopeQueryInventoryEntry {
  path: string;
  kind: string;
  contentDigest?: string;
  /** exact bytes retained from the same immutable snapshot read. */
  content?: Buffer;
  coverage:
    | 'complete'
    | 'resource_cap'
    | 'unsupported_kind'
    | 'unsupported_path_encoding'
    | 'excluded'
    | 'deleted';
}

export interface ReviewScopeProofSnapshot extends ReviewScopeSnapshot {
  queryInventory: ReviewScopeQueryInventoryEntry[];
  /** Engine-captured tracked/untracked paths that define the current task review scope. */
  changedPaths?: string[];
}

interface FileSnapshot {
  digest: Buffer;
  preview: Buffer;
  truncated: boolean;
  queryContent: Buffer;
  queryTruncated: boolean;
}

interface PreviewBudget {
  remainingBytes: number;
}

interface QueryBudget {
  remainingBytes: number;
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

function executeGit(cwd: string, args: string[], maxBuffer: number): Buffer {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
}

function runGit(cwd: string, args: string[]): Buffer {
  try {
    return executeGit(cwd, args, 64 * 1024 * 1024);
  } catch (cause) {
    return fail(`git ${args.join(' ')}`, cwd, cause);
  }
}

function isGitOutputLimitError(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'code' in cause
    && cause.code === 'ENOBUFS';
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

function readFileSnapshot(
  absPath: Buffer,
  path: Buffer,
  expectedStat: Stats,
  maxPreviewBytes: number,
  maxQueryBytes: number,
): FileSnapshot {
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
  const previewChunks: Buffer[] = [];
  const queryChunks: Buffer[] = [];
  let previewBytes = 0;
  let queryBytes = 0;
  let contentBytes = 0;
  let failure: unknown;
  let closeFailure: unknown;
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
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      contentBytes += bytesRead;
      const previewLength = Math.min(bytesRead, maxPreviewBytes - previewBytes);
      if (previewLength > 0) {
        previewChunks.push(Buffer.from(chunk.subarray(0, previewLength)));
        previewBytes += previewLength;
      }
      const queryLength = Math.min(bytesRead, maxQueryBytes - queryBytes);
      if (queryLength > 0) {
        queryChunks.push(Buffer.from(chunk.subarray(0, queryLength)));
        queryBytes += queryLength;
      }
    }
  } finally {
    try {
      closeSync(fd);
    } catch (cause) {
      if (failure === undefined) {
        closeFailure = cause;
      }
    }
  }
  if (closeFailure !== undefined) {
    return fail('close', displayPath(path), closeFailure);
  }
  return {
    digest: hash.digest(),
    preview: Buffer.concat(previewChunks),
    truncated: contentBytes > previewBytes,
    queryContent: Buffer.concat(queryChunks),
    queryTruncated: contentBytes > queryBytes,
  };
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

function trackedSnapshotEntry(
  cwd: string,
  entry: TrackedEntry,
  visitedDirectories: Set<string>,
  queryBudget: QueryBudget,
): SnapshotEntry {
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
      queryEntry: protectUnsupportedPathEncoding(entry.path, {
        path: displayRepositoryPath(entry.path),
        kind: 'deleted',
        coverage: 'deleted',
      }),
    };
  }

  const fields = [...baseFields, ['kind', fileKind(stat)], ['actualMode', actualMode(stat)], ['deleted', 0]] as Array<[string, Buffer | string | number]>;
  let queryEntry: ReviewScopeQueryInventoryEntry = {
    path: displayRepositoryPath(entry.path),
    kind: fileKind(stat),
    coverage: 'unsupported_kind',
  };
  if (entry.indexMode.equals(Buffer.from('160000'))) {
    assertGitlinkDirectory(stat, entry.path);
    let digest: string;
    try {
      digest = computeStableSnapshot(decodeRepositoryPath(absPath), visitedDirectories, false).reviewScopeSnapshotId;
    } catch (cause) {
      return fail('submodule digest', displayPath(entry.path), cause);
    }
    fields[5] = ['kind', 'submodule'];
    fields.push(['submoduleGitlink', entry.indexObject], ['submoduleWorkingTreeDigest', digest]);
    queryEntry = { ...queryEntry, kind: 'submodule' };
  } else if (stat.isSymbolicLink()) {
    fields.push(['symlinkTarget', readSymlinkTarget(absPath, entry.path)]);
  } else if (stat.isFile()) {
    const retainedBytes = Math.min(
      queryBudget.remainingBytes,
      SNAPSHOT_QUERY_FILE_MAX_BYTES,
    );
    const fileSnapshot = readFileSnapshot(absPath, entry.path, stat, 0, retainedBytes);
    queryBudget.remainingBytes -= fileSnapshot.queryContent.length;
    fields.push(['contentDigest', fileSnapshot.digest]);
    queryEntry = {
      ...queryEntry,
      kind: 'file',
      contentDigest: fileSnapshot.digest.toString('hex'),
      content: fileSnapshot.queryContent,
      coverage: fileSnapshot.queryTruncated ? 'resource_cap' : 'complete',
    };
  } else if (stat.isDirectory()) {
    queryEntry = { ...queryEntry, coverage: 'complete' };
  }

  return {
    path: entry.path,
    record: normalizeRecord(fields),
    sortOrder: 0,
    stage: entry.stage,
    queryEntry: protectUnsupportedPathEncoding(entry.path, queryEntry),
  };
}

function displayRepositoryPath(path: Buffer): string {
  const decoded = path.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(path) ? decoded : displayPath(path);
}

export function protectUnsupportedPathEncoding(
  path: Buffer,
  entry: ReviewScopeQueryInventoryEntry,
): ReviewScopeQueryInventoryEntry {
  const decoded = path.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(path)) {
    return entry;
  }
  const withoutContent = { ...entry };
  delete withoutContent.content;
  return {
    ...withoutContent,
    path: displayPath(path),
    coverage: 'unsupported_path_encoding',
  };
}

function encodePreview(preview: Buffer): Pick<ReviewScopeUntrackedEvidence, 'content' | 'contentEncoding'> {
  const decoded = preview.toString('utf8');
  if (Buffer.from(decoded, 'utf8').equals(preview) && !decoded.includes('\0')) {
    return { content: decoded, contentEncoding: 'utf8' };
  }
  return { content: preview.toString('base64'), contentEncoding: 'base64' };
}

function untrackedSnapshotEntry(
  cwd: string,
  path: Buffer,
  visitedDirectories: Set<string>,
  previewBudget: PreviewBudget,
  queryBudget: QueryBudget,
): SnapshotEntry {
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
  let untrackedEvidence: ReviewScopeUntrackedEvidence = {
    path: displayRepositoryPath(path),
    kind: fileKind(stat),
  };
  let queryEntry: ReviewScopeQueryInventoryEntry = {
    path: displayRepositoryPath(path),
    kind: fileKind(stat),
    coverage: 'unsupported_kind',
  };
  if (stat.isSymbolicLink()) {
    const target = readSymlinkTarget(absPath, path);
    fields.push(['symlinkTarget', target]);
    untrackedEvidence = {
      ...untrackedEvidence,
      contentDigest: createHash('sha256').update(target).digest('hex'),
    };
  } else if (stat.isFile()) {
    const retainedBytes = Math.min(
      queryBudget.remainingBytes,
      SNAPSHOT_QUERY_FILE_MAX_BYTES,
    );
    const fileSnapshot = readFileSnapshot(
      absPath,
      path,
      stat,
      previewBudget.remainingBytes,
      retainedBytes,
    );
    previewBudget.remainingBytes -= fileSnapshot.preview.length;
    queryBudget.remainingBytes -= fileSnapshot.queryContent.length;
    fields.push(['contentDigest', fileSnapshot.digest]);
    untrackedEvidence = {
      ...untrackedEvidence,
      contentDigest: fileSnapshot.digest.toString('hex'),
      ...encodePreview(fileSnapshot.preview),
      ...(fileSnapshot.truncated ? { truncated: true } : {}),
    };
    queryEntry = {
      ...queryEntry,
      kind: 'file',
      contentDigest: fileSnapshot.digest.toString('hex'),
      content: fileSnapshot.queryContent,
      coverage: fileSnapshot.queryTruncated ? 'resource_cap' : 'complete',
    };
  } else if (stat.isDirectory()) {
    let digest: string;
    try {
      digest = computeStableSnapshot(decodeRepositoryPath(absPath), visitedDirectories, false).reviewScopeSnapshotId;
    } catch (cause) {
      return fail('embedded repository digest', displayPath(path), cause);
    }
    fields.push(['embeddedRepositoryWorkingTreeDigest', digest]);
    untrackedEvidence = { ...untrackedEvidence, contentDigest: digest };
    queryEntry = { ...queryEntry, kind: 'embedded_repository' };
  }

  return {
    path,
    record: normalizeRecord(fields),
    sortOrder: 1,
    stage: Buffer.alloc(0),
    untrackedEvidence,
    queryEntry: protectUnsupportedPathEncoding(path, queryEntry),
  };
}

function excludedSnapshotEntry(cwd: string, path: Buffer): SnapshotEntry {
  const absPath = absolutePath(cwd, path);
  const stat = lstatPath(absPath, path, false);
  return {
    path,
    record: normalizeRecord([
      ['path', path],
      ['tracked', 0],
      ['excluded', 1],
      ['kind', fileKind(stat)],
      ['actualMode', actualMode(stat)],
    ]),
    sortOrder: 2,
    stage: Buffer.alloc(0),
    queryEntry: protectUnsupportedPathEncoding(path, {
      path: displayRepositoryPath(path),
      kind: fileKind(stat),
      coverage: 'excluded',
    }),
  };
}

function boundedTrackedDiff(cwd: string): string | undefined {
  const args = ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'];
  let output: Buffer;
  try {
    output = executeGit(cwd, args, SNAPSHOT_DIFF_CAPTURE_MAX_BYTES);
  } catch (cause) {
    if (!isGitOutputLimitError(cause)) {
      return fail(`git ${args.join(' ')}`, cwd, cause);
    }
    const summary = runGit(cwd, ['diff', '--no-ext-diff', '--stat', 'HEAD', '--'])
      .toString('utf8')
      .trim();
    return `Tracked diff exceeded the ${SNAPSHOT_DIFF_CAPTURE_MAX_BYTES}-byte capture limit.\n${summary}`;
  }
  const trimmed = output.toString('utf8').trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const truncated = truncateUtf8(trimmed, SNAPSHOT_DIFF_MAX_BYTES);
  if (truncated.bytes === Buffer.byteLength(trimmed, 'utf8')) {
    return trimmed;
  }
  return `${truncated.value}\n... (truncated; full state is bound by reviewScopeSnapshotId)`;
}

function captureSnapshot(
  cwd: string,
  visitedDirectories: Set<string>,
  includeEvidence: boolean,
  baseRange: ReviewScopeBaseRange,
): CapturedSnapshot {
  const trackedOutput = runGit(cwd, ['ls-files', '--cached', '--stage', '-z']);
  const untrackedOutput = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const excludedOutput = runGit(
    cwd,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
  );
  const head = runGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  const tracked = parseNulEntries(trackedOutput, 'git ls-files --cached --stage -z parse', cwd)
    .map((record) => parseTrackedEntry(record, cwd));
  const untracked = parseNulEntries(untrackedOutput, 'git ls-files --others --exclude-standard -z parse', cwd);
  // 証拠検証のスコープとレビュアーへ提示するスコープは同じ計算でなければならない。
  // untracked は上で読んだものをそのまま渡し、inventory と changedPaths の由来を
  // 同一瞬間の読み取りへ揃える。
  // review-scope 側の例外（spawn 失敗・非 UTF-8 パス等）は素の Error なので、
  // ここで snapshot の失敗分類へ統合する。経路によって失敗の型が変わらないようにする。
  let taskScope: TaskReviewScope;
  try {
    taskScope = collectTaskReviewScope({
      cwd,
      baseRange,
      untracked: untracked.map((path) => decodeRepositoryPath(path)),
    });
  } catch (cause) {
    return fail('review scope', cwd, cause);
  }
  if (taskScope.kind !== 'collected') {
    return fail('review scope', cwd, new Error('review scope requires a git repository'));
  }
  const changedPaths = taskScope.paths;
  const excluded = parseNulEntries(
    excludedOutput,
    'git ls-files --others --ignored --exclude-standard --directory -z parse',
    cwd,
  );
  const previewBudget: PreviewBudget = {
    remainingBytes: includeEvidence ? SNAPSHOT_UNTRACKED_CONTENT_MAX_BYTES : 0,
  };
  const queryBudget: QueryBudget = {
    remainingBytes: includeEvidence ? SNAPSHOT_QUERY_CONTENT_MAX_BYTES : 0,
  };
  const entries = [
    ...tracked.map((entry) => trackedSnapshotEntry(cwd, entry, visitedDirectories, queryBudget)),
    ...untracked.map((path) => (
      untrackedSnapshotEntry(cwd, path, visitedDirectories, previewBudget, queryBudget)
    )),
    ...excluded.map((path) => excludedSnapshotEntry(cwd, path)),
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
  const trackedDiff = includeEvidence ? boundedTrackedDiff(cwd) : undefined;
  const untrackedEvidence = includeEvidence
    ? entries.flatMap((entry) => (
      entry.untrackedEvidence === undefined ? [] : [entry.untrackedEvidence]
    ))
    : [];
  const presentationDigest = createHash('sha256')
    .update(trackedDiff ?? '')
    .update(JSON.stringify(untrackedEvidence))
    .update(JSON.stringify(changedPaths))
    .digest('hex');
  return {
    inventory,
    snapshotId: hash.digest('hex'),
    trackedDiff,
    untrackedEvidence,
    presentationDigest,
    queryInventory: entries.map((entry) => ({
      ...entry.queryEntry,
      ...(entry.queryEntry.content === undefined
        ? {}
        : { content: Buffer.from(entry.queryEntry.content) }),
    })),
    changedPaths: [...changedPaths],
  };
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

function computeStableSnapshot(
  cwd: string,
  visitedDirectories: Set<string>,
  includeEvidence: boolean,
): ReviewScopeProofSnapshot {
  const identity = captureDirectoryIdentity(cwd);
  if (visitedDirectories.has(identity)) {
    return fail('capture recursion', cwd, new Error('directory cycle detected'));
  }
  visitedDirectories.add(identity);
  try {
    // base はブランチの分岐点なのでキャプチャ間で動かない。ref 走査を伴うため
    // この cwd につき一度だけ解決し、2回のキャプチャで共有する。
    // try の内側で解決する: 例外時も finally が visitedDirectories を掃除する。
    let baseRange: ReviewScopeBaseRange;
    try {
      baseRange = resolveReviewScopeBaseRange(cwd);
    } catch (cause) {
      return fail('review scope', cwd, cause);
    }
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      const first = captureSnapshot(cwd, visitedDirectories, includeEvidence, baseRange);
      const second = captureSnapshot(cwd, visitedDirectories, includeEvidence, baseRange);
      if (first.snapshotId === second.snapshotId
        && first.inventory.equals(second.inventory)
        && first.presentationDigest === second.presentationDigest) {
        return {
          reviewScopeSnapshotId: second.snapshotId,
          trackedDiff: second.trackedDiff,
          untrackedEvidence: second.untrackedEvidence,
          queryInventory: second.queryInventory.map((entry) => ({
            ...entry,
            ...(entry.content === undefined ? {} : { content: Buffer.from(entry.content) }),
          })),
          changedPaths: [...second.changedPaths],
        };
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
  return computeStableSnapshot(cwd, new Set(), false).reviewScopeSnapshotId;
}

export function captureReviewScopeSnapshot(cwd: string): ReviewScopeSnapshot {
  const snapshot = computeStableSnapshot(cwd, new Set(), true);
  return {
    reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
    trackedDiff: snapshot.trackedDiff,
    untrackedEvidence: snapshot.untrackedEvidence,
  };
}

export function captureReviewScopeProofSnapshot(cwd: string): ReviewScopeProofSnapshot {
  return computeStableSnapshot(cwd, new Set(), true);
}
