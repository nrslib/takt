import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
import { mergeBranch, tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';
import { showDiffAndPromptActionForTask } from '../features/tasks/list/taskDiffActions.js';

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
  const worktreeDir = join(sandboxDir, 'task-worktree');
  const branch = 'takt/it-completed-action';

  execFileSync('git', ['init', rootDir, '--initial-branch=main'], { stdio: 'pipe' });
  git(rootDir, ['config', 'user.email', 'test@example.com']);
  git(rootDir, ['config', 'user.name', 'Test User']);
  writeFileSync(join(rootDir, 'README.md'), '# root\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'pipe' });

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

  it('autoCommitAndPush materializes the worktree HEAD to a root local branch', () => {
    const result = autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toContain(fixture.branch);
    expect(git(fixture.rootDir, ['show', `${fixture.branch}:slides/deck.md`])).toContain('# slides');
  });

  it('shows diff stat through the root branch ref after completion', async () => {
    autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    await showDiffAndPromptActionForTask(fixture.rootDir, task);

    const output = mockInfo.mock.calls.flatMap(args => args.map(String)).join('\n');
    expect(output).toContain('slides/deck.md');
    expect(mockWarn).not.toHaveBeenCalledWith('Could not generate diff stat');
  });

  it('try-merge stages changes from the materialized root branch', () => {
    autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    const merged = tryMergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toContain('A  slides/deck.md');
  });

  it('restores a missing root branch from the worktree before try-merge', () => {
    autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    git(fixture.rootDir, ['branch', '-D', fixture.branch]);
    const task = makeCompletedTask(fixture);

    const merged = tryMergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toContain(fixture.branch);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toContain('A  slides/deck.md');
    expect(mockInfo).toHaveBeenCalledWith(`Restored missing root branch ${fixture.branch} from worktree.`);
  });

  it('merge applies changes and removes the root branch ref', () => {
    autoCommitAndPush(fixture.worktreeDir, 'update slides deck', fixture.rootDir, fixture.branch);
    const task = makeCompletedTask(fixture);

    const merged = mergeBranch(fixture.rootDir, task);

    expect(merged).toBe(true);
    expect(git(fixture.rootDir, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.rootDir, ['show', 'HEAD:slides/deck.md'])).toContain('# slides');
    expect(git(fixture.rootDir, ['branch', '--list', fixture.branch])).toBe('');
  });
});
