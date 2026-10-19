import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import type { TaskListItem } from '../infra/task/types.js';

const {
  mockSelectOption,
  mockInfo,
  mockWarn,
  mockHeader,
  mockBlankLine,
  mockSuccess,
  mockError,
} = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockHeader: vi.fn(),
  mockBlankLine: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: mockInfo,
  warn: mockWarn,
  header: mockHeader,
  blankLine: mockBlankLine,
  success: mockSuccess,
  error: mockError,
}));

import { autoCommitAndPush } from '../infra/task/autoCommit.js';
import { deleteBranch, mergeBranch, tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';
import { showDiffAndPromptActionForTask } from '../features/tasks/list/taskDiffActions.js';
import { listTaktBranches } from '../infra/task/branchList.js';
import { deleteTaskResources } from '../features/tasks/list/taskDeleteActions.js';
import { TaskRunner } from '../infra/task/runner.js';
import { getCloneMetaPath, saveCloneMeta } from '../infra/task/clone-meta.js';
import { getWorktreeSessionPath } from '../infra/config/project/sessionStore.js';
import { invalidateGlobalConfigCache } from '../infra/config/index.js';

interface RepoFixture {
  rootDir: string;
  worktreeDir: string;
  branch: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[], encoding: BufferEncoding = 'utf-8'): string {
  return execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    encoding,
  }).trim();
}

function setupRepoFixture(): RepoFixture {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'takt-it-root-branch-'));
  const rootDir = join(sandboxDir, 'root');
  const worktreeBaseDir = join(sandboxDir, 'worktrees');
  const worktreeDir = join(worktreeBaseDir, 'root', 'task-worktree');
  const branch = 'takt/it-completed-action';
  const configDir = process.env.TAKT_CONFIG_DIR;
  if (configDir === undefined) throw new Error('TAKT_CONFIG_DIR must be set by test setup');
  writeFileSync(join(configDir, 'config.yaml'), stringify({ worktree_dir: worktreeBaseDir }));
  invalidateGlobalConfigCache();

  execFileSync('git', ['init', rootDir, '--initial-branch=main'], { stdio: 'pipe' });
  git(rootDir, ['config', 'user.email', 'test@example.com']);
  git(rootDir, ['config', 'user.name', 'Test User']);
  writeFileSync(join(rootDir, 'README.md'), '# root\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'pipe' });

  mkdirSync(dirname(worktreeDir), { recursive: true });
  execFileSync('git', ['clone', rootDir, worktreeDir], { stdio: 'pipe' });
  git(worktreeDir, ['config', 'user.email', 'test@example.com']);
  git(worktreeDir, ['config', 'user.name', 'Test User']);
  execFileSync('git', ['checkout', '-b', branch], { cwd: worktreeDir, stdio: 'pipe' });
  mkdirSync(join(worktreeDir, 'slides'), { recursive: true });
  writeFileSync(join(worktreeDir, 'slides', 'deck.md'), '# slides\n', 'utf-8');

  return {
    rootDir,
    worktreeDir,
    branch,
    cleanup: () => {
      invalidateGlobalConfigCache();
      rmSync(sandboxDir, { recursive: true, force: true });
    },
  };
}

function makeCompletedTask(fixture: RepoFixture): TaskListItem {
  return {
    kind: 'completed',
    name: 'completed-task',
    createdAt: '2026-04-09T08:56:35.617Z',
    filePath: join(fixture.rootDir, '.takt', 'tasks.yaml'),
    content: 'Implement using only the files in `.takt/tasks/20260409-085635-task`.',
    branch: fixture.branch,
    worktreePath: fixture.worktreeDir,
  };
}

function saveCompletedTaskResources(fixture: RepoFixture) {
  const tasksFile = join(fixture.rootDir, '.takt', 'tasks.yaml');
  mkdirSync(dirname(tasksFile), { recursive: true });
  writeFileSync(tasksFile, stringify({ tasks: [{
    name: 'completed-task', status: 'completed', content: 'update slides deck',
    branch: fixture.branch, worktree_path: fixture.worktreeDir,
    created_at: '2026-04-09T08:56:35.617Z', started_at: '2026-04-09T08:57:00.000Z',
    completed_at: '2026-04-09T08:58:00.000Z',
  }] }));
  saveCloneMeta(fixture.rootDir, fixture.branch, fixture.worktreeDir);
  const session = getWorktreeSessionPath(fixture.rootDir, fixture.worktreeDir);
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, JSON.stringify({ personaSessions: { coder: 'fixture-session' } }));
  return { session, meta: getCloneMetaPath(fixture.rootDir, fixture.branch) };
}

