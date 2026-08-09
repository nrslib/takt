import { spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, opendir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type {
  CompanionDiff,
  CompanionDiffReadFailureCode,
  CompanionDiffReadResult,
  CompanionDiffReader,
} from '../../core/workflow/companion/diff-reader.js';
import { buildSafeGitEnvironment } from './git-environment.js';

const MAX_COMPANION_DIFF_BYTES = 512 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxChangedFiles: 1_024,
  maxBlobBytes: 4 * 1024 * 1024,
  maxTotalInputBytes: 16 * 1024 * 1024,
  maxTemporaryBytes: 24 * 1024 * 1024,
  maxStdoutBytes: 32 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxSubprocesses: 4_096,
  timeoutMs: 30_000,
});

interface CompanionDiffLimits {
  readonly maxChangedFiles: number;
  readonly maxBlobBytes: number;
  readonly maxTotalInputBytes: number;
  readonly maxTemporaryBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxSubprocesses: number;
  readonly timeoutMs: number;
}

class CompanionDiffResourceError extends Error {
  constructor(
    readonly code: CompanionDiffReadFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompanionDiffResourceError';
  }
}

class BoundedDiffAccumulator {
  private readonly hash = createHash('sha256');
  private readonly retained: Buffer[] = [];
  private retainedBytes = 0;
  private linePrefix: number[] = [];
  totalBytes = 0;
  changedLines = 0;

  append(value: string | Buffer): void {
    const buffer = typeof value === 'string' ? Buffer.from(value) : value;
    this.hash.update(buffer);
    this.totalBytes += buffer.length;
    if (this.retainedBytes < MAX_COMPANION_DIFF_BYTES) {
      const available = MAX_COMPANION_DIFF_BYTES - this.retainedBytes;
      const part = buffer.subarray(0, available);
      this.retained.push(part);
      this.retainedBytes += part.length;
    }
    for (const byte of buffer) {
      if (byte === 0x0a) this.finishLine();
      else if (this.linePrefix.length < 3) this.linePrefix.push(byte);
    }
  }

  finish(): { content: string; digest: string; omittedBytes: number; truncated: boolean } {
    if (this.linePrefix.length > 0) this.finishLine();
    const retained = Buffer.concat(this.retained);
    const normalized = Buffer.from(retained.toString('utf8'), 'utf8');
    const unretainedBytes = this.totalBytes - this.retainedBytes;
    const displayExpansion = retained.length === 0 ? 1 : normalized.length / retained.length;
    const displayBytes = normalized.length + Math.ceil(unretainedBytes * displayExpansion);
    if (displayBytes <= MAX_COMPANION_DIFF_BYTES) {
      return {
        content: normalized.toString('utf8'),
        digest: this.hash.digest('hex'),
        omittedBytes: 0,
        truncated: false,
      };
    }
    const marker = omissionMarker(displayBytes);
    const contentBudget = MAX_COMPANION_DIFF_BYTES - marker.length;
    return {
      content: decodeCompleteUtf8(normalized, contentBudget) + marker.toString('utf8'),
      digest: this.hash.digest('hex'),
      omittedBytes: displayBytes - contentBudget,
      truncated: true,
    };
  }

  private finishLine(): void {
    const first = this.linePrefix[0];
    const isHeader = this.linePrefix.length >= 3
      && this.linePrefix[0] === this.linePrefix[1]
      && this.linePrefix[1] === this.linePrefix[2];
    if ((first === 0x2b || first === 0x2d) && !isHeader) this.changedLines += 1;
    this.linePrefix = [];
  }
}

interface FrozenIndex {
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
}

interface FileMetadata {
  readonly fingerprint: string;
  readonly hunkFingerprints: Readonly<Record<string, string>>;
}

interface FrozenIndexEntry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly oid: string;
}

interface CompanionDiffObservation {
  readonly afterFrozenIndex?: (root: string) => Promise<void>;
}

