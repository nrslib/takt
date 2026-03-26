import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
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

const {
  mockCheckCliStatus,
  mockFetchIssue,
  mockFetchPrReviewComments,
  mockResolveConfigValues,
  mockResolveAssistantConfigLayers,
  mockLoadPersonaSessions,
  mockResolveAgentOverrides,
} = vi.hoisted(() => ({
  mockCheckCliStatus: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockResolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' })),
  mockResolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
  mockLoadPersonaSessions: vi.fn(() => ({})),
  mockResolveAgentOverrides: vi.fn(),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
  }),
  parseIssueNumbers: vi.fn(() => []),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  formatPrReviewAsTask: vi.fn((pr: { number: number; title: string }) =>
    `## PR #${pr.number} Review Comments: ${pr.title}`),
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
const mockCheckoutBranch = vi.fn();
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: vi.fn(() => ({
    listAllTaskItems: mockListAllTaskItems,
  })),
  isStaleRunningTask: (...args: unknown[]) => mockIsStaleRunningTask(...args),
  checkoutBranch: (...args: unknown[]) => mockCheckoutBranch(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  getPieceDescription: vi.fn(() => ({ name: 'default', description: 'test piece', pieceStructure: '', movementPreviews: [] })),
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
  resolveConfigValue: vi.fn(() => undefined),
  loadPersonaSessions: (...args: unknown[]) => mockLoadPersonaSessions(...args),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
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
  resolveAgentOverrides: (...args: unknown[]) => mockResolveAgentOverrides(...args),
  isDirectTask: vi.fn(() => false),
}));

import { selectAndExecuteTask, determinePiece, saveTaskFromInteractive } from '../features/tasks/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { executePipeline } from '../features/pipeline/index.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { error as logError } from '../shared/ui/index.js';
import type { InteractiveModeResult } from '../features/interactive/index.js';
import type { PrReviewData } from '../infra/git/index.js';

const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockExecutePipeline = vi.mocked(executePipeline);
const mockLogError = vi.mocked(logError);
const mockSaveTaskFromInteractive = vi.mocked(saveTaskFromInteractive);
const mockResolveConfigValuesFn = mockResolveConfigValues;
const mockLoadPersonaSessionsFn = mockLoadPersonaSessions;

