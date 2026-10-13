import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProjectResourcesDir } from '../resources/index.js';
import { createLogger, isRealPathInside } from '../../shared/utils/index.js';

const log = createLogger('project-local-takt-sync');

const SYNCED_TAKT_RESOURCES = ['config.yaml', 'workflows', 'facets', 'steps', 'quality-gates'] as const;
const QUALITY_GATES_GENERATED_DIRS = new Set(['logs']);
const TAKT_RUNS_GIT_EXCLUDE_PATTERN = '/.takt/runs/';
const SYNCED_RESOURCES_IGNORE_START = '# BEGIN TAKT synced resources';
const SYNCED_RESOURCES_IGNORE_START_WITH_SEPARATOR = `${SYNCED_RESOURCES_IGNORE_START} with separator`;
const SYNCED_RESOURCES_IGNORE_END = '# END TAKT synced resources';

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

function resolveGitExcludePath(worktreePath: string): string | undefined {
  let gitPath: string;
  try {
    gitPath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch (error: unknown) {
    // The protection only matters where git commands (e.g. git clean) can run;
    // if git itself is unavailable or the repository is broken, skip instead of
    // failing the whole workflow startup.
    log.warn('Skipping .takt git protection: git info/exclude path resolution failed', {
      worktreePath,
      error: String(error),
    });
    return undefined;
  }
  if (gitPath.length === 0) {
    throw new Error(`Git returned an empty info/exclude path for worktree: ${worktreePath}`);
  }
  const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreePath, gitPath);
  const excludeKind = getPathKind(excludePath);
  if (excludeKind !== 'missing' && excludeKind !== 'file') {
    throw new Error(`Git info/exclude must be a regular file or missing: ${excludePath}`);
  }

  return excludePath;
}

function appendGitignorePatterns(ignorePath: string, patterns: readonly string[]): void {
  const content = getPathKind(ignorePath) === 'file' ? fs.readFileSync(ignorePath, 'utf-8') : '';
  const existingPatterns = new Set(content.split(/\r?\n/));
  const missingPatterns = patterns.filter((pattern) => !existingPatterns.has(pattern));
  if (missingPatterns.length === 0) {
    return;
  }

  fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ignorePath, `${separator}${missingPatterns.join('\n')}\n`, 'utf-8');
}

function replaceSyncedResourceIgnorePatterns(ignorePath: string, patterns: readonly string[]): void {
  const content = getPathKind(ignorePath) === 'file' ? fs.readFileSync(ignorePath, 'utf-8') : '';
  const managedBlock = new RegExp(
    `(?:\\n${SYNCED_RESOURCES_IGNORE_START_WITH_SEPARATOR}|^${SYNCED_RESOURCES_IGNORE_START})\\r?\\n[\\s\\S]*?^${SYNCED_RESOURCES_IGNORE_END}(?:\\r?\\n|$)`,
    'gm',
  );
  const userContent = content.replace(managedBlock, '');
  const separator = userContent.length > 0 && !userContent.endsWith('\n') ? '\n' : '';
  const start = separator ? SYNCED_RESOURCES_IGNORE_START_WITH_SEPARATOR : SYNCED_RESOURCES_IGNORE_START;
  const block = patterns.length > 0
    ? `${separator}${start}\n${patterns.join('\n')}\n${SYNCED_RESOURCES_IGNORE_END}\n`
    : '';
  const updatedContent = `${userContent}${block}`;
  if (updatedContent !== content) {
    fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
    fs.writeFileSync(ignorePath, updatedContent, 'utf-8');
  }
}

function protectSyncedTaktResources(worktreePath: string): void {
  if (getPathKind(path.join(worktreePath, '.git')) === 'missing') {
    return;
  }
  const resourcePaths: string[] = SYNCED_TAKT_RESOURCES.map((resource) => `.takt/${resource}`);
  const gitOptions = { cwd: worktreePath, encoding: 'utf-8' as const, stdio: 'pipe' as const };
  const trackedPaths = execFileSync('git', ['ls-files', '-z', '--', ...resourcePaths], gitOptions);
  if (trackedPaths.length > 0) {
    execFileSync('git', ['update-index', '--no-skip-worktree', '-z', '--stdin'], {
      ...gitOptions,
      input: trackedPaths,
    });
  }
  // Retry must discard staged configuration overlays as well as unstaged ones.
  execFileSync('git', ['reset', '--quiet', 'HEAD', '--', ...resourcePaths], gitOptions);
  const untrackedPaths = execFileSync('git', [
    'ls-files', '--others', '-z', '--', ...resourcePaths, '.takt/.gitignore',
  ], gitOptions).split('\0').filter((filePath) => filePath.length > 0);
  const excludePatterns = untrackedPaths.map((filePath) => `/${filePath.replace(/[\\*?[\]]/g, '\\$&')}`);
  const excludePath = resolveGitExcludePath(worktreePath);
  if (excludePath === undefined) {
    return;
  }
  replaceSyncedResourceIgnorePatterns(excludePath, excludePatterns);
  // Local negations take precedence over info/exclude, so repeat exact file rules here.
  replaceSyncedResourceIgnorePatterns(
    path.join(worktreePath, '.takt', '.gitignore'),
    excludePatterns.map((pattern) => pattern.slice('/.takt'.length)),
  );
  const trackedGitignore = execFileSync('git', ['ls-files', '-z', '--', '.takt/.gitignore'], gitOptions);
  if (trackedGitignore.length > 0) {
    execFileSync('git', ['update-index', '--no-skip-worktree', '-z', '--stdin'], {
      ...gitOptions,
      input: trackedGitignore,
    });
  }
  if (untrackedPaths.length > 0) {
    resourcePaths.push('.takt/.gitignore');
    if (trackedGitignore.length > 0) {
      execFileSync('git', ['reset', '--quiet', 'HEAD', '--', '.takt/.gitignore'], gitOptions);
    }
  }
  const changedPaths = execFileSync('git', [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--',
    ...resourcePaths,
  ], gitOptions);
  if (changedPaths.length === 0) {
    return;
  }
  // Identical tracked resources remain editable without an explicit opt-in.
  execFileSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], {
    cwd: worktreePath,
    input: changedPaths,
    stdio: 'pipe',
  });
}

export function ensureWorktreeTaktGitignore(worktreePath: string): void {
  if (getPathKind(worktreePath) !== 'directory') {
    throw new Error(`Worktree path must be an existing directory: ${worktreePath}`);
  }

  const targetTaktDir = ensureWorktreeTaktDirectory(worktreePath);
  ensureWorktreeTaktGitignoreFile(targetTaktDir);
}

export function ensureWorktreeTaktRuntimeProtection(worktreePath: string): void {
  ensureWorktreeTaktGitignore(worktreePath);
  if (getPathKind(path.join(worktreePath, '.git')) === 'missing') {
    return;
  }
  const excludePath = resolveGitExcludePath(worktreePath);
  if (excludePath !== undefined) {
    appendGitignorePatterns(excludePath, [TAKT_RUNS_GIT_EXCLUDE_PATTERN]);
  }
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
  protectSyncedTaktResources(worktreePath);
}