describe('completed task actions with root branch materialized on completion', () => {
  let fixture: RepoFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectOption.mockResolvedValue(null);
    fixture = setupRepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('autoCommitAndPush materializes the worktree HEAD to a root local branch', async () => {
    const result = await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(result.commitHash).toBe(git(fixture.worktreeDir, ['rev-parse', '--short', 'HEAD']));
    expect(result.publishedHead).toBe(git(fixture.worktreeDir, ['rev-parse', 'HEAD']));
    expect(git(fixture.rootDir, ['rev-parse', fixture.branch])).toBe(result.publishedHead);
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toContain(fixture.branch);
    expect(git(fixture.rootDir, ['show', `${fixture.branch}:slides/deck.md`])).toContain('# slides');
  });

  it.each([true, false])('publishes clean agent commits and rechecks the same clone after publication (branch specified: %s)', async (specified) => {
    const { worktreeDir, rootDir, branch } = fixture;
    const target = specified ? branch : undefined;
    rmSync(join(worktreeDir, 'slides', 'deck.md'));
    const initial = await autoCommitAndPush(worktreeDir, 'agent task', rootDir, target);
    expect(initial.success).toBe(true);
    expect(initial.publishedHead).toBeUndefined();
    expect(git(rootDir, ['branch', '--list', branch])).toBe('');

    for (const content of ['first agent commit', 'second agent commit']) {
      writeFileSync(join(worktreeDir, 'slides', 'deck.md'), content);
      git(worktreeDir, ['add', '-A']);
      git(worktreeDir, ['commit', '-m', content]);
      const head = git(worktreeDir, ['rev-parse', 'HEAD']);
      expect(git(worktreeDir, ['status', '--porcelain'])).toBe('');

      const published = await autoCommitAndPush(worktreeDir, 'agent task', rootDir, target);
      expect(published.success).toBe(true);
      expect(published.localPushFailed).toBeUndefined();
      expect(published.commitHash).toBeUndefined();
      expect(published.publishedHead).toBe(head);
      expect(git(rootDir, ['rev-parse', branch])).toBe(head);
      expect(git(rootDir, ['show', `${branch}:slides/deck.md`])).toBe(content);

      const repeated = await autoCommitAndPush(worktreeDir, 'agent task', rootDir, target);
      expect(repeated.success).toBe(true);
      expect(repeated.commitHash).toBeUndefined();
      expect(repeated.publishedHead).toBeUndefined();
      expect(repeated.localPushFailed).toBeUndefined();
    }
  });

  it('publishes a clean HEAD even when its object is already present without a published branch', async () => {
    const { worktreeDir, rootDir, branch } = fixture;
    git(worktreeDir, ['add', '-A']);
    git(worktreeDir, ['commit', '-m', 'agent commit']);
    const head = git(worktreeDir, ['rev-parse', 'HEAD']);
    git(rootDir, ['fetch', '--no-write-fetch-head', worktreeDir, 'HEAD']);

    const result = await autoCommitAndPush(worktreeDir, 'agent task', rootDir, branch);

    expect(result.publishedHead).toBe(head);
    expect(result.commitHash).toBeUndefined();
    expect(git(rootDir, ['rev-parse', branch])).toBe(head);
  });

  it.each(['refs/heads/other-base', 'refs/remotes/origin/other-base'])('does not create a result branch when clean HEAD is already reachable from %s', async (baseRef) => {
    const { worktreeDir, rootDir, branch } = fixture;
    git(worktreeDir, ['add', '-A']);
    git(worktreeDir, ['commit', '-m', 'other base']);
    const head = git(worktreeDir, ['rev-parse', 'HEAD']);
    git(rootDir, ['fetch', worktreeDir, `HEAD:${baseRef}`]);

    const result = await autoCommitAndPush(worktreeDir, 'unchanged task', rootDir, branch);

    expect(result.success).toBe(true);
    expect(result.publishedHead).toBeUndefined();
    expect(result.localPushFailed).toBeUndefined();
    expect(git(rootDir, ['branch', '--list', branch])).toBe('');
    expect(git(rootDir, ['rev-parse', baseRef])).toBe(head);
  });

  it.each([true, false])('reports publication rejection for a clean divergent HEAD (branch specified: %s)', async (specified) => {
    const { worktreeDir, rootDir, branch } = fixture;
    git(worktreeDir, ['add', '-A']);
    git(worktreeDir, ['commit', '-m', 'agent commit']);
    git(rootDir, ['checkout', '-b', branch]);
    writeFileSync(join(rootDir, 'README.md'), 'divergent root commit');
    git(rootDir, ['add', '-A']);
    git(rootDir, ['commit', '-m', 'root commit']);
    const rootHead = git(rootDir, ['rev-parse', 'HEAD']);
    git(rootDir, ['checkout', 'main']);

    const result = await autoCommitAndPush(worktreeDir, 'agent task', rootDir, specified ? branch : undefined);

    expect(result.localPushFailed).toBe(true);
    expect(result.commitHash).toBeUndefined();
    expect(result.publishedHead).toBeUndefined();
    expect(git(rootDir, ['rev-parse', branch])).toBe(rootHead);
    expect(git(worktreeDir, ['status', '--porcelain'])).toBe('');
  });

  it('shows diff stat through the root branch ref after completion', async () => {
    await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    await showDiffAndPromptActionForTask(fixture.rootDir, task);

    const output = mockInfo.mock.calls.flatMap(args => args.map(String)).join('\n');
    expect(output).toContain('slides/deck.md');
  });

  it('try-merge stages changes from the materialized root branch', async () => {
    await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    const merged = tryMergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toContain('A  slides/deck.md');
  });

  it('restores a missing root branch from the worktree before try-merge', async () => {
    await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    git(fixture.rootDir, ['branch', '-D', fixture.branch]);
    const task = makeCompletedTask(fixture);

    const merged = tryMergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toContain(fixture.branch);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toContain('A  slides/deck.md');
    expect(mockInfo).toHaveBeenCalledWith(`Restored missing root branch ${fixture.branch} from worktree.`);
  });

  it('merge applies changes and removes the root branch ref', async () => {
    await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    const merged = mergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.rootDir, ['show', 'HEAD:slides/deck.md'])).toContain('# slides');
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toBe('');
  });
});

