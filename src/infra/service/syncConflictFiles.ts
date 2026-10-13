import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readlinkSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

interface ConflictFile {
  readonly path: string;
  readonly markerSize: number;
}

interface WorktreeFile {
  readonly kind: 'file' | 'symlink';
  readonly content: Buffer;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Buffer {
  return execFileSync('git', args, { cwd, env, stdio: 'pipe' });
}

function paths(buffer: Buffer): Set<string> {
  return new Set(buffer.toString('utf8').split('\0').filter(Boolean));
}

function readWorktreeFile(cwd: string, path: string): WorktreeFile | undefined {
  const fullPath = join(cwd, path);
  try {
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink()) return { kind: 'symlink', content: Buffer.from(readlinkSync(fullPath)) };
    if (!stats.isFile()) throw new Error(`Unsupported conflict resolution file type: ${path}`);
    return { kind: 'file', content: readFileSync(fullPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameContent(left: WorktreeFile | undefined, right: WorktreeFile | undefined): boolean {
  return left === undefined ? right === undefined
    : right !== undefined && left.kind === right.kind && left.content.equals(right.content);
}

function stageChangesAfterPreexistingEdit(
  cwd: string, path: string, before: Buffer, after: Buffer | undefined, env?: NodeJS.ProcessEnv,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'takt-conflict-diff-'));
  try {
    const oldPath = join(directory, 'a', path);
    const newPath = join(directory, 'b', path);
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, before);
    git(cwd, ['hash-object', '-w', oldPath], env);
    if (after !== undefined) {
      mkdirSync(dirname(newPath), { recursive: true });
      writeFileSync(newPath, after);
      git(cwd, ['hash-object', '-w', newPath], env);
    }
    let patch: Buffer;
    try {
      patch = execFileSync('git', ['diff', '--no-index', '--binary', '--', `a/${path}`, `b/${path}`], {
        cwd: directory, env, stdio: 'pipe',
      });
    } catch (error) {
      if (!(error instanceof Error && 'status' in error && error.status === 1 && 'stdout' in error
        && Buffer.isBuffer(error.stdout))) throw error;
      patch = error.stdout;
    }
    execFileSync('git', ['apply', '--cached', '--3way', '-p2', '-'], {
      cwd, env, input: patch, stdio: 'pipe',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function unmergedEntries(cwd: string, env?: NodeJS.ProcessEnv): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const entry of git(cwd, ['ls-files', '-u', '-z'], env).toString('utf8').split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    if (separator < 0) throw new Error('Invalid unmerged Git index entry');
    const path = entry.slice(separator + 1);
    const stages = entries.get(path) ?? [];
    stages.push(entry.slice(0, separator));
    entries.set(path, stages);
  }
  return entries;
}

function readResolvedFile(cwd: string, path: string): WorktreeFile | undefined {
  return readWorktreeFile(cwd, path);
}

function containsConflictMarkers(content: Buffer, markerSize: number): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return false;
  }
  return new RegExp(`^(?:<{${markerSize},}|\\|{${markerSize},}|={${markerSize},}|>{${markerSize},})(?:\\s|$)`, 'mu').test(text);
}

function resolveConflictMarkerSize(cwd: string, path: string, env?: NodeJS.ProcessEnv): number {
  const [reportedPath, attribute, value] = git(
    cwd, ['check-attr', '-z', 'conflict-marker-size', '--', path], env,
  ).toString('utf8').split('\0');
  if (reportedPath !== path || attribute !== 'conflict-marker-size' || value === undefined) {
    throw new Error(`Cannot determine conflict marker size: ${path}`);
  }
  if (value === 'unspecified' || value === 'unset' || value === 'set') return 7;
  const markerSize = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(markerSize)) {
    return 7;
  }
  return markerSize;
}

