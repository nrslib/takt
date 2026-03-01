/**
 * Tests for PR resolution in routing module.
 *
 * Verifies that --pr option fetches review comments,
 * passes formatted task to interactive mode, and sets
 * the branch for worktree checkout.
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

const { mockCheckCliStatus, mockFetchIssue, mockFetchPrReviewComments } = vi.hoisted(() => ({
  mockCheckCliStatus: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
  }),
}));

vi.mock('../infra/github/issue.js', () => ({
  parseIssueNumbers: vi.fn(() => []),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: vi.fn(),
  determinePiece: vi.fn(),
  saveTaskFromInteractive: vi.fn(),
  createIssueAndSaveTask: vi.fn(),
  promptLabelSelection: vi.fn().mockResolvedValue([]),
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
  isDirectTask: vi.fn(() => false),
}));

import { selectAndExecuteTask, determinePiece } from '../features/tasks/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { executePipeline } from '../features/pipeline/index.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { error as logError } from '../shared/ui/index.js';
import type { PrReviewData } from '../infra/git/index.js';

const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockExecutePipeline = vi.mocked(executePipeline);
const mockLogError = vi.mocked(logError);

function createMockPrReview(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    number: 456,
    title: 'Fix auth bug',
    body: 'PR description',
    url: 'https://github.com/org/repo/pull/456',
    headRefName: 'fix/auth-bug',
    comments: [{ author: 'commenter1', body: 'Update tests' }],
    reviews: [{ author: 'reviewer1', body: 'Fix null check' }],
    files: ['src/auth.ts'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  mockDeterminePiece.mockResolvedValue('default');
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'summarized task' });
  mockListAllTaskItems.mockReturnValue([]);
  mockIsStaleRunningTask.mockReturnValue(false);
});

describe('PR resolution in routing', () => {
  describe('--pr option', () => {
    it('should resolve PR review comments and pass to interactive mode', async () => {
      // Given
      mockOpts.pr = 456;
      const prReview = createMockPrReview();
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        expect.stringContaining('## PR #456 Review Comments:'),
        expect.anything(),
        undefined,
      );
    });

    it('should set branch in selectOptions from PR headRefName', async () => {
      // Given
      mockOpts.pr = 456;
      const prReview = createMockPrReview({ headRefName: 'feat/my-pr-branch' });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          branch: 'feat/my-pr-branch',
        }),
        undefined,
      );
    });

    it('should exit with error when gh CLI is unavailable', async () => {
      // Given
      mockOpts.pr = 456;
      mockCheckCliStatus.mockReturnValue({
        available: false,
        error: 'gh CLI is not installed',
      });

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When/Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockInteractiveMode).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });

    it('should exit with error when PR has no review comments', async () => {
      // Given
      mockOpts.pr = 456;
      const emptyPrReview = createMockPrReview({ reviews: [], comments: [] });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(emptyPrReview);

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When/Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockInteractiveMode).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });

    it('should not resolve issues when --pr is specified', async () => {
      // Given
      mockOpts.pr = 456;
      const prReview = createMockPrReview();
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then
      expect(mockFetchIssue).not.toHaveBeenCalled();
    });
  });

  describe('--pr and --issue mutual exclusion', () => {
    it('should exit with error when both --pr and --issue are specified', async () => {
      // Given
      mockOpts.pr = 456;
      mockOpts.issue = 123;

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When/Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockLogError).toHaveBeenCalledWith('--pr and --issue cannot be used together');
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
    });
  });

  describe('--pr and --task mutual exclusion', () => {
    it('should exit with error when both --pr and --task are specified', async () => {
      // Given
      mockOpts.pr = 456;
      mockOpts.task = 'some task';

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When/Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockLogError).toHaveBeenCalledWith('--pr and --task cannot be used together');
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
    });
  });

  describe('--pr in pipeline mode', () => {
    it('should pass prNumber to executePipeline', async () => {
      // Given: override pipelineMode
      const programModule = await import('../app/cli/program.js');
      const originalPipelineMode = programModule.pipelineMode;
      Object.defineProperty(programModule, 'pipelineMode', { value: true, writable: true });

      mockOpts.pr = 456;
      mockExecutePipeline.mockResolvedValue(0);

      // When
      await executeDefaultAction();

      // Then
      expect(mockExecutePipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 456,
        }),
      );

      // Cleanup
      Object.defineProperty(programModule, 'pipelineMode', { value: originalPipelineMode, writable: true });
    });
  });
});
