/**
 * Tests for issue resolution in routing module.
 *
 * Verifies that issue references (--issue N or #N positional arg)
 * are resolved before interactive mode and passed to selectAndExecuteTask
 * via selectOptions.issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/prompt/index.js', () => ({
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/issue.js', () => ({
  parseIssueNumbers: vi.fn(() => []),
  checkGhCli: vi.fn(),
  fetchIssue: vi.fn(),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  createIssue: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: vi.fn(),
  determinePiece: vi.fn(),
  saveTaskFromInteractive: vi.fn(),
  createIssueFromTask: vi.fn(),
}));

vi.mock('../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
  selectInteractiveMode: vi.fn(() => 'assistant'),
  passthroughMode: vi.fn(),
  quietMode: vi.fn(),
  personaMode: vi.fn(),
  resolveLanguage: vi.fn(() => 'en'),
  selectRun: vi.fn(() => null),
  loadRunSessionContext: vi.fn(),
  listRecentRuns: vi.fn(() => []),
  normalizeTaskHistorySummary: vi.fn((items: unknown[]) => items),
  dispatchConversationAction: vi.fn(async (result: { action: string }, handlers: Record<string, (r: unknown) => unknown>) => {
    return handlers[result.action](result);
  }),
}));

const mockListAllTaskItems = vi.fn();
const mockIsStaleRunningTask = vi.fn();
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn(() => ({
    listAllTaskItems: mockListAllTaskItems,
  })),
  isStaleRunningTask: (...args: unknown[]) => mockIsStaleRunningTask(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  getPieceDescription: vi.fn(() => ({ name: 'default', description: 'test piece', pieceStructure: '', movementPreviews: [] })),
  resolveConfigValue: vi.fn((_: string, key: string) => (key === 'piece' ? 'default' : false)),
  resolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' })),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../shared/constants.js', () => ({
  DEFAULT_PIECE_NAME: 'default',
}));

const mockOpts: Record<string, unknown> = {};

vi.mock('../app/cli/program.js', () => {
  const chainable = {
    opts: vi.fn(() => mockOpts),
    argument: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  };
  return {
    program: chainable,
    resolvedCwd: '/test/cwd',
    pipelineMode: false,
  };
});

vi.mock('../app/cli/helpers.js', () => ({
  resolveAgentOverrides: vi.fn(),
  parseCreateWorktreeOption: vi.fn(),
  isDirectTask: vi.fn(() => false),
}));

import { checkGhCli, fetchIssue, formatIssueAsTask, parseIssueNumbers } from '../infra/github/issue.js';
import { selectAndExecuteTask, determinePiece, createIssueFromTask, saveTaskFromInteractive } from '../features/tasks/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { resolveConfigValues, loadPersonaSessions } from '../infra/config/index.js';
import { isDirectTask } from '../app/cli/helpers.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { info } from '../shared/ui/index.js';
import type { GitHubIssue } from '../infra/github/types.js';

const mockCheckGhCli = vi.mocked(checkGhCli);
const mockFetchIssue = vi.mocked(fetchIssue);
const mockFormatIssueAsTask = vi.mocked(formatIssueAsTask);
const mockParseIssueNumbers = vi.mocked(parseIssueNumbers);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockCreateIssueFromTask = vi.mocked(createIssueFromTask);
const mockSaveTaskFromInteractive = vi.mocked(saveTaskFromInteractive);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockLoadPersonaSessions = vi.mocked(loadPersonaSessions);
const mockResolveConfigValues = vi.mocked(resolveConfigValues);
const mockIsDirectTask = vi.mocked(isDirectTask);
const mockInfo = vi.mocked(info);
const mockTaskRunnerListAllTaskItems = vi.mocked(mockListAllTaskItems);

function createMockIssue(number: number): GitHubIssue {
  return {
    number,
    title: `Issue #${number}`,
    body: `Body of issue #${number}`,
    labels: [],
    comments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset opts
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  // Default setup
  mockDeterminePiece.mockResolvedValue('default');
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'summarized task' });
  mockIsDirectTask.mockReturnValue(false);
  mockParseIssueNumbers.mockReturnValue([]);
  mockTaskRunnerListAllTaskItems.mockReturnValue([]);
  mockIsStaleRunningTask.mockReturnValue(false);
});

describe('Issue resolution in routing', () => {
  describe('--issue option', () => {
    it('should resolve issue and pass to interactive mode when --issue is specified', async () => {
      // Given
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckGhCli.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## GitHub Issue #131: Issue #131');

      // When
      await executeDefaultAction();

      // Then: issue should be fetched
      expect(mockFetchIssue).toHaveBeenCalledWith(131);

      // Then: interactive mode should receive the formatted issue as initial input
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        '## GitHub Issue #131: Issue #131',
        expect.anything(),
        undefined,
      );

      // Then: selectAndExecuteTask should receive issues in options
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          issues: [issue131],
        }),
        undefined,
      );
    });

    it('should exit with error when gh CLI is unavailable for --issue', async () => {
      // Given
      mockOpts.issue = 131;
      mockCheckGhCli.mockReturnValue({
        available: false,
        error: 'gh CLI is not installed',
      });

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When / Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockInteractiveMode).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });
  });

  describe('#N positional argument', () => {
    it('should resolve issue reference and pass to interactive mode', async () => {
      // Given
      const issue131 = createMockIssue(131);
      mockIsDirectTask.mockReturnValue(true);
      mockCheckGhCli.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## GitHub Issue #131: Issue #131');
      mockParseIssueNumbers.mockReturnValue([131]);

      // When
      await executeDefaultAction('#131');

      // Then: interactive mode should be entered with formatted issue
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        '## GitHub Issue #131: Issue #131',
        expect.anything(),
        undefined,
      );

      // Then: selectAndExecuteTask should receive issues
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          issues: [issue131],
        }),
        undefined,
      );
    });
  });

  describe('non-issue input', () => {
    it('should pass regular text input to interactive mode without issues', async () => {
      // When
      await executeDefaultAction('refactor the code');

      // Then: interactive mode should receive the original text
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        'refactor the code',
        expect.anything(),
        undefined,
      );

      // Then: no issue fetching should occur
      expect(mockFetchIssue).not.toHaveBeenCalled();

      // Then: selectAndExecuteTask should be called without issues
      const callArgs = mockSelectAndExecuteTask.mock.calls[0];
      expect(callArgs?.[2]?.issues).toBeUndefined();
    });

    it('should enter interactive mode with no input when no args provided', async () => {
      // When
      await executeDefaultAction();

      // Then: interactive mode should be entered with undefined input
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
      );

      // Then: no issue fetching should occur
      expect(mockFetchIssue).not.toHaveBeenCalled();
    });
  });

  describe('task history injection', () => {
    it('should include failed/completed/interrupted tasks in pieceContext for interactive mode', async () => {
      const failedTask = {
        kind: 'failed' as const,
        name: 'failed-task',
        createdAt: '2026-02-17T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'failed',
        worktreePath: '/tmp/task/failed',
        branch: 'takt/failed',
        startedAt: '2026-02-17T00:00:00.000Z',
        completedAt: '2026-02-17T00:10:00.000Z',
        failure: { error: 'syntax error' },
      };
      const completedTask = {
        kind: 'completed' as const,
        name: 'completed-task',
        createdAt: '2026-02-16T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'done',
        worktreePath: '/tmp/task/completed',
        branch: 'takt/completed',
        startedAt: '2026-02-16T00:00:00.000Z',
        completedAt: '2026-02-16T00:07:00.000Z',
      };
      const runningTask = {
        kind: 'running' as const,
        name: 'running-task',
        createdAt: '2026-02-15T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'running',
        worktreePath: '/tmp/task/interrupted',
        ownerPid: 555,
        startedAt: '2026-02-15T00:00:00.000Z',
      };
      mockTaskRunnerListAllTaskItems.mockReturnValue([failedTask, completedTask, runningTask]);
      mockIsStaleRunningTask.mockReturnValue(true);

      // When
      await executeDefaultAction('add feature');

      // Then
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        'add feature',
        expect.objectContaining({
          taskHistory: expect.arrayContaining([
            expect.objectContaining({
              worktreeId: '/tmp/task/failed',
              status: 'failed',
              finalResult: 'failed',
              logKey: 'takt/failed',
            }),
            expect.objectContaining({
              worktreeId: '/tmp/task/completed',
              status: 'completed',
              finalResult: 'completed',
              logKey: 'takt/completed',
            }),
            expect.objectContaining({
              worktreeId: '/tmp/task/interrupted',
              status: 'interrupted',
              finalResult: 'interrupted',
              logKey: '/tmp/task/interrupted',
            }),
          ]),
        }),
        undefined,
      );
    });

    it('should treat running tasks with no ownerPid as interrupted', async () => {
      const runningTaskWithoutPid = {
        kind: 'running' as const,
        name: 'running-task-no-owner',
        createdAt: '2026-02-15T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'running',
        worktreePath: '/tmp/task/running-no-owner',
        branch: 'takt/running-no-owner',
        startedAt: '2026-02-15T00:00:00.000Z',
      };
      mockTaskRunnerListAllTaskItems.mockReturnValue([runningTaskWithoutPid]);
      mockIsStaleRunningTask.mockReturnValue(true);

      await executeDefaultAction('recover interrupted');

      expect(mockIsStaleRunningTask).toHaveBeenCalledWith(undefined);
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        'recover interrupted',
        expect.objectContaining({
          taskHistory: expect.arrayContaining([
            expect.objectContaining({
              worktreeId: '/tmp/task/running-no-owner',
              status: 'interrupted',
              finalResult: 'interrupted',
              logKey: 'takt/running-no-owner',
            }),
          ]),
        }),
        undefined,
      );
    });

    it('should continue interactive mode when task list retrieval fails', async () => {
      mockTaskRunnerListAllTaskItems.mockImplementation(() => {
        throw new Error('list failed');
      });

      // When
      await executeDefaultAction('fix issue');

      // Then
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        'fix issue',
        expect.objectContaining({ taskHistory: [] }),
        undefined,
      );
    });

    it('should pass empty taskHistory when task list is empty', async () => {
      mockTaskRunnerListAllTaskItems.mockReturnValue([]);

      await executeDefaultAction('verify history');

      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        'verify history',
        expect.objectContaining({ taskHistory: [] }),
        undefined,
      );
    });
  });

  describe('interactive mode cancel', () => {
    it('should not call selectAndExecuteTask when interactive mode is cancelled', async () => {
      // Given
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckGhCli.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## GitHub Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'cancel', task: '' });

      // When
      await executeDefaultAction();

      // Then
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    });
  });

  describe('create_issue action', () => {
    it('should create issue first, then delegate final confirmation to saveTaskFromInteractive', async () => {
      // Given
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature request' });
      mockCreateIssueFromTask.mockReturnValue(226);

      // When
      await executeDefaultAction();

      // Then: issue is created first
      expect(mockCreateIssueFromTask).toHaveBeenCalledWith('New feature request');
      // Then: saveTaskFromInteractive receives final confirmation message
      expect(mockSaveTaskFromInteractive).toHaveBeenCalledWith(
        '/test/cwd',
        'New feature request',
        'default',
        { issue: 226, confirmAtEndMessage: 'Add this issue to tasks?' },
      );
    });

    it('should skip confirmation and task save when issue creation fails', async () => {
      // Given
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature request' });
      mockCreateIssueFromTask.mockReturnValue(undefined);

      // When
      await executeDefaultAction();

      // Then
      expect(mockCreateIssueFromTask).toHaveBeenCalledWith('New feature request');
      expect(mockSaveTaskFromInteractive).not.toHaveBeenCalled();
    });

    it('should not call selectAndExecuteTask when create_issue action is chosen', async () => {
      // Given
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature request' });

      // When
      await executeDefaultAction();

      // Then: selectAndExecuteTask should NOT be called
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    });
  });

  describe('--continue option', () => {
    it('should load saved session and pass to interactiveMode when --continue is specified', async () => {
      // Given
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' });
      mockLoadPersonaSessions.mockReturnValue({ interactive: 'saved-session-123' });

      // When
      await executeDefaultAction();

      // Then: loadPersonaSessions should be called with provider
      expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/test/cwd', 'claude');

      // Then: interactiveMode should receive the saved session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'saved-session-123',
      );
    });

    it('should show message and start new session when --continue has no saved session', async () => {
      // Given
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' });
      mockLoadPersonaSessions.mockReturnValue({});

      // When
      await executeDefaultAction();

      // Then: info message about no session
      expect(mockInfo).toHaveBeenCalledWith(
        'No previous assistant session found. Starting a new session.',
      );

      // Then: interactiveMode should be called with undefined session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
      );
    });

    it('should not load persona sessions when --continue is not specified', async () => {
      // When
      await executeDefaultAction();

      // Then: loadPersonaSessions should NOT be called
      expect(mockLoadPersonaSessions).not.toHaveBeenCalled();

      // Then: interactiveMode should be called with undefined session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
      );
    });
  });

  describe('default assistant mode (no --continue)', () => {
    it('should start new session without loading saved sessions', async () => {
      await executeDefaultAction();

      expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
      );
    });
  });
});
