import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ConflictFile {
  readonly path: string;
  readonly original: Buffer;
  readonly keepSideCanBeUnchanged: boolean;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Buffer {
  return execFileSync('git', args, { cwd, env, stdio: 'pipe' });
}

function paths(buffer: Buffer): Set<string> {
  return new Set(buffer.toString('utf8').split('\0').filter(Boolean));
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

function readConflictFile(cwd: string, path: string): Buffer {
  const fullPath = join(cwd, path);
  if (!lstatSync(fullPath).isFile()) throw new Error(`Conflict resolution requires a regular file: ${path}`);
  const content = readFileSync(fullPath);
  if (content.includes(0)) throw new Error(`Binary merge conflict requires manual resolution: ${path}`);
  new TextDecoder('utf-8', { fatal: true }).decode(content);
  return content;
}

function readResolvedFile(cwd: string, path: string): Buffer | undefined {
  try {
    return readConflictFile(cwd, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function containsConflictMarkers(content: Buffer): boolean {
  return /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?:\s|$)/mu.test(content.toString('utf8'));
}

function requireSupportedConflictMarkerSize(cwd: string, path: string, env?: NodeJS.ProcessEnv): void {
  const [reportedPath, attribute, value] = git(
    cwd, ['check-attr', '-z', 'conflict-marker-size', '--', path], env,
  ).toString('utf8').split('\0');
  if (reportedPath !== path || attribute !== 'conflict-marker-size' || value === undefined) {
    throw new Error(`Cannot determine conflict marker size: ${path}`);
  }
  if (value === 'unspecified') return;
  const markerSize = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(markerSize) || markerSize < 7) {
    throw new Error(`Unsupported conflict marker size for AI resolution: ${path}`);
  }
}

export function captureSyncConflictFiles(cwd: string, env?: NodeJS.ProcessEnv): { validateAndStage(): void } {
  const entries = unmergedEntries(cwd, env);
  if (entries.size === 0) throw new Error('No unmerged files were found for AI conflict resolution');
  const originalIndex = git(cwd, ['ls-files', '-s', '-z'], env);
  const conflictPaths = new Set(entries.keys());
  const unrelatedUnstaged = [...paths(git(cwd, ['diff', '--name-only', '-z'], env))]
    .find((path) => !conflictPaths.has(path));
  if (unrelatedUnstaged !== undefined) {
    throw new Error(`Unrelated tracked changes prevent AI conflict resolution: ${unrelatedUnstaged}`);
  }
  const initialUntracked = paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env));
  if (initialUntracked.size > 0) {
    throw new Error(`Untracked files prevent AI conflict resolution: ${[...initialUntracked][0]}`);
  }
  const files: ConflictFile[] = [...entries].map(([path, stages]) => {
    requireSupportedConflictMarkerSize(cwd, path, env);
    const original = readConflictFile(cwd, path);
    const stageNumbers = stages.map((stage) => stage.slice(-1)).sort().join('');
    return {
      path, original,
      keepSideCanBeUnchanged: (stageNumbers === '12' || stageNumbers === '13')
        && !containsConflictMarkers(original),
    };
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
      for (const path of paths(git(cwd, ['diff', '--name-only', '-z'], env))) {
        if (!conflictPaths.has(path)) {
          throw new Error(`AI changed a file outside the merge conflicts: ${path}`);
        }
      }
      const untracked = [...paths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env))][0];
      if (untracked !== undefined) throw new Error(`AI created a file outside the merge conflicts: ${untracked}`);
      for (const file of files) {
        const resolved = readResolvedFile(cwd, file.path);
        if (resolved?.equals(file.original) && !file.keepSideCanBeUnchanged) {
          throw new Error(`AI did not change unmerged file: ${file.path}`);
        }
        if (resolved !== undefined && containsConflictMarkers(resolved)) {
          throw new Error(`Unresolved conflict marker remains: ${file.path}`);
        }
      }
      git(cwd, ['add', '--', ...files.map((file) => file.path)], env);
      if (unmergedEntries(cwd, env).size !== 0) {
        throw new Error('Unmerged files remain after runtime staging');
      }
    },
  };
}