class BoundedGitRunner {
  private subprocesses = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private readonly deadline: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly cwd: string,
    private readonly limits: CompanionDiffLimits,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.deadline = Date.now() + limits.timeoutMs;
    const environment = buildSafeGitEnvironment(cwd, {
      allowGitHooks: false,
      allowGitFilters: false,
    });
    this.environment = environment;
  }

  async text(args: readonly string[], environment: NodeJS.ProcessEnv = this.environment): Promise<string> {
    const chunks: Buffer[] = [];
    await this.stream(args, environment, (chunk) => chunks.push(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  async stream(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    onStdout: (chunk: Buffer) => void,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    this.subprocesses += 1;
    if (this.subprocesses > this.limits.maxSubprocesses) {
      throw new CompanionDiffResourceError('process_limit', 'Companion Git subprocess limit exceeded');
    }
    const remainingMs = this.deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CompanionDiffResourceError('timeout', 'Companion diff collection timed out');
    }
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('git', [...args], {
        cwd: this.cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderr: Buffer[] = [];
      let failure: Error | undefined;
      const fail = (error: Error): void => {
        if (failure !== undefined) return;
        failure = error;
        child.kill();
      };
      const onAbort = (): void => {
        fail(new CompanionDiffResourceError('aborted', 'Companion diff collection was aborted'));
      };
      const timer = setTimeout(() => {
        fail(new CompanionDiffResourceError('timeout', 'Companion diff collection timed out'));
      }, remainingMs);
      this.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBytes += chunk.length;
        if (this.stdoutBytes > this.limits.maxStdoutBytes) {
          fail(new CompanionDiffResourceError('stdout_limit', 'Companion Git stdout limit exceeded'));
          return;
        }
        try {
          onStdout(chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrBytes += chunk.length;
        if (this.stderrBytes > this.limits.maxStderrBytes) {
          fail(new CompanionDiffResourceError('stderr_limit', 'Companion Git stderr limit exceeded'));
          return;
        }
        stderr.push(chunk);
      });
      child.on('error', (error) => fail(new CompanionDiffResourceError('git_failure', error.message)));
      child.on('close', (code) => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
        if (failure !== undefined) reject(failure);
        else if (code === 0) resolvePromise();
        else reject(new CompanionDiffResourceError('git_failure', gitErrorMessage(args, stderr)));
      });
    });
  }

  withEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...this.environment, ...overrides };
  }

  environmentValue(name: string): string | undefined {
    return this.environment[name];
  }
}

async function appendGitOutput(input: {
  runner: BoundedGitRunner;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  accumulator: BoundedDiffAccumulator;
  hash?: Hash;
}): Promise<void> {
  await input.runner.stream(input.args, input.environment, (chunk) => {
    input.accumulator.append(chunk);
    input.hash?.update(chunk);
  });
}

