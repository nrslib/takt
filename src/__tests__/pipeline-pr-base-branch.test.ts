/**
 * Integration tests for pipeline PR base branch support (Issue #399)
 *
 * Verifies:
 *   - resolveTaskContent returns prBaseRefName from PR data
 *   - resolveExecutionContext uses prBaseRefName as baseBranch when checking out PR branch
 *   - resolveExecutionContext passes prBaseRefName to confirmAndCreateWorktree when using worktree
 *
 * Module chain (3+ modules):
 *   resolveTaskContent (pipeline/steps.ts)
 *     → fetchPrReviewComments (infra/github/pr.ts)
 *       → PrReviewData.baseRefName (infra/git/types.ts)
 *   resolveExecutionContext (pipeline/steps.ts)
 *     → confirmAndCreateWorktree (features/tasks/execute/selectAndExecute.ts)
 *       → createSharedClone with baseBranch (infra/task/clone.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---

const {
  mockCheckCliStatus,
  mockFetchPrReviewComments,
  mockFormatPrReviewAsTask,
  mockConfirmAndCreateWorktree,
  mockResolveBaseBranch,
  mockExecFileSync,
} = vi.hoisted(() => ({
  mockCheckCliStatus: vi.fn().mockReturnValue({ available: true }),
  mockFetchPrReviewComments: vi.fn(),
  mockFormatPrReviewAsTask: vi.fn(),
  mockConfirmAndCreateWorktree: vi.fn(),
  mockResolveBaseBranch: vi.fn().mockReturnValue({ branch: 'main' }),
  mockExecFileSync: vi.fn(),
}));

// --- Module mocks ---

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    fetchIssue: vi.fn(),
    createPullRequest: vi.fn(),
    findExistingPr: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  formatIssueAsTask: vi.fn(),
  formatPrReviewAsTask: (...args: unknown[]) => mockFormatPrReviewAsTask(...args),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
}));

vi.mock('../features/tasks/index.js', () => ({
  executeTask: vi.fn(),
  confirmAndCreateWorktree: (...args: unknown[]) => mockConfirmAndCreateWorktree(...args),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageAndCommit: vi.fn(),
  pushBranch: vi.fn(),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: vi.fn(() => undefined),
  resolveConfigValues: vi.fn(() => ({})),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

// --- Import under test ---

import { resolveTaskContent, resolveExecutionContext } from '../features/pipeline/steps.js';
import type { PipelineExecutionOptions } from '../features/tasks/index.js';

// --- Helpers ---

/** Build mock PR review data including baseRefName (added in implementation) */
function createMockPrReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 456,
    title: 'Fix auth bug',
    body: 'PR description',
    url: 'https://github.com/org/repo/pull/456',
    headRefName: 'feature/fix-auth-bug',
    baseRefName: 'develop',
    comments: [{ author: 'commenter', body: 'Please update tests' }],
    reviews: [{ author: 'reviewer', body: 'Fix null check' }],
    files: ['src/auth.ts'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckCliStatus.mockReturnValue({ available: true });
  mockResolveBaseBranch.mockReturnValue({ branch: 'main' });
});

// ---- resolveTaskContent with PR ----