export function captureSyncConflictFiles(cwd: string, env?: NodeJS.ProcessEnv): { validateAndStage(): void } {
  const entries = unmergedEntries(cwd, env);
  if (entries.size === 0) throw new Error('No unmerged files were found for AI conflict resolution');
  const originalIndex = git(cwd, ['ls-files', '-s', '-z'], env);
  const reportedIndexPath = git(cwd, ['rev-parse', '--git-path', 'index'], env).toString('utf8').trim();
  const indexPath = isAbsolute(reportedIndexPath) ? reportedIndexPath : resolve(cwd, reportedIndexPath);
  const originalIndexContent = readFileSync(indexPath);
  const conflictPaths = new Set(entries.keys());
  const initialUnstaged = new Map([...paths(git(cwd, ['diff', '--name-only', '-z'], env))]
    .filter((path) => !conflictPaths.has(path))
    .map((path) => [path, readWorktreeFile(cwd, path)] as const));
  const initialUntracked = paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env));
  const initialUntrackedContents = new Map([...initialUntracked]
    .map((path) => [path, readWorktreeFile(cwd, path)] as const));
  const files: ConflictFile[] = [...entries].map(([path]) => {
    readResolvedFile(cwd, path);
    return { path, markerSize: resolveConflictMarkerSize(cwd, path, env) };
  });

  return {
    validateAndStage(): void {
      const current = unmergedEntries(cwd, env);
      if (current.size !== entries.size || [...entries].some(([path, stages]) =>
        JSON.stringify(current.get(path)) !== JSON.stringify(stages))) {
        throw new Error('AI changed the unmerged Git index before runtime validation');
      }
      if (!git(cwd, ['ls-files', '-s', '-z'], env).equals(originalIndex)) {
        throw new Error('AI changed the Git index before runtime validation');
      }
      const changedTracked = new Set([...paths(git(cwd, ['diff', '--name-only', '-z'], env)), ...initialUnstaged.keys()]
        .filter((path) => !conflictPaths.has(path)));
      const currentUntracked = paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env));
      const newFiles = [...currentUntracked].filter((path) => !initialUntracked.has(path));
      for (const [path, original] of initialUntrackedContents) {
        if (!currentUntracked.has(path) || !sameContent(original, readWorktreeFile(cwd, path))) {
          throw new Error(`AI changed a preexisting untracked file: ${path}`);
        }
      }
      for (const file of files) {
        const resolved = readResolvedFile(cwd, file.path);
        if (resolved?.kind === 'file' && containsConflictMarkers(resolved.content, file.markerSize)) {
          throw new Error(`Unresolved conflict marker remains: ${file.path}`);
        }
      }
      const indexDirectory = mkdtempSync(join(dirname(indexPath), 'takt-conflict-index-'));
      const temporaryIndex = join(indexDirectory, 'index');
      try {
        writeFileSync(temporaryIndex, originalIndexContent);
        const stageEnv = { ...process.env, ...env, GIT_INDEX_FILE: temporaryIndex };
        const directlyStaged = [...files.map((file) => file.path), ...newFiles];
        for (const path of changedTracked) {
          const original = initialUnstaged.get(path);
          if (!initialUnstaged.has(path)) {
            directlyStaged.push(path);
            continue;
          }
          const resolved = readWorktreeFile(cwd, path);
          if (sameContent(original, resolved)) continue;
          if (original === undefined) {
            throw new Error(`AI changed a preexisting deleted file: ${path}`);
          }
          if (original.kind !== 'file' || (resolved !== undefined && resolved.kind !== 'file')) {
            throw new Error(`AI changed a preexisting non-file path: ${path}`);
          }
          stageChangesAfterPreexistingEdit(cwd, path, original.content, resolved?.content, stageEnv);
        }
        if (directlyStaged.length > 0) git(cwd, ['add', '-A', '--', ...directlyStaged], stageEnv);
        if (unmergedEntries(cwd, stageEnv).size !== 0) {
          throw new Error('Unmerged files remain after runtime staging');
        }
        const lockPath = `${indexPath}.lock`;
        const lockFd = openSync(lockPath, 'wx');
        try {
          if (!readFileSync(indexPath).equals(originalIndexContent)) {
            throw new Error('Git index changed during runtime staging');
          }
          writeFileSync(lockFd, readFileSync(temporaryIndex));
        } catch (error) {
          closeSync(lockFd);
          rmSync(lockPath, { force: true });
          throw error;
        }
        closeSync(lockFd);
        try {
          renameSync(lockPath, indexPath);
        } catch (error) {
          rmSync(lockPath, { force: true });
          throw error;
        }
      } finally {
        rmSync(indexDirectory, { recursive: true, force: true });
      }
    },
  };
}