async function collectTrackedMetadata(
  runner: BoundedGitRunner,
  baselineSha: string,
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<FileMetadata> {
  const args = [
    'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--unified=0',
    baselineSha, '--', path,
  ];
  const hash = createHash('sha256');
  const hunks = new HunkFingerprintCollector(path);
  await runner.stream(args, environment, (chunk) => {
    hash.update(chunk);
    hunks.append(chunk);
  });
  return { fingerprint: hash.digest('hex'), hunkFingerprints: hunks.finish() };
}

export class GitCompanionDiffReader implements CompanionDiffReader {
  private readonly limits: CompanionDiffLimits;

  constructor(
    limits: Partial<CompanionDiffLimits> = {},
    private readonly observation: CompanionDiffObservation = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async readBaselineSha(cwd: string, signal?: AbortSignal): Promise<string> {
    const runner = new BoundedGitRunner(cwd, this.limits, signal);
    return (await runner.text(['rev-parse', '--verify', 'HEAD'])).trim();
  }

  async readDiff(
    cwd: string,
    baselineSha: string,
    signal?: AbortSignal,
  ): Promise<CompanionDiffReadResult> {
    const runner = new BoundedGitRunner(cwd, this.limits, signal);
    let frozen: FrozenIndex | undefined;
    try {
      const changedPaths = await collectChangedPaths(runner, baselineSha);
      await validateInputs(runner, cwd, baselineSha, changedPaths, this.limits);
      frozen = await createFrozenIndex(runner, cwd, baselineSha, changedPaths);
      await this.observation.afterFrozenIndex?.(frozen.root);
      await enforceTemporaryStorageLimit(frozen.root, this.limits.maxTemporaryBytes);
      return {
        status: 'ok',
        snapshot: await readFrozenDiff(runner, baselineSha, frozen.environment),
      };
    } catch (error) {
      return { status: 'error', failure: diffFailure(error) };
    } finally {
      if (frozen !== undefined) await rm(frozen.root, { recursive: true, force: true });
    }
  }
}

async function collectChangedPaths(
  runner: BoundedGitRunner,
  baselineSha: string,
): Promise<string[]> {
  const tracked = splitNull(await runner.text([
    'diff', '--no-renames', '--name-only', '-z', baselineSha, '--',
  ]));
  const untracked = splitNull(await runner.text([
    'ls-files', '--others', '--exclude-standard', '-z', '--',
  ]));
  return [...new Set([...tracked, ...untracked])];
}

async function validateInputs(
  runner: BoundedGitRunner,
  cwd: string,
  baselineSha: string,
  paths: readonly string[],
  limits: CompanionDiffLimits,
): Promise<void> {
  if (paths.length > limits.maxChangedFiles) {
    throw new CompanionDiffResourceError(
      'file_count_limit',
      `Companion changed file count exceeds ${limits.maxChangedFiles}`,
    );
  }
  let totalBytes = 0;
  for (const path of paths) {
    const baselineBytes = await readBaselineBlobSize(runner, baselineSha, path);
    assertBlobSize(path, baselineBytes, limits.maxBlobBytes);
    totalBytes = addInputBytes(totalBytes, baselineBytes, limits.maxTotalInputBytes);
    let stats;
    try {
      stats = await lstat(join(cwd, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new CompanionDiffResourceError('input_limit', `Unsupported companion diff input: ${path}`);
    }
    assertBlobSize(path, stats.size, limits.maxBlobBytes);
    totalBytes = addInputBytes(totalBytes, stats.size, limits.maxTotalInputBytes);
  }
}

async function readBaselineBlobSize(
  runner: BoundedGitRunner,
  baselineSha: string,
  path: string,
): Promise<number> {
  const entry = (await runner.text(['ls-tree', '-l', '-z', baselineSha, '--', path]))
    .split('\0', 1)[0];
  if (entry === undefined || entry.length === 0) return 0;
  const separator = entry.indexOf('\t');
  if (separator === -1) {
    throw new CompanionDiffResourceError('git_failure', 'Malformed git ls-tree output');
  }
  const [mode, type, , sizeText] = entry.slice(0, separator).split(/\s+/u);
  const size = Number(sizeText);
  if (mode === undefined || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
    throw new CompanionDiffResourceError(
      'input_limit',
      `Unsupported companion baseline input: ${path}`,
    );
  }
  return size;
}

function assertBlobSize(path: string, size: number, maxBlobBytes: number): void {
  if (size <= maxBlobBytes) return;
  throw new CompanionDiffResourceError(
    'blob_limit',
    `Companion diff blob exceeds ${maxBlobBytes} bytes: ${path}`,
  );
}

function addInputBytes(total: number, size: number, maxTotalInputBytes: number): number {
  const next = total + size;
  if (next > maxTotalInputBytes) {
    throw new CompanionDiffResourceError(
      'input_limit',
      `Companion diff input exceeds ${maxTotalInputBytes} bytes`,
    );
  }
  return next;
}

async function createFrozenIndex(
  runner: BoundedGitRunner,
  cwd: string,
  baselineSha: string,
  changedPaths: readonly string[],
): Promise<FrozenIndex> {
  const root = await mkdtemp(join(tmpdir(), 'takt-companion-index-'));
  const objectDirectory = join(root, 'objects');
  await mkdir(objectDirectory);
  const repositoryObjectPath = (await runner.text(['rev-parse', '--git-path', 'objects'])).trim();
  const repositoryObjectDirectory = isAbsolute(repositoryObjectPath)
    ? repositoryObjectPath
    : resolve(cwd, repositoryObjectPath);
  const inheritedAlternates = runner.environmentValue('GIT_ALTERNATE_OBJECT_DIRECTORIES');
  const environment = runner.withEnvironment({
    GIT_INDEX_FILE: join(root, 'index'),
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [repositoryObjectDirectory, inheritedAlternates]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter),
  });
  try {
    await runner.text(['read-tree', baselineSha], environment);
    if (changedPaths.length > 0) {
      await runner.text(['add', '-A', '--', ...changedPaths], environment);
    }
    return { environment, root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function enforceTemporaryStorageLimit(root: string, maxBytes: number): Promise<void> {
  let totalBytes = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      totalBytes += (await lstat(path)).size;
      if (totalBytes > maxBytes) {
        throw new CompanionDiffResourceError(
          'temporary_storage_limit',
          `Companion temporary storage exceeds ${maxBytes} bytes`,
        );
      }
    }
  }
}

async function readFrozenDiff(
  runner: BoundedGitRunner,
  baselineSha: string,
  environment: NodeJS.ProcessEnv,
): Promise<CompanionDiff> {
  const changedFiles = splitNull(await runner.text([
    'diff', '--cached', '--no-renames', '--name-only', '-z', baselineSha, '--',
  ], environment));
  const addedFiles = new Set(splitNull(await runner.text([
    'diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '-z', baselineSha, '--',
  ], environment)));
  const accumulator = new BoundedDiffAccumulator();
  await appendGitOutput({
    runner,
    args: [
      'diff', '--cached', '--no-renames', '--diff-filter=MD', '--no-ext-diff',
      '--no-textconv', '--binary', '--unified=3', baselineSha, '--',
    ],
    environment,
    accumulator,
  });

  const fileFingerprints: Record<string, string> = {};
  const hunkFingerprints: Record<string, string> = {};
  for (const path of changedFiles) {
    if (addedFiles.has(path)) {
      const added = await appendAddedFile(runner, path, environment, accumulator);
      fileFingerprints[path] = added.fingerprint;
      Object.assign(hunkFingerprints, added.hunkFingerprints);
      continue;
    }
    const tracked = await collectTrackedMetadata(runner, baselineSha, path, environment);
    fileFingerprints[path] = tracked.fingerprint;
    Object.assign(hunkFingerprints, tracked.hunkFingerprints);
  }
  const result = accumulator.finish();
  return {
    ...result,
    changedFiles,
    changedLines: accumulator.changedLines,
    fileFingerprints,
    hunkFingerprints,
  };
}

async function appendAddedFile(
  runner: BoundedGitRunner,
  path: string,
  environment: NodeJS.ProcessEnv,
  accumulator: BoundedDiffAccumulator,
): Promise<FileMetadata> {
  const entry = await resolveStageZeroBlobEntry(runner, path, environment);
  if (accumulator.totalBytes > 0) accumulator.append('\n');
  accumulator.append([
    `diff --git a/${entry.path} b/${entry.path}`,
    `new file mode ${entry.mode}`,
    '--- /dev/null',
    `+++ b/${entry.path}`,
    '',
  ].join('\n'));
  const fingerprint = createHash('sha256')
    .update(entry.path)
    .update('\0')
    .update(entry.mode)
    .update('\0')
    .update(entry.oid)
    .update('\0');
  const lineCounter = { lines: 0, sawBytes: false, endedWithNewline: true };
  await appendPrefixedBlob(runner, entry, environment, accumulator, fingerprint, lineCounter);
  const changedLineCount = lineCounter.sawBytes ? Math.max(1, lineCounter.lines) : 0;
  const digest = fingerprint.digest('hex');
  return {
    fingerprint: digest,
    hunkFingerprints: changedLineCount === 0 ? {} : {
      [`${path}:1-${changedLineCount}`]: createHash('sha256')
        .update(`${digest}:${changedLineCount}`)
        .digest('hex'),
    },
  };
}

async function appendPrefixedBlob(
  runner: BoundedGitRunner,
  entry: FrozenIndexEntry,
  environment: NodeJS.ProcessEnv,
  accumulator: BoundedDiffAccumulator,
  fingerprint: Hash,
  lineCounter: { lines: number; sawBytes: boolean; endedWithNewline: boolean },
): Promise<void> {
  let atLineStart = true;
  await runner.stream(['cat-file', 'blob', entry.oid], environment, (chunk) => {
    fingerprint.update(chunk);
    lineCounter.sawBytes ||= chunk.length > 0;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (atLineStart) {
        accumulator.append('+');
        atLineStart = false;
      }
      if (chunk[index] !== 0x0a) continue;
      accumulator.append(chunk.subarray(start, index + 1));
      lineCounter.lines += 1;
      start = index + 1;
      atLineStart = true;
    }
    if (start < chunk.length) accumulator.append(chunk.subarray(start));
    lineCounter.endedWithNewline = chunk.at(-1) === 0x0a;
  });
  if (lineCounter.sawBytes && !lineCounter.endedWithNewline) {
    accumulator.append('\n');
    lineCounter.lines += 1;
  }
}

async function resolveStageZeroBlobEntry(
  runner: BoundedGitRunner,
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<FrozenIndexEntry> {
  const entries = splitNull(await runner.text(
    ['ls-files', '--stage', '-z', '--', path],
    environment,
  ));
  const [entry] = entries;
  if (entry === undefined || entries.length !== 1) {
    throw new CompanionDiffResourceError(
      'git_failure',
      `Frozen companion index must contain exactly one entry for added path: ${path}`,
    );
  }
  const separator = entry.indexOf('\t');
  if (separator === -1 || entry.slice(separator + 1) !== path) {
    throw new CompanionDiffResourceError('git_failure', 'Malformed frozen Git index output');
  }
  const [mode, oid, stage, ...unexpected] = entry.slice(0, separator).split(' ');
  const supportedMode = mode === '100644' || mode === '100755' || mode === '120000';
  const validOid = oid !== undefined && (/^[0-9a-f]{40}$/u.test(oid) || /^[0-9a-f]{64}$/u.test(oid));
  if (!supportedMode || !validOid || stage !== '0' || unexpected.length > 0) {
    throw new CompanionDiffResourceError('git_failure', 'Malformed frozen Git index entry');
  }
  return { path, mode, oid };
}

class HunkFingerprintCollector {
  private readonly headerParts: Buffer[] = [];
  private headerBytes = 0;
  private headerCandidate = true;
  private current: { key: string; hash: Hash } | undefined;
  private readonly fingerprints: Record<string, string> = {};

  constructor(private readonly path: string) {}

  append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      this.appendLinePart(chunk.subarray(offset, end), newline !== -1);
      if (newline === -1) return;
      offset = newline + 1;
    }
  }

  finish(): Readonly<Record<string, string>> {
    this.flushHeaderAsContent(false);
    this.finishHunk();
    return this.fingerprints;
  }

  private appendLinePart(part: Buffer, hasNewline: boolean): void {
    if (this.headerCandidate) {
      this.headerParts.push(part);
      this.headerBytes += part.length;
      const prefix = Buffer.concat(this.headerParts, Math.min(this.headerBytes, 2));
      if (
        (prefix.length >= 1 && prefix[0] !== 0x40)
        || (prefix.length >= 2 && prefix[1] !== 0x40)
        || this.headerBytes > 4 * 1024
      ) {
        this.flushHeaderAsContent(hasNewline);
      } else if (hasNewline) {
        this.finishHeaderLine();
      }
      return;
    }
    this.current?.hash.update(part);
    if (hasNewline) {
      this.current?.hash.update('\n');
      this.resetLine();
    }
  }

  private finishHeaderLine(): void {
    const line = Buffer.concat([...this.headerParts, Buffer.from('\n')]);
    const header = parseHunkHeader(line.toString('utf8'));
    if (header === undefined) {
      this.current?.hash.update(line);
    } else {
      this.finishHunk();
      this.current = {
        key: formatHunkKey(this.path, header),
        hash: createHash('sha256'),
      };
      this.current.hash.update(line);
    }
    this.resetLine();
  }

  private flushHeaderAsContent(hasNewline: boolean): void {
    if (this.headerBytes > 0) {
      for (const part of this.headerParts) this.current?.hash.update(part);
    }
    this.headerParts.splice(0);
    this.headerBytes = 0;
    this.headerCandidate = false;
    if (hasNewline) {
      this.current?.hash.update('\n');
      this.resetLine();
    }
  }

  private resetLine(): void {
    this.headerParts.splice(0);
    this.headerBytes = 0;
    this.headerCandidate = true;
  }

  private finishHunk(): void {
    if (this.current === undefined) return;
    this.fingerprints[this.current.key] = this.current.hash.digest('hex');
    this.current = undefined;
  }
}

function parseHunkHeader(value: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(value);
  if (match === null) return undefined;
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? '1'),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? '1'),
  };
}

