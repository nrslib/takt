import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createIssueAndEnqueueAcpTask } from '../app/acp/enqueue.js';

const { mockInitGitProvider, mockGitProvider } = vi.hoisted(() => ({
  mockInitGitProvider: vi.fn(),
  mockGitProvider: {
    closeIssue: vi.fn(),
  },
}));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
  getGitProvider: () => mockGitProvider,
}));

describe('ACP enqueue service integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the created issue open when ACP task saving fails after issue creation', async () => {
    mockGitProvider.closeIssue.mockReturnValue({ success: true, commentCreated: true });
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const createIssueFromTaskResult = vi.fn().mockReturnValue({ success: true, issueNumber: 913 });

    await expect(createIssueAndEnqueueAcpTask({
      cwd: '/repo',
      instruction: {
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
        interactiveMetadata: {
          confirmed: true,
          task: 'Implement ACP support',
        },
      },
      workflow: 'review',
      saveTaskFile,
      createIssueFromTaskResult,
    })).rejects.toThrow('Issue #913 was created, but task saving failed: disk full');

    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('leaves the created issue open when ACP cancellation happens after issue creation', async () => {
    const abortController = new AbortController();
    mockGitProvider.closeIssue.mockReturnValue({ success: true, commentCreated: true });
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockImplementation(() => {
      abortController.abort();
      return { success: true, issueNumber: 913 };
    });

    await expect(createIssueAndEnqueueAcpTask({
      cwd: '/repo',
      instruction: {
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
        interactiveMetadata: {
          confirmed: true,
          task: 'Implement ACP support',
        },
      },
      workflow: 'review',
      saveTaskFile,
      createIssueFromTaskResult,
      abortSignal: abortController.signal,
    })).rejects.toThrow('Issue #913 was created and remains open, but task enqueue was cancelled');

    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('does not call issue close even when the provider close method would fail', async () => {
    mockGitProvider.closeIssue.mockReturnValue({
      success: false,
      commentCreated: true,
      error: 'glab issue close failed',
    });
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const createIssueFromTaskResult = vi.fn().mockReturnValue({ success: true, issueNumber: 913 });

    await expect(createIssueAndEnqueueAcpTask({
      cwd: '/repo',
      instruction: {
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
        interactiveMetadata: {
          confirmed: true,
          task: 'Implement ACP support',
        },
      },
      workflow: 'review',
      saveTaskFile,
      createIssueFromTaskResult,
    })).rejects.toThrow('Issue #913 was created, but task saving failed: disk full');
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('preserves the issue creation failure reason from the result dependency', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: 'Failed to extract issue number from URL: Issue URL must end with a positive issue number',
    });

    await expect(createIssueAndEnqueueAcpTask({
      cwd: '/repo',
      instruction: {
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
        interactiveMetadata: {
          confirmed: true,
          task: 'Implement ACP support',
        },
      },
      workflow: 'review',
      saveTaskFile,
      createIssueFromTaskResult,
    })).rejects.toThrow(
      'Failed to extract issue number from URL: Issue URL must end with a positive issue number',
    );

    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('redacts secrets and local paths from ACP issue enqueue failures', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error('api_key=plain-secret\nCannot write /Users/nrs/secret/.takt/tasks.yaml'),
    );
    const createIssueFromTaskResult = vi.fn().mockReturnValue({ success: true, issueNumber: 913 });

    let thrown: unknown;
    try {
      await createIssueAndEnqueueAcpTask({
        cwd: '/repo',
        instruction: {
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
          interactiveMetadata: {
            confirmed: true,
            task: 'Implement ACP support',
          },
        },
        workflow: 'review',
        saveTaskFile,
        createIssueFromTaskResult,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/api_key=\[REDACTED\][\s\S]*\[path\]/);
    expect(message).not.toMatch(/plain-secret|\/Users\/nrs\/secret/);
  });
});
