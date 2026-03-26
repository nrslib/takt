/**
 * Tests for postExecution.ts
 *
 * Verifies branching logic: existing PR → comment, no PR → create.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAutoCommitAndPush, mockPushBranch, mockFindExistingPr, mockCommentOnPr, mockCreatePullRequest, mockBuildPrBody, mockCreatePullRequestSafely } =
  vi.hoisted(() => ({
    mockAutoCommitAndPush: vi.fn(),
    mockPushBranch: vi.fn(),
    mockFindExistingPr: vi.fn(),
    mockCommentOnPr: vi.fn(),
    mockCreatePullRequest: vi.fn(),
    mockBuildPrBody: vi.fn(() => 'pr-body'),
    mockCreatePullRequestSafely: vi.fn(),
  }));

vi.mock('../infra/task/index.js', () => ({
  autoCommitAndPush: (...args: unknown[]) => mockAutoCommitAndPush(...args),
}));

vi.mock('../infra/task/git.js', () => ({
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
  buildPrBody: (...args: unknown[]) => mockBuildPrBody(...args),
  createPullRequestSafely: (...args: unknown[]) => mockCreatePullRequestSafely(...args),
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
}));

import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';

const baseOptions = {
  execCwd: '/clone',
  projectCwd: '/project',
  task: 'Fix the bug',
  branch: 'task/fix-the-bug',
  baseBranch: 'main',
  shouldCreatePr: true,
  draftPr: false,
  pieceIdentifier: 'default',
};

describe('postExecutionFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: 'abc123' });
    mockPushBranch.mockReturnValue(undefined);
    mockCommentOnPr.mockReturnValue({ success: true });
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });
    mockCreatePullRequestSafely.mockImplementation((provider, options, cwd) => {
      try {
        return provider.createPullRequest(options, cwd);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  });

  it('既存PRがない場合は createPullRequest を呼ぶ', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow(baseOptions);

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockCommentOnPr).not.toHaveBeenCalled();
  });

  it('既存PRがある場合は commentOnPr を呼び createPullRequest は呼ばない', async () => {
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });

    await postExecutionFlow(baseOptions);

    expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'pr-body', '/project');
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('shouldCreatePr が false の場合は PR 関連処理をスキップする', async () => {
    await postExecutionFlow({ ...baseOptions, shouldCreatePr: false });

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCommentOnPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('commit がない場合は PR 関連処理をスキップする', async () => {
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: undefined });

    await postExecutionFlow(baseOptions);

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('branch がない場合は PR 関連処理をスキップする', async () => {
    await postExecutionFlow({ ...baseOptions, branch: undefined });

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('draftPr: true の場合、createPullRequest に draft: true が渡される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({ ...baseOptions, draftPr: true });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
      '/project',
    );
  });

  it('draftPr: false の場合、createPullRequest に draft: false が渡される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({ ...baseOptions, draftPr: false });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ draft: false }),
      '/project',
    );
  });

  it('PR作成失敗時に prFailed: true を返す', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    mockCreatePullRequest.mockReturnValue({ success: false, error: 'Base ref must be a branch' });

    const result = await postExecutionFlow(baseOptions);

    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to create pull request.');
    expect(result.prUrl).toBeUndefined();
  });

  it('ローカルpush失敗後も commitHash があれば PR 作成失敗を prFailed として返す', async () => {
    // Given: autoCommit keeps the commitHash even though its local push already failed.
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed locally; local push failed',
    });
    mockFindExistingPr.mockReturnValue(undefined);
    mockCreatePullRequest.mockReturnValue({ success: false, error: 'Base ref must be a branch' });

    // When: post-execution continues with origin push and PR creation.
    const result = await postExecutionFlow(baseOptions);

    // Then: the workflow should continue into the existing pr_failed path.
    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'task/fix-the-bug',
        base: 'main',
        draft: false,
        title: 'Fix the bug',
      }),
      '/project',
    );
    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to create pull request.');
  });

  it('origin への push 失敗時は PR 処理へ進まず prFailed: true を返す', async () => {
    mockPushBranch.mockImplementation(() => {
      throw new Error('fatal: could not read Password for https://example.com/repo.git');
    });

    const result = await postExecutionFlow(baseOptions);

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to push branch to origin.');
  });

  it('auto-commit 失敗時は通常失敗を返し、PR 処理へ進まない', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'Auto-commit failed: fatal: refusing to update checked out branch /tmp/project',
    });

    const result = await postExecutionFlow(baseOptions);

    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBeUndefined();
    expect(result.prError).toBeUndefined();
    expect(result.taskFailed).toBe(true);
    expect(result.taskError).toBe('Auto-commit failed before PR creation.');
  });

  it('shouldCreatePr が false かつ auto-commit 失敗時は pr_failed を返さない', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'Auto-commit failed: fatal: refusing to update checked out branch /tmp/project',
    });

    const result = await postExecutionFlow({ ...baseOptions, shouldCreatePr: false });

    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBeUndefined();
    expect(result.prError).toBeUndefined();
    expect(result.taskFailed).toBe(true);
    expect(result.taskError).toBe('Auto-commit failed before PR creation.');
  });

  it('shouldCreatePr が false かつローカル push 失敗時は completed にせず通常失敗を返す', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      localPushFailed: true,
      message: 'Committed: abc123 - takt: Fix the bug',
    });

    const result = await postExecutionFlow({ ...baseOptions, shouldCreatePr: false });

    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBeUndefined();
    expect(result.prError).toBeUndefined();
    expect(result.taskFailed).toBe(true);
    expect(result.taskError).toBe('Push to main repo failed after commit creation.');
  });

  it('createPullRequest が例外を投げた場合も prFailed: true を返す', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    mockCreatePullRequest.mockImplementation(() => {
      throw new Error('--repo is not supported with GitLab provider. Use cwd context instead.');
    });

    const result = await postExecutionFlow(baseOptions);

    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to create pull request.');
    expect(result.prUrl).toBeUndefined();
  });

  it('PRコメント失敗時に prFailed: true を返す', async () => {
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });
    mockCommentOnPr.mockReturnValue({ success: false, error: 'Permission denied' });

    const result = await postExecutionFlow(baseOptions);

    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to update pull request comment.');
    expect(result.prUrl).toBeUndefined();
  });

  it('PRプロバイダーの詳細エラーは UI 用 prError に露出しない', async () => {
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });
    mockCommentOnPr.mockReturnValue({
      success: false,
      error: 'fatal: could not read Password for https://token@example.com/org/repo from /tmp/project',
    });

    const result = await postExecutionFlow(baseOptions);

    expect(result.prFailed).toBe(true);
    expect(result.prError).toBe('Failed to update pull request comment.');
  });

  it('PR作成成功時は prFailed を返さない', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });

    const result = await postExecutionFlow(baseOptions);

    expect(result.prFailed).toBeUndefined();
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('issues が渡された場合、PRタイトルにIssue番号プレフィックスが付与される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({
      ...baseOptions,
      task: 'Fix the bug',
      issues: [{ number: 123, title: 'This title should not appear in PR', body: '', labels: [], comments: [] }],
    });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[#123] Fix the bug' }),
      '/project',
    );
  });

  it('issues が空配列の場合、PRタイトルにプレフィックスは付与されない', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({
      ...baseOptions,
      issues: [],
    });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fix the bug' }),
      '/project',
    );
  });

  it('issues が undefined の場合、PRタイトルにプレフィックスは付与されない', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow(baseOptions);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fix the bug' }),
      '/project',
    );
  });

  it('Issueプレフィックス付きタイトルが100文字を超える場合、適切に省略される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    const longTask = 'A'.repeat(120);
    const expectedTitle = `[#123] ${'A'.repeat(90)}...`;

    await postExecutionFlow({
      ...baseOptions,
      task: longTask,
      issues: [{ number: 123, title: 'Long issue', body: '', labels: [], comments: [] }],
    });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: expectedTitle }),
      '/project',
    );
  });
});
