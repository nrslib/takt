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
}));

vi.mock('../infra/config/index.js', () => ({
  getPieceDescription: vi.fn(() => ({ name: 'default', description: 'test piece', pieceStructure: '', movementPreviews: [] })),
  loadGlobalConfig: vi.fn(() => ({ interactivePreviewMovements: 3 })),
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
import { selectAndExecuteTask, determinePiece } from '../features/tasks/index.js';
import { interactiveMode } from '../features/interactive/index.js';
import { isDirectTask } from '../app/cli/helpers.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import type { GitHubIssue } from '../infra/github/types.js';

const mockCheckGhCli = vi.mocked(checkGhCli);
const mockFetchIssue = vi.mocked(fetchIssue);
const mockFormatIssueAsTask = vi.mocked(formatIssueAsTask);
const mockParseIssueNumbers = vi.mocked(parseIssueNumbers);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockIsDirectTask = vi.mocked(isDirectTask);

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
      );

      // Then: no issue fetching should occur
      expect(mockFetchIssue).not.toHaveBeenCalled();
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
});
