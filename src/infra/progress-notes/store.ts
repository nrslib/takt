import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { excludeProgressNotesPaths, excludeProgressNotesScope, progressNotesDirectory, type ProgressNotesRequest } from '../../core/workflow/progress-notes.js';
import type { TaskReviewScope } from '../../core/workflow/review-scope.js';
import {
  ensurePrivateDirectory, PrivateArtifactContentWriteFailedError, PrivateArtifactPublicationConflictError, readPrivateFileState, writePrivateFile,
} from '../../shared/utils/private-file.js';
import { NonUtf8GitPathError, parseGitNulPaths } from '../../shared/utils/gitNulPaths.js';
import { artifactBoundary, assertSafePath, UnsafePrivateArtifactPathError } from '../../shared/utils/private-path-identity.js';
import { buildReviewGitEnvironment } from '../task/review-git-environment.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export const PROGRESS_NOTES_MAX_CHARS = 32 * 1024;
const TRUNCATED = '[Earlier progress notes omitted; this is not complete coverage.]\n';

export class ProgressNotesUnavailableError extends Error {}

/**
 * Failures that describe the environment rather than the code: a system call error, a Git process that
 * exits or is killed, an unsafe, changed or unwritable private file, or a repository path that is not
 * UTF-8. Everything else (TypeError, an invariant broken in a helper) is a programming mistake.
 */
function isEnvironmentFailure(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.every(isEnvironmentFailure);
  if (error instanceof UnsafePrivateArtifactPathError || error instanceof PrivateArtifactPublicationConflictError
    || error instanceof PrivateArtifactContentWriteFailedError || error instanceof NonUtf8GitPathError) return true;
  if (!(error instanceof Error)) return false;
  const { syscall, status, signal } = error as Error & { syscall?: unknown; status?: unknown; signal?: unknown };
  return typeof syscall === 'string' || typeof status === 'number' || typeof signal === 'string';
}

/**
 * Runs one filesystem or Git operation of the store. Environment failures make the notes unavailable;
 * anything else propagates, as do the store's own checks outside these operations.
 */
function storageOperation<T>(description: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProgressNotesUnavailableError || !isEnvironmentFailure(error)) throw error;
    throw new ProgressNotesUnavailableError(`${description} failed`, { cause: error });
  }
}

function assertNotesPath(path: string, isDirectory: boolean): void {
  storageOperation('Progress notes path check', () => {
    // Unlike other private artifacts, progress notes must not follow even
    // ancestors above .takt: their lexical paths also define Git exclusions.
    assertSafePath(artifactBoundary(path).trustedRoot, true);
    assertSafePath(path, isDirectory);
  });
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function repositoryHead(git: (args: string[]) => Buffer): Buffer | undefined {
  try {
    return git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw error;
    // A missing revision alone can also mean a damaged ref, not an unborn branch.
    const ref = git(['symbolic-ref', 'HEAD']).toString('utf8').trim();
    if (!ref.startsWith('refs/heads/')) throw error;
    try {
      git(['show-ref', '--verify', '--quiet', ref]);
    } catch (refError) {
      if ((refError as { status?: unknown }).status === 1) return undefined;
      throw refError;
    }
    throw error;
  }
}

// An input that vanishes or is replaced while being fingerprinted belongs to a different revision;
// tools and sibling steps may still be writing.
function inputChanged(path: string): ProgressNotesUnavailableError {
  return new ProgressNotesUnavailableError(`Source input changed: ${path}`);
}

/** Returns false for a non-regular entry, whose contents cannot be fingerprinted safely. */
function hashUntrackedFile(hash: Hash, cwd: string, path: string): boolean {
  const absolute = resolve(cwd, path);
  const expected = lstatSync(absolute);
  if (expected.isSymbolicLink()) {
    const target = readlinkSync(absolute, { encoding: 'buffer' });
    hash.update(JSON.stringify([path, 'symlink', expected.mode, target.length])).update('\n').update(target);
    return true;
  }
  if (!expected.isFile()) return false;
  // Do not follow a replacement symlink or block if the path becomes a FIFO.
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw inputChanged(path);
    hash.update(JSON.stringify([path, 'file', stat.mode, stat.size])).update('\n');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < stat.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - total), null);
      if (count === 0) throw inputChanged(path);
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== stat.size || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw inputChanged(path);
    }
  } finally { closeSync(descriptor); }
  return true;
}

