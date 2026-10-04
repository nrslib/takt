import { describe, expect, it, vi } from 'vitest';
import {
  createIssueAndEnqueueTask,
  IssueEnqueueCancelledError,
} from '../infra/task/enqueueService.js';
import type { GitProvider, Issue } from '../infra/git/index.js';
import { createIssueFromTaskResult } from '../infra/task/issueTask.js';

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
    commentOnIssue: vi.fn(() => ({ success: true })),
    closePr: vi.fn(() => ({ success: true })),
    mergePr: vi.fn(() => ({ success: true })),
    ...overrides,
  };
}

describe('createIssueAndEnqueueTask', () => {
  it.each([
    ['a prohibited title', '# Task Order'],
    ['a title shorter than the minimum', 'abc'],
  ])('falls back to a task-derived title for %s', async (_case, title) => {
    const createIssue = vi.fn(() => ({ success: true as const, issueNumber: 913 }));
    const gitProvider = createTestGitProvider({ createIssue });
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'task-1',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const task = '## Implement enqueue title fallback\nDetails';

    const result = await createIssueAndEnqueueTask({
      cwd: '/repo',
      task,
      workflow: 'review',
      title,
      gitProvider,
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
    });

    expect(result.success).toBe(true);
    expect(createIssue).toHaveBeenCalledWith({
      title: 'Implement enqueue title fallback',
      body: task,
    }, '/repo');
  });

  it('calls the post-save handler with the created issue number and URL', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'task-1',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const onIssueTaskEnqueued = vi.fn();
    const createIssueFromTaskResult = vi.fn(() => ({
      success: true as const,
      issueNumber: 913,
      issueUrl: 'https://example.com/issues/913',
    }));

    const result = await createIssueAndEnqueueTask({
      cwd: '/repo',
      task: 'Implement enqueue service',
      workflow: 'review',
      gitProvider: createTestGitProvider(),
    }, {
      createIssueFromTaskResult,
      saveTaskFile,
      onIssueTaskEnqueued,
    });

    expect(result.success).toBe(true);
    expect(onIssueTaskEnqueued).toHaveBeenCalledWith({
      issueNumber: 913,
      issueUrl: 'https://example.com/issues/913',
    });
  });

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

  it('returns a task_saving failure and leaves the created issue open', async () => {
    const closeIssue = vi.fn(() => ({ success: true as const }));
    const gitProvider = createTestGitProvider({ closeIssue });
    const createIssueFromTaskResult = vi.fn(() => ({ success: true as const, issueNumber: 913 }));
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const onIssueTaskEnqueued = vi.fn();

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
      onIssueTaskEnqueued,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.stage).toBe('task_saving');
      expect(result.failure.issueNumber).toBe(913);
      expect(result.failure).toEqual(expect.objectContaining({
        issueCreated: true,
        taskEnqueued: false,
      }));
    }
    expect(closeIssue).not.toHaveBeenCalled();
    expect(onIssueTaskEnqueued).not.toHaveBeenCalled();
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
        issueCreated: false,
        taskEnqueued: false,
        stage: 'issue_creation',
        error: 'gh issue create failed',
      },
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it('returns cancellation details and leaves the created issue open', async () => {
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
      expect(result.failure).toEqual(expect.objectContaining({
        issueCreated: true,
        issueNumber: 913,
        taskEnqueued: false,
      }));
    }
    expect(closeIssue).not.toHaveBeenCalled();
  });
});
