/**
 * Tests for confirmAndCreateWorktree (explicit worktree selection)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(false),
  confirmWithCancel: vi.fn(),
  selectOptionWithDefault: vi.fn(),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
}));

vi.mock('../infra/task/clone.js', () => ({
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
}));

vi.mock('../infra/task/branchList.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  BranchManager: vi.fn(),
}));

vi.mock('../infra/task/autoCommit.js', () => ({
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => {
  const info = vi.fn();
  return {
    info,
    error: vi.fn(),
    success: vi.fn(),
    header: vi.fn(),
    status: vi.fn(),
    setLogLevel: vi.fn(),
    withProgress: vi.fn(async (start, done, operation) => {
      info(start);
      const result = await operation();
      info(typeof done === 'function' ? done(result) : done);
      return result;
    }),
  };
});

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  initDebugLogger: vi.fn(),
  setVerboseConsole: vi.fn(),
  getDebugLogFile: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  initGlobalDirs: vi.fn(),
  initProjectDirs: vi.fn(),
  loadGlobalConfig: vi.fn(() => ({ logLevel: 'info' })),
}));

vi.mock('../infra/config/paths.js', () => ({
  clearPersonaSessions: vi.fn(),
  isVerboseMode: vi.fn(() => false),
}));

vi.mock('../infra/config/loaders/workflowLoader.js', () => ({
  listWorkflows: vi.fn(() => []),
}));

vi.mock('../shared/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/constants.js')>();
  return {
    ...actual,
    DEFAULT_WORKFLOW_NAME: 'default',
  };
});

vi.mock('../infra/github/issue.js', () => ({
  isIssueReference: vi.fn((s: string) => /^#\d+$/.test(s)),
  resolveIssueTask: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForUpdates: vi.fn(),
}));

import { confirm, confirmWithCancel } from '../shared/prompt/index.js';
import { createSharedClone, resolveBaseBranch } from '../infra/task/clone.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { info } from '../shared/ui/index.js';
import { confirmAndCreateWorktree } from '../features/tasks/index.js';

const mockConfirm = vi.mocked(confirm);
const mockConfirmWithCancel = vi.mocked(confirmWithCancel);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockResolveBaseBranch = vi.mocked(resolveBaseBranch);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockInfo = vi.mocked(info);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmAndCreateWorktree', () => {
  it('should display clone info when created', async () => {
    // Given
    mockSummarizeTaskName.mockResolvedValue('my-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-my-task',
      branch: 'takt/20260128T0504-my-task',
    });

    // When
    await confirmAndCreateWorktree('/project', 'my-task', true);

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('/project/../20260128T0504-my-task (branch: takt/20260128T0504-my-task)')
    );
  });

  it('should summarize Japanese task name to English slug', async () => {
    // Given: Japanese task name, AI summarizes to English
    mockSummarizeTaskName.mockResolvedValue('add-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-add-auth',
      branch: 'takt/20260128T0504-add-auth',
    });

    // When
    await confirmAndCreateWorktree('/project', '認証機能を追加する', true);

    // Then
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('認証機能を追加する', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'add-auth',
    });
  });

  it('should skip prompt when override is false', async () => {
    const result = await confirmAndCreateWorktree('/project', 'task', false);

    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockResolveBaseBranch).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
  });

  it('should skip prompt when override is true and still create clone', async () => {
    mockSummarizeTaskName.mockResolvedValue('task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-task',
      branch: 'takt/20260128T0504-task',
    });

    const result = await confirmAndCreateWorktree('/project', 'task', true);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(result).toEqual({
      execCwd: '/project/../20260128T0504-task', isWorktree: true,
      branch: 'takt/20260128T0504-task', baseBranch: 'main', taskSlug: 'task',
    });
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('task', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', { worktree: true, taskSlug: 'task' });
  });

  it('should pass branchOverride to createSharedClone', async () => {
    // Given: branchOverride provided (e.g., PR head branch)
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'fix/pr-branch',
    });

    // When
    await confirmAndCreateWorktree('/project', 'fix auth', true, 'fix/pr-branch');

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', expect.objectContaining({
      branch: 'fix/pr-branch',
    }));
  });

  it('should pass a remote-only PR base to clone before general base validation', async () => {
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'fix/pr-branch',
      pullRequestBaseRef: 'refs/takt/pr-base/release/custom',
      pullRequestHeadRef: 'refs/heads/fix/pr-branch',
    });

    const result = await confirmAndCreateWorktree(
      '/project',
      'fix auth',
      true,
      'fix/pr-branch',
      'release/custom',
      true,
    );

    expect(mockResolveBaseBranch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      baseBranch: 'release/custom',
      pullRequestBaseRef: 'refs/takt/pr-base/release/custom',
      pullRequestHeadRef: 'refs/heads/fix/pr-branch',
    });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', expect.objectContaining({
      baseBranch: 'release/custom',
      pullRequestBaseBranch: 'release/custom',
    }));
  });

  it('should not pass branch to createSharedClone when branchOverride is omitted', async () => {
    // Given: no branchOverride
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'takt/20260128T0504-fix-auth',
    });

    // When
    await confirmAndCreateWorktree('/project', 'fix auth', true);

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'fix-auth',
    });
  });
});
