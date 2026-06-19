import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProjectResourcesDir } from '../resources/index.js';
import { isRealPathInside } from '../../shared/utils/index.js';

const SYNCED_TAKT_RESOURCES = ['config.yaml', 'workflows', 'facets', 'quality-gates'] as const;
const QUALITY_GATES_GENERATED_DIRS = new Set(['logs']);

type PathKind = 'missing' | 'file' | 'directory' | 'symlink';

function getPathKind(targetPath: string): PathKind {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return 'symlink';
  }
  if (stat.isDirectory()) {
    return 'directory';
  }
  if (stat.isFile()) {
    return 'file';
  }

  throw new Error(`Unsupported filesystem entry: ${targetPath}`);
}

function removePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function assertTargetPathInside(targetRoot: string, targetPath: string): void {
  if (!isRealPathInside(targetRoot, targetPath)) {
    throw new Error(`Refusing to sync outside target .takt directory: ${targetPath}`);
  }
}

function ensureSafeDirectory(targetRoot: string, directoryPath: string): void {
  const pathKind = getPathKind(directoryPath);
  if (pathKind === 'symlink' || pathKind === 'file') {
    removePath(directoryPath);
  }
  fs.mkdirSync(directoryPath, { recursive: true });
  assertTargetPathInside(targetRoot, directoryPath);
}

function ensureWorktreeTaktDirectory(worktreePath: string): string {
  const targetTaktDir = path.join(worktreePath, '.takt');
  const pathKind = getPathKind(targetTaktDir);
  if (pathKind === 'missing') {
    fs.mkdirSync(targetTaktDir, { recursive: true });
    assertTargetPathInside(worktreePath, targetTaktDir);
    return targetTaktDir;
  }
  if (pathKind !== 'directory') {
    throw new Error(`Worktree .takt must be a directory or missing: ${targetTaktDir}`);
  }

  assertTargetPathInside(worktreePath, targetTaktDir);
  return targetTaktDir;
}

function ensureSourcePathKind(sourcePath: string): Exclude<PathKind, 'symlink'> {
  const pathKind = getPathKind(sourcePath);
  if (pathKind === 'symlink') {
    throw new Error(`Refusing to sync symbolic link: ${sourcePath}`);
  }

  return pathKind;
}

function syncFile(sourcePath: string, targetPath: string, targetRoot: string): void {
  const targetKind = getPathKind(targetPath);
  if (targetKind === 'symlink' || targetKind === 'directory') {
    removePath(targetPath);
  }
  ensureSafeDirectory(targetRoot, path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  assertTargetPathInside(targetRoot, targetPath);
}

function syncDirectory(sourceDir: string, targetDir: string, targetRoot: string): void {
  const sourceKind = ensureSourcePathKind(sourceDir);
  if (sourceKind !== 'directory') {
    throw new Error(`Expected directory while syncing project-local .takt: ${sourceDir}`);
  }

  const targetKind = getPathKind(targetDir);
  if (targetKind === 'symlink' || targetKind === 'file') {
    removePath(targetDir);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  assertTargetPathInside(targetRoot, targetDir);

  const sourceEntries = new Set(fs.readdirSync(sourceDir).filter((entry) => !shouldSkipTaktSyncEntry(sourceDir, entry)));
  for (const entry of fs.readdirSync(targetDir)) {
    if (!sourceEntries.has(entry)) {
      removePath(path.join(targetDir, entry));
    }
  }

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    const sourceEntryKind = ensureSourcePathKind(sourcePath);
    if (sourceEntryKind === 'directory') {
      syncDirectory(sourcePath, targetPath, targetRoot);
      continue;
    }
    if (sourceEntryKind !== 'file') {
      throw new Error(`Expected file while syncing project-local .takt: ${sourcePath}`);
    }
    syncFile(sourcePath, targetPath, targetRoot);
  }
}

function shouldSkipTaktSyncEntry(sourceDir: string, entry: string): boolean {
  return path.basename(sourceDir) === 'quality-gates' && QUALITY_GATES_GENERATED_DIRS.has(entry);
}

function ensureWorktreeTaktGitignoreFile(targetTaktDir: string): void {
  const targetPath = path.join(targetTaktDir, '.gitignore');
  const targetKind = getPathKind(targetPath);
  if (targetKind === 'file') {
    return;
  }
  if (targetKind !== 'missing') {
    throw new Error(`Worktree .takt/.gitignore must be a regular file or missing: ${targetPath}`);
  }

  const sourcePath = path.join(getProjectResourcesDir(), 'dotgitignore');
  const sourceKind = ensureSourcePathKind(sourcePath);
  if (sourceKind !== 'file') {
    throw new Error(`Expected built-in project .gitignore template: ${sourcePath}`);
  }

  fs.copyFileSync(sourcePath, targetPath);
  assertTargetPathInside(targetTaktDir, targetPath);
}

export function ensureWorktreeTaktGitignore(worktreePath: string): void {
  if (getPathKind(worktreePath) !== 'directory') {
    throw new Error(`Worktree path must be an existing directory: ${worktreePath}`);
  }

  const targetTaktDir = ensureWorktreeTaktDirectory(worktreePath);
  ensureWorktreeTaktGitignoreFile(targetTaktDir);
}

export function syncProjectLocalTaktForRetry(projectDir: string, worktreePath: string): void {
  if (getPathKind(worktreePath) !== 'directory') {
    throw new Error(`Worktree path must be an existing directory: ${worktreePath}`);
  }

  const sourceTaktDir = path.join(projectDir, '.takt');
  const sourceTaktKind = ensureSourcePathKind(sourceTaktDir);
  if (sourceTaktKind !== 'missing' && sourceTaktKind !== 'directory') {
    throw new Error(`Project-local .takt must be a directory: ${sourceTaktDir}`);
  }

  const targetTaktDir = path.join(worktreePath, '.takt');
  ensureSafeDirectory(worktreePath, targetTaktDir);
  ensureWorktreeTaktGitignoreFile(targetTaktDir);

  for (const resource of SYNCED_TAKT_RESOURCES) {
    const sourcePath = path.join(sourceTaktDir, resource);
    const targetPath = path.join(targetTaktDir, resource);
    const sourceKind = ensureSourcePathKind(sourcePath);
    if (sourceKind === 'missing') {
      removePath(targetPath);
      continue;
    }

    if (sourceKind === 'directory') {
      syncDirectory(sourcePath, targetPath, targetTaktDir);
      continue;
    }
    if (sourceKind !== 'file') {
      throw new Error(`Expected file while syncing project-local .takt: ${sourcePath}`);
    }
    syncFile(sourcePath, targetPath, targetTaktDir);
  }
}
