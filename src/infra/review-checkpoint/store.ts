import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { excludeReviewCheckpointPaths, excludeReviewCheckpointScope, reviewCheckpointDirectory, type ReviewCheckpointContext } from '../../core/workflow/review-checkpoint.js';
import { ensurePrivateDirectory, readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';
import { parseGitNulPaths } from '../../shared/utils/gitNulPaths.js';
import { artifactBoundary, assertSafePath, UnsafePrivateArtifactPathError } from '../../shared/utils/private-path-identity.js';
import { buildReviewGitEnvironment } from '../task/review-git-environment.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

export const REVIEW_LOG_MAX_CHARS = 32 * 1024;
const TRUNCATED = '[Earlier work log omitted; this is not complete coverage.]\n';

export class ReviewCheckpointUnavailableError extends Error {}

function assertCheckpointPath(path: string, isDirectory: boolean): void {
  try {
    // Unlike other private artifacts, checkpoint outputs must not follow even
    // ancestors above .takt: their lexical paths also define Git exclusions.
    assertSafePath(artifactBoundary(path).trustedRoot, true);
    assertSafePath(path, isDirectory);
  } catch (error) {
    if (!(error instanceof UnsafePrivateArtifactPathError)) throw error;
    throw new ReviewCheckpointUnavailableError('Review checkpoint path is unsafe', { cause: error });
  }
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

function hashUntrackedFile(hash: Hash, cwd: string, path: string): void {
  const absolute = resolve(cwd, path);
  const expected = lstatSync(absolute);
  if (expected.isSymbolicLink()) {
    const target = readlinkSync(absolute, { encoding: 'buffer' });
    hash.update(JSON.stringify([path, 'symlink', expected.mode, target.length])).update('\n').update(target);
    return;
  }
  if (!expected.isFile()) throw new ReviewCheckpointUnavailableError('Non-regular review inputs cannot be fingerprinted safely');
  // Do not follow a replacement symlink or block if the path becomes a FIFO.
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error(`Review input changed: ${path}`);
    hash.update(JSON.stringify([path, 'file', stat.mode, stat.size])).update('\n');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < stat.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - total), null);
      if (count === 0) throw new Error(`Review input changed: ${path}`);
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== stat.size || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error(`Review input changed: ${path}`);
    }
  } finally { closeSync(descriptor); }
}