function formatHunkKey(
  path: string,
  range: { oldStart: number; oldCount: number; newStart: number; newCount: number },
): string {
  if (range.newCount === 0) {
    return `${path}:deleted-${range.oldStart}-${range.oldStart + Math.max(0, range.oldCount - 1)}`;
  }
  return `${path}:${range.newStart}-${range.newStart + Math.max(0, range.newCount - 1)}`;
}

function omissionMarker(totalBytes: number): Buffer {
  let omittedBytes = totalBytes - MAX_COMPANION_DIFF_BYTES;
  for (;;) {
    const marker = Buffer.from(`\n[companion diff omitted ${omittedBytes} bytes]\n`);
    const next = totalBytes - (MAX_COMPANION_DIFF_BYTES - marker.length);
    if (next === omittedBytes) return marker;
    omittedBytes = next;
  }
}

function decodeCompleteUtf8(buffer: Buffer, maxBytes: number): string {
  const bounded = buffer.subarray(0, maxBytes);
  for (let end = bounded.length; end >= Math.max(0, bounded.length - 3); end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bounded.subarray(0, end));
    } catch {
      continue;
    }
  }
  throw new Error('Companion diff UTF-8 normalization failed');
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function gitErrorMessage(args: readonly string[], stderr: readonly Buffer[]): string {
  return `git ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`;
}

function diffFailure(error: unknown): {
  readonly code: CompanionDiffReadFailureCode;
  readonly message: string;
} {
  if (error instanceof CompanionDiffResourceError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'aborted', message: 'Companion diff collection was aborted' };
  }
  return {
    code: 'git_failure',
    message: error instanceof Error ? error.message : String(error),
  };
}
