import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  ensureWorktreeTaktGitignore,
  ensureWorktreeTaktRuntimeProtection,
  syncProjectLocalTaktForRetry,
} from '../infra/task/projectLocalTaktSync.js';
import { autoCommitAndPush } from '../infra/task/autoCommit.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readBuiltinProjectDotgitignore(): string {
  return readFileSync(join(__dirname, '..', '..', 'builtins', 'project', 'dotgitignore'), 'utf-8');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function createCloneFixture(projectGitignore: string = readBuiltinProjectDotgitignore()) {
  const projectDir = createTempDir('takt-sync-git-project-');
  const parentDir = createTempDir('takt-sync-git-clone-');
  const worktreePath = join(parentDir, 'clone');
  git(projectDir, ['init', '--quiet']);
  git(projectDir, ['config', 'user.name', 'TAKT Test']);
  git(projectDir, ['config', 'user.email', 'takt@example.com']);
  mkdirSync(join(projectDir, '.takt', 'steps'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', '.gitignore'), projectGitignore);
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(projectDir, '.takt', 'steps', 'review.yaml'), 'instruction: base\n');
  writeFileSync(join(projectDir, 'README.md'), 'base\n');
  git(projectDir, ['add', '-A']);
  git(projectDir, ['commit', '--quiet', '-m', 'base']);
  git(projectDir, ['clone', '--quiet', '--shared', projectDir, worktreePath]);
  git(worktreePath, ['config', 'user.name', 'TAKT Test']);
  git(worktreePath, ['config', 'user.email', 'takt@example.com']);
  git(worktreePath, ['switch', '--quiet', '-c', 'task-sync']);
  return { projectDir, worktreePath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncProjectLocalTaktForRetry', () => {
  it('should hide synchronized tracked changes and untracked resources from status, diff, and auto-commit', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    const base = git(worktreePath, ['rev-parse', 'HEAD']);
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
    rmSync(join(projectDir, '.takt', 'steps', 'review.yaml'));
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'local.yaml'), 'name: local\n');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'config.yaml'), 'utf-8')).toBe('provider: mock\nlanguage: ja\n');
    expect(readFileSync(join(worktreePath, '.takt', 'workflows', 'local.yaml'), 'utf-8')).toBe('name: local\n');
    expect(existsSync(join(worktreePath, '.takt', 'steps', 'review.yaml'))).toBe(false);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(git(worktreePath, ['diff'])).toBe('');
    const result = await autoCommitAndPush(worktreePath, 'sync-only', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(base);
    expect(git(worktreePath, ['diff', '--cached'])).toBe('');

    writeFileSync(join(worktreePath, 'README.md'), 'task change\n');
    const committed = await autoCommitAndPush(worktreePath, 'task-change', projectDir, 'task-sync');
    expect(committed.success).toBe(true);
    expect(committed.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('README.md\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/config.yaml'])).toBe('provider: mock\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/steps/review.yaml'])).toBe('instruction: base\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(git(projectDir, ['diff', '--name-only'])).toBe('.takt/config.yaml\n.takt/steps/review.yaml\n');
  });

  it('should keep identical tracked settings editable and allow explicit opt-in for overlaid settings', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    writeFileSync(join(worktreePath, '.takt', 'steps', 'review.yaml'), 'instruction: task edit\n');
    expect(git(worktreePath, ['status', '--porcelain'])).toBe(' M .takt/steps/review.yaml\n');
    writeFileSync(join(worktreePath, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    expect(git(worktreePath, ['diff', '--name-only'])).toBe('.takt/steps/review.yaml\n');
    git(worktreePath, ['update-index', '--no-skip-worktree', '--', '.takt/config.yaml']);
    expect(git(worktreePath, ['diff', '--name-only'])).toBe('.takt/config.yaml\n.takt/steps/review.yaml\n');

    const result = await autoCommitAndPush(worktreePath, 'intentional-settings-edit', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['show', 'HEAD:.takt/config.yaml'])).toBe('provider: mock\nlanguage: en\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/steps/review.yaml'])).toBe('instruction: task edit\n');
  });

  it('should commit new task workflows while excluding only copied untracked files', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'local[1].yaml'), 'name: local\n');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    const exclude = readFileSync(join(worktreePath, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n').filter((line) => line.startsWith('/.takt'))).toEqual([
      '/.takt/workflows/local\\[1\\].yaml',
    ]);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    writeFileSync(join(worktreePath, '.takt', 'workflows', 'task.yaml'), 'name: task\n');
    writeFileSync(join(worktreePath, '.takt', 'workflows', 'local1.yaml'), 'name: another task\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      '?? .takt/workflows/local1.yaml\n?? .takt/workflows/task.yaml\n',
    );

    const result = await autoCommitAndPush(worktreePath, 'new-workflows', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(
      '.takt/workflows/local1.yaml\n.takt/workflows/task.yaml\n',
    );
    expect(git(worktreePath, ['show', 'HEAD:.takt/.gitignore'])).toBe(readBuiltinProjectDotgitignore());
  });

  it.each([true, false])('should replace synced exclusions and commit a reused path (remaining copied file: %s)', async (keepCopiedFile) => {
    const projectGitignore = `${readBuiltinProjectDotgitignore()}\n# user rules\n/user-only.yaml\n`;
    const { projectDir, worktreePath } = createCloneFixture(projectGitignore);
    const excludePath = join(worktreePath, '.git', 'info', 'exclude');
    const userExclude = '# user excludes\r\n/user-only.txt\r\n/.takt/runs/\r\n';
    mkdirSync(join(worktreePath, '.git', 'info'), { recursive: true });
    writeFileSync(excludePath, userExclude);
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'local[1].yaml'), 'name: copied\n');
    writeFileSync(join(projectDir, '.takt', 'workflows', 'keep.yaml'), 'name: keep\n');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const excludeSuffix = '# later user rule\n/later-user.txt\n';
    const gitignoreSuffix = '# later user rule\n/later-user.yaml\n';
    writeFileSync(excludePath, `${readFileSync(excludePath, 'utf-8')}${excludeSuffix}`);
    const gitignorePath = join(worktreePath, '.takt', '.gitignore');
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, 'utf-8')}${gitignoreSuffix}`);
    rmSync(join(projectDir, '.takt', 'workflows', 'local[1].yaml'));
    if (!keepCopiedFile) {
      rmSync(join(projectDir, '.takt', 'workflows', 'keep.yaml'));
    }

    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    const exclude = readFileSync(excludePath, 'utf-8');
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    ensureWorktreeTaktRuntimeProtection(worktreePath);

    const copiedPattern = keepCopiedFile ? '/.takt/workflows/keep.yaml\n' : '';
    const block = keepCopiedFile
      ? `# BEGIN TAKT synced resources\n${copiedPattern}# END TAKT synced resources\n`
      : '';
    expect(exclude).toBe(`${userExclude}${excludeSuffix}${block}`);
    expect(gitignore).toBe(`${projectGitignore}${gitignoreSuffix}${block.replace('/.takt/', '/')}`);
    expect(readFileSync(excludePath, 'utf-8')).toBe(exclude);
    expect(readFileSync(gitignorePath, 'utf-8')).toBe(gitignore);
    expect(existsSync(join(worktreePath, '.takt', 'workflows', 'local[1].yaml'))).toBe(false);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      keepCopiedFile ? '' : ' M .takt/.gitignore\n',
    );
    writeFileSync(join(worktreePath, '.takt', 'workflows', 'local[1].yaml'), 'name: task\n');
    mkdirSync(join(worktreePath, '.takt', 'runs'));
    writeFileSync(join(worktreePath, '.takt', 'runs', 'runtime.json'), '{}\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      `${keepCopiedFile ? '' : ' M .takt/.gitignore\n'}?? .takt/workflows/local[1].yaml\n`,
    );

    const result = await autoCommitAndPush(worktreePath, 'reused-workflow-path', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(
      `${keepCopiedFile ? '' : '.takt/.gitignore\n'}.takt/workflows/local[1].yaml\n`,
    );
    expect(git(worktreePath, ['show', 'HEAD:.takt/workflows/local[1].yaml'])).toBe('name: task\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/.gitignore'])).toBe(
      keepCopiedFile ? projectGitignore : `${projectGitignore}${gitignoreSuffix}`,
    );
  });

  it.each(['\n', '\r\n'])('should restore ignore files without a trailing newline after removing synced exclusions (line ending: %j)', (lineEnding) => {
    const projectGitignore = `# user rules${lineEnding}/user-only.yaml`;
    const { projectDir, worktreePath } = createCloneFixture(projectGitignore);
    const gitignorePath = join(worktreePath, '.takt', '.gitignore');
    const excludePath = join(worktreePath, '.git', 'info', 'exclude');
    mkdirSync(join(worktreePath, '.git', 'info'), { recursive: true });
    writeFileSync(excludePath, `# user excludes${lineEnding}/user-only.txt`);
    const originalGitignore = readFileSync(gitignorePath);
    const originalExclude = readFileSync(excludePath);
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    const copiedWorkflowPath = join(projectDir, '.takt', 'workflows', 'local.yaml');
    writeFileSync(copiedWorkflowPath, 'name: local\n');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    const protectedGitignore = readFileSync(gitignorePath);
    const protectedExclude = readFileSync(excludePath);
    expect(protectedGitignore).not.toEqual(originalGitignore);
    expect(protectedExclude).not.toEqual(originalExclude);
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    expect(readFileSync(gitignorePath)).toEqual(protectedGitignore);
    expect(readFileSync(excludePath)).toEqual(protectedExclude);

    rmSync(copiedWorkflowPath);
    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(gitignorePath)).toEqual(originalGitignore);
    expect(readFileSync(excludePath)).toEqual(originalExclude);
    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/.gitignore'])).toBe('H .takt/.gitignore\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(git(worktreePath, ['diff'])).toBe('');
  });

  it.each([true, false])('should preserve gitignore edits and auto-commit them on resync without copied files (staged: %s)', async (stageEdit) => {
    const { projectDir, worktreePath } = createCloneFixture();
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    const gitignorePath = join(worktreePath, '.takt', '.gitignore');
    const stagedContent = `${readBuiltinProjectDotgitignore()}# task rule\n/task-only.yaml\n`;
    const taskContent = `${stagedContent}# unstaged task rule\n/another-task.yaml\n`;
    writeFileSync(gitignorePath, stagedContent);
    if (stageEdit) {
      git(worktreePath, ['add', '--', '.takt/.gitignore']);
    }
    writeFileSync(gitignorePath, taskContent);

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(gitignorePath, 'utf-8')).toBe(taskContent);
    expect(git(worktreePath, ['show', ':.takt/.gitignore'])).toBe(
      stageEdit ? stagedContent : readBuiltinProjectDotgitignore(),
    );
    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/.gitignore'])).toBe('H .takt/.gitignore\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      stageEdit ? 'MM .takt/.gitignore\n' : ' M .takt/.gitignore\n',
    );
    const result = await autoCommitAndPush(worktreePath, 'resynced-gitignore-edit', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('.takt/.gitignore\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/.gitignore'])).toBe(taskContent);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('should remove gitignore protection and preserve edits for auto-commit when no copied files remain', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'local.yaml'), 'name: local\n');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/.gitignore'])).toBe('S .takt/.gitignore\n');
    const gitignorePath = join(worktreePath, '.takt', '.gitignore');
    const taskRule = '# task rule\n/task-only.yaml\n';
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, 'utf-8')}${taskRule}`);
    rmSync(join(projectDir, '.takt', 'workflows', 'local.yaml'));

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    const taskContent = `${readBuiltinProjectDotgitignore()}${taskRule}`;
    expect(readFileSync(gitignorePath, 'utf-8')).toBe(taskContent);
    expect(git(worktreePath, ['show', ':.takt/.gitignore'])).toBe(readBuiltinProjectDotgitignore());
    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/.gitignore'])).toBe('H .takt/.gitignore\n');
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(' M .takt/.gitignore\n');
    const result = await autoCommitAndPush(worktreePath, 'gitignore-edit-after-removing-protection', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('.takt/.gitignore\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/.gitignore'])).toBe(taskContent);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('should clear stale skip-worktree flags when resynced settings return to the base', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
    writeFileSync(join(projectDir, '.takt', 'steps', 'review.yaml'), 'instruction: overlay\n');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/config.yaml', '.takt/steps/review.yaml'])).toBe(
      'S .takt/config.yaml\nS .takt/steps/review.yaml\n',
    );

    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\n');
    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(git(worktreePath, ['ls-files', '-t', '--', '.takt/config.yaml', '.takt/steps/review.yaml'])).toBe(
      'H .takt/config.yaml\nS .takt/steps/review.yaml\n',
    );
    expect(git(worktreePath, ['status', '--porcelain'])).toBe('');
    writeFileSync(join(worktreePath, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    expect(git(worktreePath, ['status', '--porcelain'])).toBe(' M .takt/config.yaml\n');
    const result = await autoCommitAndPush(worktreePath, 'resynced-settings-edit', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('.takt/config.yaml\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/config.yaml'])).toBe('provider: mock\nlanguage: en\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/steps/review.yaml'])).toBe('instruction: base\n');
  });

  it('should reset staged synced paths on retry while preserving staged task changes', async () => {
    const { projectDir, worktreePath } = createCloneFixture();
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
    writeFileSync(join(worktreePath, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    rmSync(join(worktreePath, '.takt', 'steps', 'review.yaml'));
    mkdirSync(join(worktreePath, '.takt', 'workflows'));
    writeFileSync(join(worktreePath, '.takt', 'workflows', 'local.yaml'), 'name: staged\n');
    writeFileSync(join(worktreePath, 'README.md'), 'staged task change\n');
    git(worktreePath, ['add', '-A']);
    expect(git(worktreePath, ['diff', '--cached', '--name-only'])).toBe(
      '.takt/config.yaml\n.takt/steps/review.yaml\n.takt/workflows/local.yaml\nREADME.md\n',
    );
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
    rmSync(join(projectDir, '.takt', 'steps', 'review.yaml'));
    mkdirSync(join(projectDir, '.takt', 'workflows'));
    writeFileSync(join(projectDir, '.takt', 'workflows', 'local.yaml'), 'name: copied\n');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'config.yaml'), 'utf-8')).toBe('provider: mock\nlanguage: ja\n');
    expect(readFileSync(join(worktreePath, '.takt', 'workflows', 'local.yaml'), 'utf-8')).toBe('name: copied\n');
    expect(existsSync(join(worktreePath, '.takt', 'steps', 'review.yaml'))).toBe(false);
    expect(git(worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('M  README.md\n');
    expect(git(worktreePath, ['diff'])).toBe('');
    expect(git(worktreePath, ['diff', '--cached', '--name-only'])).toBe('README.md\n');
    expect(git(worktreePath, ['show', ':.takt/config.yaml'])).toBe('provider: mock\n');
    expect(git(worktreePath, ['show', ':.takt/steps/review.yaml'])).toBe('instruction: base\n');

    const result = await autoCommitAndPush(worktreePath, 'retry-staged-settings', projectDir, 'task-sync');
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeDefined();
    expect(git(worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('README.md\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/config.yaml'])).toBe('provider: mock\n');
    expect(git(worktreePath, ['show', 'HEAD:.takt/steps/review.yaml'])).toBe('instruction: base\n');
  });

  it('should sync .takt/quality-gates along with config.yaml for retry worktrees', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt', 'quality-gates'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'workflow_overrides: {}\n', 'utf-8');
    writeFileSync(
      join(projectDir, '.takt', 'quality-gates', 'check.sh'),
      '#!/usr/bin/env bash\nnpm test\n',
      'utf-8',
    );

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'config.yaml'), 'utf-8')).toBe('workflow_overrides: {}\n');
    expect(readFileSync(join(worktreePath, '.takt', 'quality-gates', 'check.sh'), 'utf-8')).toBe(
      '#!/usr/bin/env bash\nnpm test\n',
    );
  });

  it('should create worktree .takt/.gitignore during retry sync', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(readBuiltinProjectDotgitignore());
  });

  it('should preserve existing worktree .takt/.gitignore during retry sync', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    const existing = '# custom ignore\nruns/\n';
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt'), { recursive: true });
    writeFileSync(join(worktreePath, '.takt', '.gitignore'), existing, 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(existing);
  });

  it('should fail before creating worktree .takt/.gitignore when project .takt is a file', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    const sourceTaktPath = join(projectDir, '.takt');
    const targetTaktPath = join(worktreePath, '.takt');
    const targetGitignorePath = join(worktreePath, '.takt', '.gitignore');
    writeFileSync(sourceTaktPath, 'not a directory\n', 'utf-8');

    expect(() => syncProjectLocalTaktForRetry(projectDir, worktreePath)).toThrow(
      `Project-local .takt must be a directory: ${sourceTaktPath}`,
    );

    expect(existsSync(targetTaktPath)).toBe(false);
    expect(existsSync(targetGitignorePath)).toBe(false);
  });

  it('should remove stale quality-gates directory when the project no longer has one', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt', 'quality-gates'), { recursive: true });
    writeFileSync(join(worktreePath, '.takt', 'quality-gates', 'stale.sh'), 'exit 1\n', 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(existsSync(join(worktreePath, '.takt', 'quality-gates'))).toBe(false);
  });

  it('should synchronize new, changed, and removed step fragments for retry worktrees', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt', 'steps'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt', 'steps'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'steps', 'review.yaml'), 'instruction: current\n', 'utf-8');
    writeFileSync(join(projectDir, '.takt', 'steps', 'added.yaml'), 'instruction: added\n', 'utf-8');
    writeFileSync(join(worktreePath, '.takt', 'steps', 'review.yaml'), 'instruction: stale\n', 'utf-8');
    writeFileSync(join(worktreePath, '.takt', 'steps', 'removed.yaml'), 'instruction: removed\n', 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'steps', 'review.yaml'), 'utf-8')).toBe('instruction: current\n');
    expect(readFileSync(join(worktreePath, '.takt', 'steps', 'added.yaml'), 'utf-8')).toBe('instruction: added\n');
    expect(existsSync(join(worktreePath, '.takt', 'steps', 'removed.yaml'))).toBe(false);
  });

  it('should not sync generated quality gate logs into retry worktrees', () => {
    const projectDir = createTempDir('takt-sync-project-');
    const worktreePath = createTempDir('takt-sync-worktree-');
    mkdirSync(join(projectDir, '.takt', 'quality-gates', 'logs'), { recursive: true });
    mkdirSync(join(worktreePath, '.takt', 'quality-gates', 'logs'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'quality-gates', 'check.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    writeFileSync(join(projectDir, '.takt', 'quality-gates', 'logs', 'source.log'), 'source output\n', 'utf-8');
    writeFileSync(join(worktreePath, '.takt', 'quality-gates', 'logs', 'stale.log'), 'stale output\n', 'utf-8');

    syncProjectLocalTaktForRetry(projectDir, worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', 'quality-gates', 'check.sh'), 'utf-8')).toBe(
      '#!/usr/bin/env bash\nexit 0\n',
    );
    expect(existsSync(join(worktreePath, '.takt', 'quality-gates', 'logs'))).toBe(false);
  });
});

describe('ensureWorktreeTaktGitignore', () => {
  it('Given a worktree without .takt/.gitignore, When ensuring takt gitignore, Then built-in project gitignore is created', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');

    ensureWorktreeTaktGitignore(worktreePath);

    expect(readFileSync(join(worktreePath, '.takt', '.gitignore'), 'utf-8')).toBe(readBuiltinProjectDotgitignore());
  });

  it('Given a worktree with existing .takt/.gitignore, When ensuring takt gitignore, Then existing content is preserved', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const existing = '# custom ignore\nruns/\n';
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(join(taktDir, '.gitignore'), existing, 'utf-8');

    ensureWorktreeTaktGitignore(worktreePath);

    expect(readFileSync(join(taktDir, '.gitignore'), 'utf-8')).toBe(existing);
  });

  it('Given a missing worktree path, When ensuring takt gitignore, Then it fails before creating files', () => {
    const parentDir = createTempDir('takt-gitignore-parent-');
    const missingWorktreePath = join(parentDir, 'missing-worktree');

    expect(() => ensureWorktreeTaktGitignore(missingWorktreePath)).toThrow(
      `Worktree path must be an existing directory: ${missingWorktreePath}`,
    );
    expect(existsSync(missingWorktreePath)).toBe(false);
  });

  it('Given .takt is a file, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktPath = join(worktreePath, '.takt');
    writeFileSync(taktPath, 'not a directory\n', 'utf-8');

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt must be a directory or missing: ${taktPath}`,
    );

    expect(readFileSync(taktPath, 'utf-8')).toBe('not a directory\n');
  });

  it('Given .takt is a symlink, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const outsideDir = createTempDir('takt-gitignore-outside-');
    const taktPath = join(worktreePath, '.takt');
    symlinkSync(outsideDir, taktPath);

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt must be a directory or missing: ${taktPath}`,
    );

    expect(lstatSync(taktPath).isSymbolicLink()).toBe(true);
  });

  it('Given a broken .takt/.gitignore symlink, When ensuring takt gitignore, Then it does not write outside the worktree', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const outsideDir = createTempDir('takt-gitignore-outside-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    const externalTarget = join(outsideDir, 'created-through-symlink');
    mkdirSync(taktDir, { recursive: true });
    symlinkSync(externalTarget, gitignorePath);

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt/.gitignore must be a regular file or missing: ${gitignorePath}`,
    );

    expect(existsSync(externalTarget)).toBe(false);
    expect(lstatSync(gitignorePath).isSymbolicLink()).toBe(true);
  });

  it('Given .takt/.gitignore is a directory, When ensuring takt gitignore, Then it fails without replacing it', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    mkdirSync(gitignorePath, { recursive: true });

    expect(() => ensureWorktreeTaktGitignore(worktreePath)).toThrow(
      `Worktree .takt/.gitignore must be a regular file or missing: ${gitignorePath}`,
    );

    expect(lstatSync(gitignorePath).isDirectory()).toBe(true);
  });

  it('Given .takt/.gitignore cannot be inspected, When ensuring takt gitignore, Then it fails without creating a partial file', () => {
    const worktreePath = createTempDir('takt-gitignore-worktree-');
    const taktDir = join(worktreePath, '.takt');
    const gitignorePath = join(taktDir, '.gitignore');
    mkdirSync(taktDir, { recursive: true });
    chmodSync(taktDir, 0o000);

    let thrown: unknown;
    try {
      ensureWorktreeTaktGitignore(worktreePath);
    } catch (error: unknown) {
      thrown = error;
    } finally {
      chmodSync(taktDir, 0o700);
    }

    expect((thrown as NodeJS.ErrnoException).code).toMatch(/^(EACCES|EPERM)$/);
    expect(existsSync(gitignorePath)).toBe(false);
  });
});