describe('resolveTaskContent: includes prBaseRefName from PR', () => {
  it('should include prBaseRefName in returned TaskContent when PR has baseRefName', () => {
    // Given: PR has baseRefName = 'develop'
    const prReview = createMockPrReview({ baseRefName: 'develop' });
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue('## PR Review task');

    const options: PipelineExecutionOptions = {
      prNumber: 456,
      piece: 'default',
      cwd: '/project',
    };

    // When
    const result = resolveTaskContent(options);

    // Then: prBaseRefName is included in the result
    expect(result).not.toBeUndefined();
    expect(result?.prBaseRefName).toBe('develop');
  });

  it('should include prBranch (headRefName) in returned TaskContent', () => {
    // Given: PR with specific headRefName
    const prReview = createMockPrReview({ headRefName: 'feature/fix-auth-bug', baseRefName: 'develop' });
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue('## PR Review task');

    const options: PipelineExecutionOptions = {
      prNumber: 456,
      piece: 'default',
      cwd: '/project',
    };

    // When
    const result = resolveTaskContent(options);

    // Then: both prBranch and prBaseRefName are included
    expect(result?.prBranch).toBe('feature/fix-auth-bug');
    expect(result?.prBaseRefName).toBe('develop');
  });

  it('should not include prBaseRefName when resolving non-PR task', () => {
    // Given: task-based (no PR)
    const options: PipelineExecutionOptions = {
      task: 'Implement feature',
      piece: 'default',
      cwd: '/project',
    };

    // When
    const result = resolveTaskContent(options);

    // Then: no prBaseRefName
    expect(result?.prBaseRefName).toBeUndefined();
    expect(result?.prBranch).toBeUndefined();
  });
});

// ---- resolveExecutionContext with prBaseRefName ----

describe('resolveExecutionContext: uses prBaseRefName as baseBranch for PR branch checkout', () => {
  it('should use prBaseRefName as baseBranch when checking out PR branch (no worktree)', async () => {
    // Given: PR checkout path (prBranch set, no worktree, no skipGit)
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const options = {
      createWorktree: false as boolean | undefined,
      skipGit: false,
      branch: undefined,
      issueNumber: undefined,
    };

    // When: resolveExecutionContext with prBranch and prBaseRefName
    const result = await resolveExecutionContext(
      '/project',
      'Fix auth bug task',
      options,
      undefined,
      'feature/fix-auth-bug',   // prBranch
      'develop',                 // prBaseRefName
    );

    // Then: baseBranch in result is 'develop' (from PR), NOT resolved from config
    expect(result.baseBranch).toBe('develop');
    // Then: resolveBaseBranch was NOT called (prBaseRefName bypasses it)
    expect(mockResolveBaseBranch).not.toHaveBeenCalled();
  });

  it('should fall back to resolveBaseBranch when prBaseRefName is undefined', async () => {
    // Given: PR checkout path without prBaseRefName
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockResolveBaseBranch.mockReturnValue({ branch: 'main' });

    const options = {
      createWorktree: false as boolean | undefined,
      skipGit: false,
      branch: undefined,
      issueNumber: undefined,
    };

    // When: resolveExecutionContext with prBranch but no prBaseRefName
    const result = await resolveExecutionContext(
      '/project',
      'Fix auth bug task',
      options,
      undefined,
      'feature/fix-auth-bug',  // prBranch
      // prBaseRefName not provided
    );

    // Then: baseBranch comes from resolveBaseBranch (config/default)
    expect(result.baseBranch).toBe('main');
    expect(mockResolveBaseBranch).toHaveBeenCalled();
  });

  it('should pass prBaseRefName to confirmAndCreateWorktree when using worktree', async () => {
    // Given: worktree mode with prBaseRefName
    mockConfirmAndCreateWorktree.mockResolvedValue({
      execCwd: '/tmp/clone',
      branch: 'feature/fix-auth-bug',
      baseBranch: 'develop',
      isWorktree: true,
    });

    const options = {
      createWorktree: true as boolean | undefined,
      skipGit: false,
      branch: undefined,
      issueNumber: undefined,
    };

    // When: resolveExecutionContext in worktree mode with prBaseRefName
    await resolveExecutionContext(
      '/project',
      'Fix auth bug task',
      options,
      undefined,
      'feature/fix-auth-bug',  // prBranch
      'develop',               // prBaseRefName
    );

    // Then: confirmAndCreateWorktree was called with baseBranchOverride = 'develop'
    expect(mockConfirmAndCreateWorktree).toHaveBeenCalledWith(
      '/project',
      'Fix auth bug task',
      true,                     // createWorktreeOverride
      'feature/fix-auth-bug',   // branchOverride (prBranch)
      'develop',                // baseBranchOverride (prBaseRefName)
    );
  });
});