function createMockPrReview(overrides: Partial<PrReviewData & { baseRefName?: string }> = {}): PrReviewData {
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
  mockResolveConfigValuesFn.mockReturnValue({ language: 'en', interactivePreviewMovements: 3, provider: 'claude' });
  mockResolveAssistantConfigLayers.mockReturnValue({ local: {}, global: {} });
  mockLoadPersonaSessionsFn.mockReturnValue({});
  mockResolveAgentOverrides.mockReturnValue(undefined);
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
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, undefined);
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        expect.stringContaining('## PR #456 Review Comments:'),
        expect.anything(),
        undefined,
        undefined,
        { excludeActions: ['create_issue'] },
      );
    });

    it('should pass PR base branch as baseBranch when interactive save_task is selected', async () => {
      // Given
      mockOpts.pr = 456;
      const actionResult: InteractiveModeResult = {
        action: 'save_task',
        task: 'Saved PR task',
      };
      mockInteractiveMode.mockResolvedValue(actionResult);
      const prReview = createMockPrReview({ baseRefName: 'release/main', headRefName: 'feat/my-pr-branch' });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then
      expect(mockSaveTaskFromInteractive).toHaveBeenCalledWith(
        '/test/cwd',
        'Saved PR task',
        'default',
        expect.objectContaining({
          presetSettings: expect.objectContaining({
            worktree: true,
            branch: 'feat/my-pr-branch',
            autoPr: true,
            baseBranch: 'release/main',
          }),
        }),
      );
    });

    it('should execute task after resolving PR review comments', async () => {
      // Given
      mockOpts.pr = 456;
      const prReview = createMockPrReview({ headRefName: 'feat/my-pr-branch' });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then: selectAndExecuteTask is called
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.any(Object),
        undefined,
      );
    });

    it('should checkout PR branch before executing task', async () => {
      // Given
      mockOpts.pr = 456;
      const prReview = createMockPrReview({ headRefName: 'feat/my-pr-branch' });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(prReview);

      // When
      await executeDefaultAction();

      // Then: checkoutBranch is called with the PR's head branch
      expect(mockCheckoutBranch).toHaveBeenCalledWith('/test/cwd', 'feat/my-pr-branch');
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

    it('should pass to interactive mode even when PR has no review comments', async () => {
      // Given
      mockOpts.pr = 456;
      const emptyPrReview = createMockPrReview({ reviews: [], comments: [] });
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchPrReviewComments.mockReturnValue(emptyPrReview);

      // When
      await executeDefaultAction();

      // Then: PR title/description/files are still passed to interactive mode
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        expect.stringContaining('## PR #456 Review Comments:'),
        expect.anything(),
        undefined,
        undefined,
        { excludeActions: ['create_issue'] },
      );
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
      mockOpts.piece = 'default';
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

    it('should exit with error when piece is omitted in pipeline mode', async () => {
      const programModule = await import('../app/cli/program.js');
      const originalPipelineMode = programModule.pipelineMode;
      Object.defineProperty(programModule, 'pipelineMode', { value: true, writable: true });

      mockOpts.pr = 456;
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining('piece'),
      );
      expect(mockExecutePipeline).not.toHaveBeenCalled();
      mockExit.mockRestore();

      Object.defineProperty(programModule, 'pipelineMode', { value: originalPipelineMode, writable: true });
    });
  });

  describe('--continue with assistant provider', () => {
    it('should load interactive session using takt_providers.assistant provider when configured', async () => {
      mockOpts.continue = true;
      mockResolveConfigValuesFn.mockReturnValue({
        language: 'en',
        interactivePreviewMovements: 3,
        provider: 'codex',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'codex',
          taktProviders: {
            assistant: {
              provider: 'claude',
              model: 'haiku',
            },
          },
        },
        global: {},
      });
      mockLoadPersonaSessionsFn.mockReturnValue({
        'interactive:claude': 'scoped-session-from-claude',
        interactive: 'legacy-session-from-claude',
      });

      await executeDefaultAction();

      expect(mockLoadPersonaSessionsFn).toHaveBeenCalledWith('/test/cwd', 'claude');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'scoped-session-from-claude',
        undefined,
        undefined,
      );
    });

    it('should prioritize CLI override over takt_providers.assistant when both are configured', async () => {
      mockOpts.continue = true;
      mockResolveAgentOverrides.mockReturnValue({ provider: 'opencode', model: 'cli-model' });
      mockResolveConfigValuesFn.mockReturnValue({
        language: 'en',
        interactivePreviewMovements: 3,
        provider: 'codex',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'codex',
          taktProviders: {
            assistant: {
              provider: 'claude',
              model: 'haiku',
            },
          },
        },
        global: {},
      });
      mockLoadPersonaSessionsFn.mockReturnValue({
        'interactive:opencode': 'scoped-session-from-opencode',
        'interactive:claude': 'scoped-session-from-claude',
        interactive: 'legacy-session-from-claude',
      });

      await executeDefaultAction();

      expect(mockLoadPersonaSessionsFn).toHaveBeenCalledWith('/test/cwd', 'opencode');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'scoped-session-from-opencode',
        undefined,
        { provider: 'opencode', model: 'cli-model' },
      );
    });

    it('should use local config assistant provider when local config exists', async () => {
      mockOpts.continue = true;
      mockResolveConfigValuesFn.mockReturnValue({
        language: 'en',
        interactivePreviewMovements: 3,
        provider: 'mock',
        model: 'global-top-level-model',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'opencode',
          model: 'local-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'local-assistant-model',
            },
          },
        },
        global: {
          provider: 'claude',
          model: 'global-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'cursor',
              model: 'global-assistant-model',
            },
          },
        },
      });
      mockLoadPersonaSessionsFn.mockReturnValue({
        'interactive:codex': 'scoped-session-from-codex',
      });

      await executeDefaultAction();

      expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/test/cwd');
      expect(mockLoadPersonaSessionsFn).toHaveBeenCalledWith('/test/cwd', 'codex');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'scoped-session-from-codex',
        undefined,
        undefined,
      );
    });
  });
});