describe('branch deletion', () => {
  let fixture: RepoFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectOption.mockResolvedValue(null);
    fixture = setupRepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('deletes a merged published root branch and all clone task resources', async () => {
    const published = await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    expect(published.success).toBe(true);
    expect(git(fixture.rootDir, ['rev-parse', fixture.branch])).toBe(published.publishedHead);
    git(fixture.rootDir, ['merge', '--ff-only', fixture.branch]);
    git(fixture.worktreeDir, ['remote', 'remove', 'origin']);
    expect(git(fixture.worktreeDir, ['remote'])).toBe('');
    const resources = saveCompletedTaskResources(fixture);
    const runner = new TaskRunner(fixture.rootDir);
    const task = runner.listAllTaskItems()[0]!;
    expect(task).toMatchObject({ kind: 'completed', branch: fixture.branch, worktreePath: fixture.worktreeDir });
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(true);

    const result = deleteTaskResources(task);

    expect(result).toBe(true);
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(false);
    expect(runner.listAllTaskItems()).toEqual([]);
    expect(git(fixture.rootDir, ['for-each-ref', '--format=%(refname)', `refs/heads/${fixture.branch}`])).toBe('');
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it.each([
    ['matching', true], ['matching', false],
    ['different', true], ['different', false],
    ['detached', true], ['detached', false],
  ] as const)('deletes a saved task and only deletes its root ref when merged (clone HEAD: %s, merged: %s)', async (head, merged) => {
    const published = await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    expect(published.success).toBe(true);
    if (merged) git(fixture.rootDir, ['merge', '--ff-only', fixture.branch]);
    const recordedBranch = 'feature/unrelated';
    git(fixture.rootDir, ['branch', recordedBranch, fixture.branch]);
    const originalHead = git(fixture.rootDir, ['rev-parse', recordedBranch]);
    expect(originalHead).toBe(git(fixture.worktreeDir, ['rev-parse', 'HEAD']));
    expect(git(fixture.rootDir, ['rev-list', '--count', `HEAD..${recordedBranch}`])).toBe(merged ? '0' : '1');
    if (head === 'matching') git(fixture.worktreeDir, ['checkout', '-b', recordedBranch]);
    if (head === 'detached') git(fixture.worktreeDir, ['checkout', '--detach']);
    const resources = saveCompletedTaskResources({ ...fixture, branch: recordedBranch });
    const runner = new TaskRunner(fixture.rootDir);
    const task = runner.listAllTaskItems()[0]!;
    expect(task).toMatchObject({ branch: recordedBranch, worktreePath: fixture.worktreeDir });
    expect(git(fixture.worktreeDir, ['branch', '--show-current']))
      .toBe(head === 'detached' ? '' : head === 'matching' ? recordedBranch : fixture.branch);
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(true);

    expect(deleteTaskResources(task)).toBe(true);

    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(false);
    expect(runner.listAllTaskItems()).toEqual([]);
    expect(git(fixture.rootDir, ['rev-parse', fixture.branch])).toBe(originalHead);
    const remainingRef = git(fixture.rootDir, ['for-each-ref', '--format=%(refname)', `refs/heads/${recordedBranch}`]);
    if (merged) {
      expect(remainingRef).toBe('');
      expect(mockWarn).not.toHaveBeenCalled();
    } else {
      expect(remainingRef).toBe(`refs/heads/${recordedBranch}`);
      expect(git(fixture.rootDir, ['rev-parse', recordedBranch])).toBe(originalHead);
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining(recordedBranch));
    }
    expect(mockError).not.toHaveBeenCalled();
  });

  it.each(['untracked', 'index', 'HEAD', 'HEAD with staged deletion'])(
    'checks task record provenance before deleting a ref matching another clone HEAD (%s)', (tracking) => {
      const recordedBranch = 'feature/unrelated';
      git(fixture.rootDir, ['branch', recordedBranch]);
      const originalHead = git(fixture.rootDir, ['rev-parse', recordedBranch]);
      const otherClone = join(dirname(fixture.worktreeDir), 'other-clone');
      git(fixture.rootDir, ['clone', '--branch', recordedBranch, fixture.rootDir, otherClone]);
      git(otherClone, ['remote', 'remove', 'origin']);
      const resources = saveCompletedTaskResources({ ...fixture, branch: recordedBranch, worktreeDir: otherClone });
      const tasksPath = '.takt/tasks.yaml';
      if (tracking !== 'untracked') git(fixture.rootDir, ['add', '--', tasksPath]);
      if (tracking.startsWith('HEAD')) git(fixture.rootDir, ['commit', '-m', 'include task record']);
      if (tracking === 'HEAD with staged deletion') git(fixture.rootDir, ['rm', '--cached', '--', tasksPath]);
      expect(git(fixture.rootDir, ['ls-files', '--', tasksPath]) !== '').toBe(tracking === 'index' || tracking === 'HEAD');
      expect(git(fixture.rootDir, ['ls-tree', '--name-only', 'HEAD', '--', tasksPath]) !== '').toBe(tracking.startsWith('HEAD'));
      expect(git(otherClone, ['symbolic-ref', '--quiet', 'HEAD'])).toBe(`refs/heads/${recordedBranch}`);
      expect(git(fixture.rootDir, ['rev-list', '--count', `HEAD..${recordedBranch}`])).toBe('0');
      const runner = new TaskRunner(fixture.rootDir);
      const task = runner.listAllTaskItems()[0]!;
      expect(task).toMatchObject({ branch: recordedBranch, worktreePath: otherClone });
      for (const path of [otherClone, ...Object.values(resources)]) expect(existsSync(path)).toBe(true);

      expect(deleteTaskResources(task)).toBe(tracking === 'untracked');

      for (const path of [otherClone, ...Object.values(resources)]) expect(existsSync(path)).toBe(tracking !== 'untracked');
      expect(existsSync(fixture.worktreeDir)).toBe(true);
      expect(runner.listAllTaskItems()).toEqual(tracking === 'untracked' ? [] : [task]);
      const remainingRef = git(fixture.rootDir, ['for-each-ref', '--format=%(refname)', `refs/heads/${recordedBranch}`]);
      if (tracking === 'untracked') {
        expect(remainingRef).toBe('');
        expect(mockWarn).not.toHaveBeenCalled();
      } else {
        expect(remainingRef).toBe(`refs/heads/${recordedBranch}`);
        expect(git(fixture.rootDir, ['rev-parse', recordedBranch])).toBe(originalHead);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining(recordedBranch));
      }
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('preserves both clones when metadata points elsewhere (recorded clone missing: %s)', (missing) => {
    const resources = saveCompletedTaskResources(fixture);
    const otherClone = join(dirname(fixture.worktreeDir), 'other-clone');
    git(fixture.rootDir, ['clone', fixture.rootDir, otherClone]);
    const otherFile = join(otherClone, 'keep.txt');
    writeFileSync(otherFile, 'keep the other clone');
    saveCloneMeta(fixture.rootDir, fixture.branch, otherClone);
    if (missing) rmSync(fixture.worktreeDir, { recursive: true });
    const runner = new TaskRunner(fixture.rootDir);
    const task = runner.listAllTaskItems()[0]!;

    expect(deleteTaskResources(task)).toBe(false);

    expect(existsSync(fixture.worktreeDir)).toBe(!missing);
    expect(readFileSync(otherFile, 'utf8')).toBe('keep the other clone');
    for (const path of Object.values(resources)) expect(existsSync(path)).toBe(true);
    expect(runner.listAllTaskItems()).toEqual([task]);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('preserves a symbolic link used as the recorded clone path', () => {
    const resources = saveCompletedTaskResources(fixture);
    const link = join(dirname(fixture.worktreeDir), 'clone-link');
    symlinkSync(fixture.worktreeDir, link, 'dir');
    saveCloneMeta(fixture.rootDir, fixture.branch, link);
    const task = { ...makeCompletedTask(fixture), worktreePath: link };

    expect(deleteBranch(fixture.rootDir, task)).toBe(false);

    expect(readFileSync(join(link, 'slides', 'deck.md'), 'utf8')).toBe('# slides\n');
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(true);
  });

  it('cleans up a verified clone in the project fallback directory with the same cleanup boundary', () => {
    const fallbackClone = join(fixture.rootDir, '.takt', 'worktrees', 'fallback-clone');
    mkdirSync(dirname(fallbackClone), { recursive: true });
    git(fixture.rootDir, ['clone', fixture.rootDir, fallbackClone]);
    git(fallbackClone, ['checkout', '-b', fixture.branch]);
    const resources = saveCompletedTaskResources({ ...fixture, worktreeDir: fallbackClone });
    const runner = new TaskRunner(fixture.rootDir);

    expect(deleteTaskResources(runner.listAllTaskItems()[0]!)).toBe(true);

    for (const path of [fallbackClone, ...Object.values(resources)]) expect(existsSync(path)).toBe(false);
    expect(runner.listAllTaskItems()).toEqual([]);
  });

  it('retains an unmerged published root branch while deleting clone resources and the task record', async () => {
    const published = await autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    expect(published.success).toBe(true);
    const publishedHead = git(fixture.rootDir, ['rev-parse', fixture.branch]);
    expect(publishedHead).toBe(published.publishedHead);
    expect(git(fixture.rootDir, ['rev-list', '--count', `HEAD..${fixture.branch}`])).toBe('1');
    const resources = saveCompletedTaskResources(fixture);
    const runner = new TaskRunner(fixture.rootDir);
    const task = runner.listAllTaskItems()[0]!;
    expect(task).toMatchObject({ kind: 'completed', branch: fixture.branch, worktreePath: fixture.worktreeDir });
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(true);

    const result = deleteTaskResources(task);

    expect(result).toBe(true);
    for (const path of [fixture.worktreeDir, ...Object.values(resources)]) expect(existsSync(path)).toBe(false);
    expect(runner.listAllTaskItems()).toEqual([]);
    expect(git(fixture.rootDir, ['rev-parse', fixture.branch])).toBe(publishedHead);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining(fixture.branch));
    expect(mockError).not.toHaveBeenCalled();
  });

  it('should delete regular branches normally', () => {
    const repoDir = fixture.rootDir;
    const defaultBranch = git(repoDir, ['branch', '--show-current']);

    // Create a regular local branch
    const branchName = 'takt/20260203T1002-regular-branch';
    execFileSync('git', ['checkout', '-b', branchName], { cwd: repoDir, stdio: 'pipe' });

    // Make a change
    writeFileSync(join(repoDir, 'test.txt'), 'test content');
    execFileSync('git', ['add', 'test.txt'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Test change'], { cwd: repoDir, stdio: 'pipe' });

    // Switch back to main
    execFileSync('git', ['checkout', defaultBranch || 'main'], { cwd: repoDir, stdio: 'pipe' });

    // Verify branch exists
    const branchesBefore = listTaktBranches(repoDir);
    const foundBefore = branchesBefore.find(b => b.branch === branchName);
    expect(foundBefore).toBeDefined();
    expect(foundBefore?.worktreePath).toBeUndefined();

    // Delete branch
    const result = deleteBranch(repoDir, {
      info: foundBefore!,
      originalInstruction: 'Test instruction',
    });

    // Verify deletion succeeded
    expect(result).toBe(true);

    // Verify branch is no longer listed
    const branchesAfter = listTaktBranches(repoDir);
    const foundAfter = branchesAfter.find(b => b.branch === branchName);
    expect(foundAfter).toBeUndefined();
  });
});
