import { describe, expect, it, vi } from 'vitest';
import {
  createIssueAndEnqueueTask,
  IssueEnqueueCancelledError,
} from '../infra/task/enqueueService.js';
import type { GitProvider, Issue } from '../infra/git/index.js';

function createTestGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  const issue: Issue = {
    number: 913,
    title: 'Test issue',
    body: 'Test body',
    labels: [],
    comments: [],
  };

  return {
    checkCliStatus: vi.fn(() => ({ available: true })),
    fetchIssue: vi.fn(() => issue),
    createIssue: vi.fn(() => ({ success: true, issueNumber: 913 })),
    closeIssue: vi.fn(() => ({ success: true })),
    fetchPrReviewComments: vi.fn(() => ({
      number: 1,
      title: 'PR',
      body: '',
      url: 'https://example.com/pull/1',
      headRefName: 'feature',
      comments: [],
      reviews: [],
      files: [],
    })),
    listOpenIssues: vi.fn(() => []),
    listOpenPrs: vi.fn(() => []),
    findExistingPr: vi.fn(() => undefined),
    createPullRequest: vi.fn(() => ({ success: true, url: 'https://example.com/pull/1' })),
    commentOnPr: vi.fn(() => ({ success: true })),
    closePr: vi.fn(() => ({ success: true })),
    mergePr: vi.fn(() => ({ success: true })),
    ...overrides,
  };
}

describe('createIssueAndEnqueueTask', () => {
  it('does not create an issue when the abort signal is already aborted', async () => {
    const closeIssue = vi.fn(() => ({ success: true as const }));
    const gitProvider = createTestGitProvider({ closeIssue });
    const createIssueFromTaskResult = vi.fn(() => ({ success: true as const, issueNumber: 913 }));
    const saveTaskFile = vi.fn();
    const abortController = new AbortController();
    abortController.abort();

    await expect(createIssueAndEnqueueTask({
      cwd: '/repo',
      task: 'Implement enqueue service',
      workflow: 'review',
      worktree: true,
      autoPr: false,
      gitProvider,
      abortSignal: abortController.signal,
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
    })).rejects.toThrow(IssueEnqueueCancelledError);

    expect(createIssueFromTaskResult).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it('returns a task_saving failure result when default compensation handles a save failure', async () => {
    const closeIssue = vi.fn(() => ({ success: true as const }));
    const gitProvider = createTestGitProvider({ closeIssue });
    const createIssueFromTaskResult = vi.fn(() => ({ success: true as const, issueNumber: 913 }));
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));

    const result = await createIssueAndEnqueueTask({
      cwd: '/repo',
      task: 'Implement enqueue service',
      workflow: 'review',
      worktree: true,
      autoPr: false,
      gitProvider,
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.stage).toBe('task_saving');
      expect(result.failure.issueNumber).toBe(913);
      expect(result.failure.compensation).toEqual({ success: true });
    }
    expect(closeIssue).toHaveBeenCalledWith(
      913,
      expect.stringContaining('TAKT created this issue'),
      '/repo',
    );
  });

  it('returns an issue_creation failure result without saving or compensation when issue creation fails', async () => {
    const closeIssue = vi.fn(() => ({ success: true as const }));
    const gitProvider = createTestGitProvider({ closeIssue });
    const createIssueFromTaskResult = vi.fn(() => ({
      success: false as const,
      error: 'gh issue create failed',
    }));
    const saveTaskFile = vi.fn();

    const result = await createIssueAndEnqueueTask({
      cwd: '/repo',
      task: 'Implement enqueue service',
      workflow: 'review',
      worktree: true,
      autoPr: false,
      gitProvider,
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
    });

    expect(result).toEqual({
      success: false,
      failure: {
        stage: 'issue_creation',
        error: 'gh issue create failed',
      },
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it('uses a cancellation compensation comment when enqueue is cancelled after issue creation', async () => {
    const closeIssue = vi.fn(() => ({ success: true as const }));
    const gitProvider = createTestGitProvider({ closeIssue });
    const createIssueFromTaskResult = vi.fn(() => ({ success: true as const, issueNumber: 913 }));
    const saveTaskFile = vi.fn().mockRejectedValue(new IssueEnqueueCancelledError());

    const result = await createIssueAndEnqueueTask({
      cwd: '/repo',
      task: 'Implement enqueue service',
      workflow: 'review',
      worktree: true,
      autoPr: false,
      gitProvider,
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.stage).toBe('cancelled_after_issue_creation');
    }
    expect(closeIssue).toHaveBeenCalledWith(
      913,
      [
        'TAKT created this issue, but task enqueue was cancelled before saving the pending task.',
        '',
        'The issue is being closed to keep the repository state consistent.',
      ].join('\n'),
      '/repo',
    );
    const compensationComment = String(closeIssue.mock.calls[0]?.[1]);
    expect(compensationComment).not.toContain('saving the pending task failed');
  });
});
