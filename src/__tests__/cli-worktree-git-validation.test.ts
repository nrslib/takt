/**
 * Tests for git state validation in worktree creation flow
 *
 * Covers:
 * - confirmAndCreateWorktree: git readiness check before clone creation
 * - selectAndExecuteTask: null result handling when user declines fallback
 * - resolveExecutionContext: pipeline mode fallback behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockCheckGitCloneReadiness,
  mockAddTask,
  mockCompleteTask,
  mockFailTask,
  mockExecuteTask,
} = vi.hoisted(() => ({
  mockCheckGitCloneReadiness: vi.fn(),
  mockAddTask: vi.fn(() => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-03-01T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockCompleteTask: vi.fn(),
  mockFailTask: vi.fn(),
  mockExecuteTask: vi.fn(),
}));

// ---- Module mocks ----

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  selectOptionWithDefault: vi.fn(),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
  pushBranch: vi.fn(),
  checkGitCloneReadiness: (...args: unknown[]) => mockCheckGitCloneReadiness(...args),
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

vi.mock('../infra/task/runner.js', () => ({
  TaskRunner: vi.fn(() => ({
    addTask: (...args: unknown[]) => mockAddTask(...args),
    completeTask: (...args: unknown[]) => mockCompleteTask(...args),
    failTask: (...args: unknown[]) => mockFailTask(...args),
  })),
}));

vi.mock('../shared/ui/index.js', () => {
  const info = vi.fn();
  const warn = vi.fn();
  return {
    info,
    warn,
    error: vi.fn(),
    success: vi.fn(),
    header: vi.fn(),
    status: vi.fn(),
    setLogLevel: vi.fn(),
    withProgress: vi.fn(async (start: string, done: unknown, operation: () => Promise<unknown>) => {
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
  resolvePieceConfigValue: vi.fn(),
  listPieces: vi.fn(() => ['default']),
  listPieceEntries: vi.fn(() => []),
  loadPieceByIdentifier: vi.fn((identifier: string) => (identifier === 'default' ? { name: 'default' } : null)),
  isPiecePath: vi.fn(() => false),
  resolveConfigValue: vi.fn(() => undefined),
}));

vi.mock('../infra/config/paths.js', () => ({
  clearPersonaSessions: vi.fn(),
  isVerboseMode: vi.fn(() => false),
}));

vi.mock('../infra/config/loaders/pieceLoader.js', () => ({
  listPieces: vi.fn(() => []),
}));

vi.mock('../shared/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/constants.js')>();
  return {
    ...actual,
    DEFAULT_PIECE_NAME: 'default',
  };
});

vi.mock('../infra/github/issue.js', () => ({
  isIssueReference: vi.fn((s: string) => /^#\d+$/.test(s)),
  resolveIssueTask: vi.fn(),
}));

vi.mock('../infra/github/index.js', () => ({
  buildPrBody: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  warnMissingPieces: vi.fn(),
  selectPieceFromCategorizedPieces: vi.fn(),
  selectPieceFromEntries: vi.fn(),
  selectPiece: vi.fn(),
}));

// ---- Imports ----

import { confirm } from '../shared/prompt/index.js';
import { createSharedClone } from '../infra/task/clone.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { warn } from '../shared/ui/index.js';
import { confirmAndCreateWorktree, selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';

const mockConfirm = vi.mocked(confirm);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

// ---- Tests: confirmAndCreateWorktree git validation ----

describe('confirmAndCreateWorktree git state validation', () => {
  describe('when git repo is not initialized (not_git_repo)', () => {
    beforeEach(() => {
      mockCheckGitCloneReadiness.mockReturnValue({ ready: false, reason: 'not_git_repo' });
    });

    it('should warn and offer fallback when interactive (no override)', async () => {
      // Given: user confirms worktree creation, then accepts fallback
      mockConfirm
        .mockResolvedValueOnce(true)   // "Create worktree?"
        .mockResolvedValueOnce(true);  // "Run in current directory instead?"

      // When
      const result = await confirmAndCreateWorktree('/project', 'fix bug');

      // Then: falls back to in-place execution
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockWarn).toHaveBeenCalled();
      expect(mockCreateSharedClone).not.toHaveBeenCalled();
    });

    it('should return null when user declines fallback in interactive mode', async () => {
      // Given: user confirms worktree, then declines fallback
      mockConfirm
        .mockResolvedValueOnce(true)   // "Create worktree?"
        .mockResolvedValueOnce(false); // "Run in current directory instead?" → No

      // When
      const result = await confirmAndCreateWorktree('/project', 'fix bug');

      // Then: returns null (caller should save task and exit)
      expect(result).toBeNull();
      expect(mockCreateSharedClone).not.toHaveBeenCalled();
    });

    it('should auto-fallback when override is true (pipeline mode)', async () => {
      // Given: override=true (pipeline mode, non-interactive)

      // When
      const result = await confirmAndCreateWorktree('/project', 'fix bug', true);

      // Then: auto-fallback to in-place execution
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockWarn).toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCreateSharedClone).not.toHaveBeenCalled();
    });
  });

  describe('when git repo has no commits (no_commits)', () => {
    beforeEach(() => {
      mockCheckGitCloneReadiness.mockReturnValue({ ready: false, reason: 'no_commits' });
    });

    it('should warn and offer fallback when interactive (no override)', async () => {
      // Given: user confirms worktree creation, then accepts fallback
      mockConfirm
        .mockResolvedValueOnce(true)   // "Create worktree?"
        .mockResolvedValueOnce(true);  // "Run in current directory instead?"

      // When
      const result = await confirmAndCreateWorktree('/project', 'add feature');

      // Then: falls back to in-place execution
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockWarn).toHaveBeenCalled();
      expect(mockCreateSharedClone).not.toHaveBeenCalled();
    });

    it('should return null when user declines fallback in interactive mode', async () => {
      // Given: user confirms worktree, then declines fallback
      mockConfirm
        .mockResolvedValueOnce(true)   // "Create worktree?"
        .mockResolvedValueOnce(false); // "Run in current directory instead?" → No

      // When
      const result = await confirmAndCreateWorktree('/project', 'add feature');

      // Then
      expect(result).toBeNull();
    });

    it('should auto-fallback when override is true (pipeline mode)', async () => {
      // Given: override=true (pipeline mode)

      // When
      const result = await confirmAndCreateWorktree('/project', 'add feature', true);

      // Then: auto-fallback
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockWarn).toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe('when git repo is ready (normal case)', () => {
    beforeEach(() => {
      mockCheckGitCloneReadiness.mockReturnValue({ ready: true });
    });

    it('should proceed with clone creation when git is ready', async () => {
      // Given: user confirms worktree, git is ready
      mockConfirm.mockResolvedValueOnce(true);
      mockSummarizeTaskName.mockResolvedValue('fix-auth');
      mockCreateSharedClone.mockReturnValue({
        path: '/project/../20260301T0000-fix-auth',
        branch: 'takt/20260301T0000-fix-auth',
      });

      // When
      const result = await confirmAndCreateWorktree('/project', 'fix auth');

      // Then: clone is created normally
      expect(result.isWorktree).toBe(true);
      expect(result.execCwd).toBe('/project/../20260301T0000-fix-auth');
      expect(mockCreateSharedClone).toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should not check git readiness when user declines worktree', async () => {
      // Given: user declines worktree creation
      mockConfirm.mockResolvedValueOnce(false);

      // When
      const result = await confirmAndCreateWorktree('/project', 'fix auth');

      // Then: no readiness check, returns cwd directly
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockCheckGitCloneReadiness).not.toHaveBeenCalled();
    });

    it('should not check git readiness when override is false', async () => {
      // Given: override=false (worktree explicitly disabled)

      // When
      const result = await confirmAndCreateWorktree('/project', 'task', false);

      // Then
      expect(result).toEqual({ execCwd: '/project', isWorktree: false });
      expect(mockCheckGitCloneReadiness).not.toHaveBeenCalled();
    });
  });
});

// ---- Tests: selectAndExecuteTask null handling ----

describe('selectAndExecuteTask with git validation', () => {
  it('should save task and return when confirmAndCreateWorktree returns null', async () => {
    // Given: git repo not ready, user declines fallback → confirmAndCreateWorktree returns null
    mockCheckGitCloneReadiness.mockReturnValue({ ready: false, reason: 'not_git_repo' });
    mockConfirm
      .mockResolvedValueOnce(true)   // "Create worktree?"
      .mockResolvedValueOnce(false); // "Run in current directory?" → No

    // When
    await selectAndExecuteTask('/project', 'fix bug', { piece: 'default' });

    // Then: task is saved to queue and execution does not proceed
    expect(mockAddTask).toHaveBeenCalledWith('fix bug', expect.objectContaining({
      piece: 'default',
    }));
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('should execute task in-place when user accepts fallback', async () => {
    // Given: git repo not ready, user accepts fallback
    mockCheckGitCloneReadiness.mockReturnValue({ ready: false, reason: 'no_commits' });
    mockConfirm
      .mockResolvedValueOnce(true)   // "Create worktree?"
      .mockResolvedValueOnce(true);  // "Run in current directory?" → Yes

    mockExecuteTask.mockResolvedValue(true);

    // When
    await selectAndExecuteTask('/project', 'fix bug', { piece: 'default' });

    // Then: task executes in original cwd (not worktree)
    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project',
      pieceIdentifier: 'default',
    }));
  });
});

// ---- Tests: resolveExecutionContext pipeline fallback ----

describe('resolveExecutionContext pipeline git validation', () => {
  // resolveExecutionContext uses confirmAndCreateWorktree with override=true,
  // which triggers auto-fallback when git is not ready.
  // We test this through the pipeline execution path.

  it('should fall back to in-place execution when git is not ready in pipeline mode', async () => {
    // Given: git repo not ready, pipeline mode with createWorktree=true
    mockCheckGitCloneReadiness.mockReturnValue({ ready: false, reason: 'not_git_repo' });

    // Import resolveExecutionContext to test directly
    const { resolveExecutionContext } = await import('../features/pipeline/steps.js');

    // When
    const result = await resolveExecutionContext(
      '/project',
      'fix bug',
      { createWorktree: true },
      undefined,
    );

    // Then: falls back to in-place execution
    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
  });

  it('should proceed normally when git is ready in pipeline mode', async () => {
    // Given: git repo is ready, pipeline mode
    mockCheckGitCloneReadiness.mockReturnValue({ ready: true });
    mockSummarizeTaskName.mockResolvedValue('fix-bug');
    mockCreateSharedClone.mockReturnValue({
      path: '/tmp/worktree',
      branch: 'takt/fix-bug',
    });

    const { resolveExecutionContext } = await import('../features/pipeline/steps.js');

    // When
    const result = await resolveExecutionContext(
      '/project',
      'fix bug',
      { createWorktree: true },
      undefined,
    );

    // Then: worktree is created normally
    expect(result.isWorktree).toBe(true);
    expect(result.execCwd).toBe('/tmp/worktree');
    expect(mockCreateSharedClone).toHaveBeenCalled();
  });
});