function hashTrackedDiff(hash: Hash, cwd: string, env: NodeJS.ProcessEnv, args: string[], kind: string): void {
  // Stream Git into a private spool to keep synchronous note capture bounded without
  // introducing an asynchronous, unbounded queue behind provider callbacks.
  const directory = mkdtempSync(join(tmpdir(), 'takt-review-diff-'));
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
        if (count === 0) throw new Error('Incomplete review diff spool');
        hash.update(buffer.subarray(0, count));
        position += count;
      }
    } finally { closeSync(descriptor); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Checkpoints are outputs, never inputs, even when the run directory is not gitignored. */
function repositorySnapshot(cwd: string, reportDir: string, env: NodeJS.ProcessEnv, scope: ReviewCheckpointContext['scope']) {
  const checkpointDirectory = reviewCheckpointDirectory(reportDir);
  const safeArgs = ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false'];
  const git = (args: string[]): Buffer => execFileSync('git', [...safeArgs, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const diffRange = scope.kind === 'collected' && scope.source.kind === 'pull_request'
    ? scope.source.diffRange : undefined;
  const pullRequestOids = diffRange === undefined ? undefined : {
    base: git(['rev-parse', '--verify', '--end-of-options', `${diffRange.baseDiffRef}^{commit}`]).toString('utf8').trim(),
    head: git(['rev-parse', '--verify', '--end-of-options', `${diffRange.headDiffRef}^{commit}`]).toString('utf8').trim(),
  };
  // Inspect only the parent index. Probing child dirtiness can execute child filters,
  // while ignoring it would let different submodule contents reuse the same log.
  const tracked = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0');
  if (tracked.some((entry) => entry.startsWith('160000 '))) {
    throw new ReviewCheckpointUnavailableError('Submodule contents cannot be fingerprinted without child Git inspection');
  }
  const hash = createHash('sha256').update('review-revision-v5\n');
  if (pullRequestOids !== undefined) hash.update(JSON.stringify(pullRequestOids)).update('\n');
  const excluded = relative(resolve(cwd), resolve(checkpointDirectory));
  const pathspec = excluded !== '..' && !excluded.startsWith(`..${sep}`) && !isAbsolute(excluded)
    ? [`:(exclude,literal)${excluded.split(sep).join('/')}`] : [];
  const head = repositoryHead(git);
  hash.update(head === undefined ? 'unborn\n' : head);
  // A net HEAD-to-worktree diff hides index-only changes. Keep both layers
  // distinct, including before HEAD exists (--cached then uses the empty tree).
  for (const kind of ['staged', 'unstaged'] as const) {
    // Safe Git disables pathspec magic; only this internal literal exclusion needs it.
    hashTrackedDiff(hash, cwd, env, [...safeArgs, '--no-literal-pathspecs',
      'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--binary',
      ...(kind === 'staged' ? ['--cached'] : []), '--', ...pathspec], kind);
  }
  const untracked = parseGitNulPaths(git(['ls-files', '--others', '--exclude-standard', '-z']), 'git ls-files --others').sort();
  const inputs = excludeReviewCheckpointPaths(untracked, cwd, reportDir);
  for (const path of inputs) hashUntrackedFile(hash, cwd, path);
  return { revision: hash.digest('hex'), pullRequestOids };
}

export class ReviewCheckpointStore {
  readonly path: string;
  private readonly reportDir: string;
  private readonly scope: ReviewCheckpointContext['scope'];
  readonly target: { readonly identity: string; readonly revision: string };

  static async create(cwd: string, context: ReviewCheckpointContext, instruction: string): Promise<ReviewCheckpointStore> {
    const env = buildReviewGitEnvironment(cwd);
    const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
    return new ReviewCheckpointStore(cwd, repositoryRoot, context, instruction, env);
  }

  private constructor(cwd: string, private readonly repositoryRoot: string, context: ReviewCheckpointContext, instruction: string, private readonly env: NodeJS.ProcessEnv) {
    this.reportDir = context.reportDir;
    this.scope = excludeReviewCheckpointScope(context.scope, repositoryRoot, context.reportDir);
    const directory = reviewCheckpointDirectory(context.reportDir);
    assertCheckpointPath(directory, true);
    const snapshot = repositorySnapshot(repositoryRoot, this.reportDir, env, this.scope);
    this.target = {
      identity: digest(JSON.stringify({ cwd: resolve(cwd), ...context, scope: this.scope, instruction, pullRequestOids: snapshot.pullRequestOids })),
      revision: snapshot.revision,
    };
    assertCheckpointPath(directory, true);
    ensurePrivateDirectory(directory);
    this.path = join(directory, `${digest(JSON.stringify(this.target))}.log`);
    assertCheckpointPath(this.path, false);
  }

  read(): string | undefined {
    assertCheckpointPath(this.path, false);
    // An edited diff is a different review, not evidence of a stalled reviewer.
    if (repositorySnapshot(this.repositoryRoot, this.reportDir, this.env, this.scope).revision !== this.target.revision) return undefined;
    return this.readLog();
  }

  private readLog(): string | undefined {
    assertCheckpointPath(this.path, false);
    const file = readPrivateFileState(this.path);
    return 'content' in file ? file.content.toString('utf8') : undefined;
  }

  save(log: string): void {
    this.assertCurrentTarget();
    this.writeLog(log);
  }

  append(note: string): void {
    this.assertCurrentTarget();
    this.writeLog(`${this.readLog() ?? ''}${note}`);
  }

  private assertCurrentTarget(): void {
    assertCheckpointPath(this.path, false);
    if (repositorySnapshot(this.repositoryRoot, this.reportDir, this.env, this.scope).revision !== this.target.revision) throw new Error('Review target changed; work log was not saved');
  }

  private writeLog(log: string): void {
    const sanitized = sanitizeSensitiveText(log);
    assertCheckpointPath(this.path, false);
    writePrivateFile(this.path, sanitized.length > REVIEW_LOG_MAX_CHARS
      ? TRUNCATED + sanitized.slice(-(REVIEW_LOG_MAX_CHARS - TRUNCATED.length))
      : sanitized);
  }
}
