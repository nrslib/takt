import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueTaktTask, type McpOperationDependencies } from '../features/mcp/operations.js';
import type { EnqueueTaskInput } from '../features/mcp/schemas.js';

const { mockInitGitProvider, mockGetGitProvider, mockGitProvider } = vi.hoisted(() => {
  const gitProvider = {
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
  };
  return {
    mockInitGitProvider: vi.fn(),
    mockGetGitProvider: vi.fn(() => gitProvider),
    mockGitProvider: gitProvider,
  };
});

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
  getGitProvider: () => mockGetGitProvider(),
}));

const baseInput: EnqueueTaskInput = {
  cwd: '/repo',
  task: 'Implement MCP support',
  workflow: 'default',
  autoPr: false,
};

function text(result: Awaited<ReturnType<typeof enqueueTaktTask>>): string {
  return String(result.content[0]?.text);
}

function json(result: Awaited<ReturnType<typeof enqueueTaktTask>>): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function enqueue(
  extra: Partial<EnqueueTaskInput> = {},
  deps: McpOperationDependencies = {},
  signal?: AbortSignal,
) {
  return enqueueTaktTask({ ...baseInput, ...extra }, deps, signal);
}

describe('MCP enqueue operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitProvider.mockReturnValue(mockGitProvider);
  });

  it('enqueues a normal task without initializing an issue provider', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'normal-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
    });
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('links an existing issue without creating another issue', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'existing-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({ issue: { number: 938 } }, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(json(result)).toEqual(expect.objectContaining({ issueNumber: 938 }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    });
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('creates an issue from the unchanged task body, explicit title, and labels', async () => {
    const task = '\n# Implement MCP support\n\nKeep whitespace.  \n';
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'created-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
    });

    const result = await enqueue({
      task,
      issue: { create: true, title: 'MCP consolidation', labels: ['enhancement'] },
    }, { saveTaskFile, createIssueFromTaskResult });

    expect(result.isError).toBeUndefined();
    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(createIssueFromTaskResult).toHaveBeenCalledWith(task, expect.objectContaining({
      cwd: '/repo',
      explicitTitle: 'MCP consolidation',
      labels: ['enhancement'],
      outputMode: 'silent',
      gitProvider: mockGitProvider,
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', task, {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    });
  });

  it('returns a structured issue creation error and skips saving', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: 'GitHub CLI is not authenticated',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: false,
      taskEnqueued: false,
      stage: 'issue_creation',
      error: 'GitHub CLI is not authenticated',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('keeps a created issue open and returns sanitized retry details when saving fails', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://user:secret@example.test/issues/938?token=secret#fragment',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
      taskEnqueued: false,
      stage: 'task_saving',
      error: 'permission denied',
    });
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('reports issue-number parsing as partial success without an issue number', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      error: 'Failed to extract issue number',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(json(result)).toEqual({
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      taskEnqueued: false,
      stage: 'issue_number_parsing',
      error: 'Failed to extract issue number',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('returns cancellation details after issue creation and does not close the issue', async () => {
    const controller = new AbortController();
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn(() => {
      setImmediate(() => controller.abort());
      return { success: true as const, issueNumber: 938 };
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    }, controller.signal);

    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      taskEnqueued: false,
      stage: 'cancelled_after_issue_creation',
      error: 'Task enqueue was cancelled.',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('sanitizes normal enqueue failures', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Task enqueue failed: permission denied');
  });
});