function hashTrackedDiff(hash: Hash, cwd: string, env: NodeJS.ProcessEnv, args: string[], kind: string): void {
  storageOperation(`Git ${kind} diff`, () => {
    // Stream Git into a private spool to keep synchronous note capture bounded without
    // introducing an asynchronous, unbounded queue behind provider callbacks.
    const directory = mkdtempSync(join(tmpdir(), 'takt-progress-notes-diff-'));
    try {
      const descriptor = openSync(join(directory, 'diff'), 'wx+', 0o600);
      try {
        execFileSync('git', args, { cwd, env, stdio: ['ignore', descriptor, 'pipe'], maxBuffer: 64 * 1024 });
        const size = fstatSync(descriptor).size;
        hash.update(JSON.stringify([kind, size])).update('\n');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < size) {
          const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
          if (count === 0) throw new ProgressNotesUnavailableError('Git diff spool ended early');
          hash.update(buffer.subarray(0, count));
          position += count;
        }
      } finally { closeSync(descriptor); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

/** Progress notes are outputs, never inputs, even when the run directory is not gitignored. */
function repositorySnapshot(cwd: string, reportDir: string, env: NodeJS.ProcessEnv, scope: TaskReviewScope) {
  const notesDirectory = progressNotesDirectory(reportDir);
  const safeArgs = ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false'];
  const runGit = (args: string[]): Buffer => execFileSync('git', [...safeArgs, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const git = (args: string[]): Buffer => storageOperation(`git ${args[0]}`, () => runGit(args));
  const diffRange = scope.kind === 'collected' && scope.source.kind === 'pull_request'
    ? scope.source.diffRange : undefined;
  const pullRequestOids = diffRange === undefined ? undefined : {
    base: git(['rev-parse', '--verify', '--end-of-options', `${diffRange.baseDiffRef}^{commit}`]).toString('utf8').trim(),
    head: git(['rev-parse', '--verify', '--end-of-options', `${diffRange.headDiffRef}^{commit}`]).toString('utf8').trim(),
  };
  // Inspect only the parent index. Probing child dirtiness can execute child filters, while
  // ignoring it would give different submodule contents one revision; report it as unchecked.
  const tracked = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0');
  if (tracked.some((entry) => entry.startsWith('160000 '))) return { revision: null, pullRequestOids };
  const hash = createHash('sha256').update('progress-notes-revision-v1\n');
  if (pullRequestOids !== undefined) hash.update(JSON.stringify(pullRequestOids)).update('\n');
  const excluded = relative(resolve(cwd), resolve(notesDirectory));
  const pathspec = excluded !== '..' && !excluded.startsWith(`..${sep}`) && !isAbsolute(excluded)
    ? [`:(exclude,literal)${excluded.split(sep).join('/')}`] : [];
  const head = storageOperation('git HEAD lookup', () => repositoryHead(runGit));
  hash.update(head === undefined ? 'unborn\n' : head);
  // A net HEAD-to-worktree diff hides index-only changes. Keep both layers
  // distinct, including before HEAD exists (--cached then uses the empty tree).
  for (const kind of ['staged', 'unstaged'] as const) {
    // Safe Git disables pathspec magic; only this internal literal exclusion needs it.
    hashTrackedDiff(hash, cwd, env, [...safeArgs, '--no-literal-pathspecs',
      'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--binary',
      ...(kind === 'staged' ? ['--cached'] : []), '--', ...pathspec], kind);
  }
  const untracked = storageOperation('Untracked input listing', () => parseGitNulPaths(git(['ls-files', '--others', '--exclude-standard', '-z']), 'git ls-files --others')).sort();
  const inputs = excludeProgressNotesPaths(untracked, cwd, reportDir);
  for (const path of inputs) {
    if (!storageOperation('Untracked input fingerprint', () => hashUntrackedFile(hash, cwd, path))) return { revision: null, pullRequestOids };
  }
  return { revision: hash.digest('hex'), pullRequestOids };
}

interface SourceRevisionInputs {
  readonly repositoryRoot: string;
  readonly reportDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly scope: TaskReviewScope;
}

function sourceRevisionInputs(cwd: string, reportDir: string, scope: TaskReviewScope): SourceRevisionInputs {
  const { env, repositoryRoot } = storageOperation('Git repository discovery', () => {
    const reviewEnv = buildReviewGitEnvironment(cwd);
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, env: reviewEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
    return { env: reviewEnv, repositoryRoot: root };
  });
  return { repositoryRoot, reportDir, env, scope: excludeProgressNotesScope(scope, repositoryRoot, reportDir) };
}

function currentSourceRevision(inputs: SourceRevisionInputs) {
  return repositorySnapshot(inputs.repositoryRoot, inputs.reportDir, inputs.env, inputs.scope);
}

export interface CreatedProgressNotes {
  readonly store: ProgressNotesStore;
  readonly log: string | undefined;
}

export class ProgressNotesStore {
  readonly path: string;
  /**
   * `revision` is null when TAKT does not check the sources: an editing step, work outside Git, or
   * sources it cannot fingerprint (a submodule or a non-regular untracked entry).
   */
  readonly target: { readonly identity: string; readonly revision: string | null };
  private readonly source: SourceRevisionInputs | undefined;

  /**
   * Also returns the log found at creation. Creating the store just computed the source revision that
   * names the log, so the log needs no second revision check.
   */
  static async create(
    cwd: string,
    request: ProgressNotesRequest,
    instruction: string,
  ): Promise<CreatedProgressNotes> {
    const store = new ProgressNotesStore(cwd, request, instruction);
    return { store, log: store.readLog() };
  }

  private constructor(cwd: string, request: ProgressNotesRequest, instruction: string) {
    const directory = storageOperation('Progress notes path resolution', () => progressNotesDirectory(request.reportDir));
    assertNotesPath(directory, true);
    const stepIdentity = {
      cwd: resolve(cwd),
      reportDir: request.reportDir,
      task: request.task,
      stepName: request.stepName,
      definition: request.definition,
      bindsSourceRevision: request.bindsSourceRevision,
      instruction,
    };
    if (request.bindsSourceRevision && request.scope.kind === 'collected') {
      const source = sourceRevisionInputs(cwd, request.reportDir, request.scope);
      const snapshot = currentSourceRevision(source);
      // Unchecked sources have nothing to validate against later; the agent checks the current state.
      this.source = snapshot.revision === null ? undefined : source;
      this.target = {
        identity: digest(JSON.stringify({ ...stepIdentity, scope: source.scope, pullRequestOids: snapshot.pullRequestOids })),
        revision: snapshot.revision,
      };
    } else {
      // An editing step changes its own diff and scope, and outside Git there is no revision to
      // bind; neither may be invented, so the log follows the step identity alone.
      this.source = undefined;
      this.target = { identity: digest(JSON.stringify(stepIdentity)), revision: null };
    }
    assertNotesPath(directory, true);
    storageOperation('Progress notes directory creation', () => ensurePrivateDirectory(directory));
    this.path = join(directory, `${digest(JSON.stringify(this.target))}.log`);
    assertNotesPath(this.path, false);
  }

  read(): string | undefined {
    const log = this.readLog();
    // Only an existing log needs the fingerprint. An edited diff is a different target, not evidence of a stalled step.
    if (log === undefined || !this.matchesSourceRevision()) return undefined;
    return log;
  }

  private matchesSourceRevision(): boolean {
    return this.source === undefined || currentSourceRevision(this.source).revision === this.target.revision;
  }

  private readLog(): string | undefined {
    assertNotesPath(this.path, false);
    const file = storageOperation('Progress notes read', () => readPrivateFileState(this.path));
    return 'content' in file ? file.content.toString('utf8') : undefined;
  }

  /** Returns the sanitized log as saved after validating the current source revision. */
  append(note: string): string {
    this.assertCurrentTarget();
    return this.writeLog(`${this.readLog() ?? ''}${note}`);
  }

  private assertCurrentTarget(): void {
    assertNotesPath(this.path, false);
    // A step that cannot edit may still see sources change (tools, sibling steps).
    // Stop trusting its log without failing the step's own work.
    if (!this.matchesSourceRevision()) throw new ProgressNotesUnavailableError('Source revision changed; progress notes were not saved');
  }

  private writeLog(log: string): string {
    const sanitized = sanitizeSensitiveText(log);
    const saved = sanitized.length > PROGRESS_NOTES_MAX_CHARS
      ? TRUNCATED + sanitized.slice(-(PROGRESS_NOTES_MAX_CHARS - TRUNCATED.length))
      : sanitized;
    assertNotesPath(this.path, false);
    storageOperation('Progress notes write', () => writePrivateFile(this.path, saved));
    return saved;
  }
}
