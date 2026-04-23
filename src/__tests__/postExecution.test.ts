/**
 * Tests for postExecution.ts
 *
 * Verifies branching logic: existing PR → comment, no PR → create.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrBody as buildActualPrBody, TAKT_MANAGED_PR_MARKER } from '../infra/git/format.js';
import type { Issue } from '../infra/git/index.js';

const {
  mockAutoCommitAndPush,
  mockPushBranch,
  mockFindExistingPr,
  mockCommentOnPr,
  mockCreatePullRequest,
  mockBuildPrBody,
  mockBuildTaktManagedPrOptions,
  mockCreatePullRequestSafely,
  mockStripTaktManagedPrMarker,
} =
  vi.hoisted(() => ({
    mockAutoCommitAndPush: vi.fn(),
    mockPushBranch: vi.fn(),
    mockFindExistingPr: vi.fn(),
    mockCommentOnPr: vi.fn(),
    mockCreatePullRequest: vi.fn(),
    mockBuildPrBody: vi.fn(() => 'pr-body'),
    mockBuildTaktManagedPrOptions: vi.fn((body: string) => ({
      body: `${body}\n\n<!-- takt:managed -->`,
    })),
    mockCreatePullRequestSafely: vi.fn(),
    mockStripTaktManagedPrMarker: vi.fn((body: string) => body
      .split('<!-- takt:managed -->')
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()),
  }));

vi.mock('../infra/task/index.js', () => ({
  autoCommitAndPush: (...args: unknown[]) => mockAutoCommitAndPush(...args),
}));

vi.mock('../infra/task/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/git.js')>();
  return {
    ...actual,
    pushBranch: (...args: unknown[]) => mockPushBranch(...args),
  };
});
vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
  buildPrBody: (...args: unknown[]) => mockBuildPrBody(...args),
  buildTaktManagedPrOptions: (...args: unknown[]) => mockBuildTaktManagedPrOptions(...args as [string]),
  stripTaktManagedPrMarker: (...args: unknown[]) => mockStripTaktManagedPrMarker(...args as [string]),
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

import {
  postExecutionFlow,
  type PostExecutionOptions,
} from '../features/tasks/execute/postExecution.js';

const MOCK_NFF_DIAGNOSTIC_TAIL =
  'Push rejected (non-fast-forward): remote is ahead; resync or recreate worktree; stale local branch may apply.';

const baseOptions = {
  execCwd: '/clone',
  projectCwd: '/project',
  task: 'Fix the bug',
  branch: 'task/fix-the-bug',
  baseBranch: 'main',
  shouldCreatePr: true,
  draftPr: false,
  workflowIdentifier: 'default',
};

describe('postExecutionFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: 'abc123' });
    mockPushBranch.mockReturnValue(undefined);
    mockCommentOnPr.mockReturnValue({ success: true });
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });
    mockBuildTaktManagedPrOptions.mockImplementation((body: string) => ({
      body: `${body}\n\n<!-- takt:managed -->`,
    }));
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
    const [createOptions, createCwd] = mockCreatePullRequest.mock.calls[0] as [Record<string, unknown>, string];
    expect(createCwd).toBe('/project');
    expect(createOptions).toEqual(expect.objectContaining({
      body: 'pr-body',
    }));
    expect(mockCommentOnPr).not.toHaveBeenCalled();
    expect(mockBuildPrBody).toHaveBeenCalledWith(undefined, 'Workflow `default` completed successfully.');
    expect(mockBuildTaktManagedPrOptions).not.toHaveBeenCalled();
  });

  it('managedPr: true の場合だけ hidden marker 付きで新規PRを作成する', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    const options = { ...baseOptions, managedPr: true };

    await postExecutionFlow(options);

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'pr-body\n\n<!-- takt:managed -->',
      }),
      '/project',
    );
    expect(mockBuildTaktManagedPrOptions).toHaveBeenCalledWith('pr-body');
  });

  it('managedPr ではない新規PRは issue 本文に marker があっても本文から除去する', async () => {
    mockBuildPrBody.mockImplementation(buildActualPrBody);
    mockFindExistingPr.mockReturnValue(undefined);
    const issues: Issue[] = [{
      number: 12,
      title: 'Issue title',
      body: `Issue body\n\n${TAKT_MANAGED_PR_MARKER}`,
      labels: [],
      comments: [],
    }];

    await postExecutionFlow({ ...baseOptions, issues });

    const [createOptions, createCwd] = mockCreatePullRequest.mock.calls[0] as [Record<string, unknown>, string];
    expect(createCwd).toBe('/project');
    expect(createOptions).toEqual(expect.objectContaining({
      body: '## Summary\n\nIssue body\n\n## Execution Report\n\nWorkflow `default` completed successfully.\n\nCloses #12',
    }));
    expect(String(createOptions.body)).not.toContain(TAKT_MANAGED_PR_MARKER);
    expect(mockBuildTaktManagedPrOptions).not.toHaveBeenCalled();
  });

  it('autoCommitAndPush に branch パラメータが渡される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);
    await postExecutionFlow(baseOptions);
    expect(mockAutoCommitAndPush).toHaveBeenCalledWith(
      '/clone',
      'Fix the bug',
      '/project',
      'task/fix-the-bug',
    );
  });

  it('既存PRがある場合は commentOnPr を呼び createPullRequest は呼ばない', async () => {
    mockBuildPrBody.mockImplementation(buildActualPrBody);
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });

    await postExecutionFlow(baseOptions);

    const [commentPrNumber, commentBody, commentCwd] = mockCommentOnPr.mock.calls[0] as [number, string, string];
    expect(commentPrNumber).toBe(42);
    expect(commentCwd).toBe('/project');
    expect(commentBody).toBe(buildActualPrBody(undefined, 'Workflow `default` completed successfully.'));
    expect(commentBody).not.toContain(TAKT_MANAGED_PR_MARKER);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockBuildTaktManagedPrOptions).not.toHaveBeenCalled();
  });

  it('managedPr: true でも既存PR更新は hidden marker なしのコメントを使う', async () => {
    mockBuildPrBody.mockImplementation(buildActualPrBody);
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });

    await postExecutionFlow({ ...baseOptions, managedPr: true });

    const [commentPrNumber, commentBody, commentCwd] = mockCommentOnPr.mock.calls[0] as [number, string, string];
    expect(commentPrNumber).toBe(42);
    expect(commentCwd).toBe('/project');
    expect(commentBody).toBe(buildActualPrBody(undefined, 'Workflow `default` completed successfully.'));
    expect(commentBody).not.toContain(TAKT_MANAGED_PR_MARKER);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockBuildTaktManagedPrOptions).not.toHaveBeenCalled();
  });

  it('既存PR更新コメントも issue 本文に marker があれば除去する', async () => {
    mockBuildPrBody.mockImplementation(buildActualPrBody);
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });
    const issues: Issue[] = [{
      number: 34,
      title: 'Issue title',
      body: `Issue body\n\n${TAKT_MANAGED_PR_MARKER}`,
      labels: [],
      comments: [],
    }];

    await postExecutionFlow({ ...baseOptions, issues });

    const [, commentBody] = mockCommentOnPr.mock.calls[0] as [number, string, string];
    expect(commentBody).toBe('## Summary\n\nIssue body\n\n## Execution Report\n\nWorkflow `default` completed successfully.\n\nCloses #34');
    expect(commentBody).not.toContain(TAKT_MANAGED_PR_MARKER);
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
    expect(result.prError).toBe('Failed to create pull request. Base ref must be a branch');
    expect(result.prUrl).toBeUndefined();
  });

  it('ローカルpush失敗後も commitHash があれば（localPushFailed なし）PR 作成失敗を prFailed として返す', async () => {
    // relay push 済みのケースでは、PR 作成まで継続して失敗理由を返す。
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed locally; relay push succeeded',
    });
    mockFindExistingPr.mockReturnValue(undefined);
    mockCreatePullRequest.mockReturnValue({ success: false, error: 'Base ref must be a branch' });

    const result = await postExecutionFlow(baseOptions);
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
    expect(result.prError).toBe('Failed to create pull request. Base ref must be a branch');
  });

  it('relay push 失敗時（localPushFailed: true）は shouldCreatePr に関わらず taskFailed: true を返す', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      localPushFailed: true,
      message: 'Committed: abc123 - takt: Fix the bug',
    });

    const result = await postExecutionFlow(baseOptions);
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.taskFailed).toBe(true);
    expect(result.taskError).toBe('Push to main repo failed after commit creation.');
    expect(result.prFailed).toBeUndefined();
  });

  it('auto-commit 失敗時は通常失敗を返し、PR 処理へ進まない', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: false,
      message: 'Auto-commit failed: fatal: refusing to update checked out branch /tmp/project',
    });

    const result = await postExecutionFlow(baseOptions);

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

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBeUndefined();
    expect(result.prError).toBeUndefined();
    expect(result.taskFailed).toBe(true);
    expect(result.taskError).toBe('Push to main repo failed after commit creation.');
  });

  it('auto_pr かつ shouldPublishBranchToOrigin では root branch を origin へ push して PR 作成へ進む', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });
    mockFindExistingPr.mockReturnValue(undefined);

    const result = await postExecutionFlow({
      ...baseOptions,
      shouldPublishBranchToOrigin: true,
    });

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
    expect(result.prFailed).toBeUndefined();
  });

  it('shouldPublishBranchToOrigin が true のとき root branch を origin へ push して完了できる', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });

    const options: PostExecutionOptions = {
      ...baseOptions,
      shouldCreatePr: false,
      shouldPublishBranchToOrigin: true,
    };

    const result = await postExecutionFlow(options);

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.taskFailed).toBeUndefined();
    expect(result.taskError).toBeUndefined();
    expect(result.prFailed).toBeUndefined();
  });

  it('shouldPublishBranchToOrigin が true でローカル push 成功時も root branch を origin へ push する', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });

    const options: PostExecutionOptions = {
      ...baseOptions,
      shouldCreatePr: false,
      shouldPublishBranchToOrigin: true,
    };

    const result = await postExecutionFlow(options);

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(result.taskFailed).toBeUndefined();
    expect(result.prFailed).toBeUndefined();
  });

  it('shouldPublishBranchToOrigin が true でコミットがない場合は origin push もしない', async () => {
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: undefined });

    const options: PostExecutionOptions = {
      ...baseOptions,
      shouldCreatePr: false,
      shouldPublishBranchToOrigin: true,
    };

    await postExecutionFlow(options);

    expect(mockPushBranch).not.toHaveBeenCalled();
  });

  it('shouldPublishBranchToOrigin が true のとき origin push が失敗したら prFailed で prError に伝播する', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });
    mockPushBranch.mockImplementation(() => {
      throw new Error('! [rejected] task/fix-the-bug -> task/fix-the-bug (non-fast-forward)');
    });

    const options: PostExecutionOptions = {
      ...baseOptions,
      shouldCreatePr: false,
      shouldPublishBranchToOrigin: true,
    };

    const result = await postExecutionFlow(options);

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(result.prFailed).toBe(true);
    expect(result.prError).toContain('Failed to push branch to origin.');
    expect(result.prError).toContain('non-fast-forward');
    expect(result.prError).not.toContain('stale local branch');
    expect(result.taskFailed).toBeUndefined();
  });

  it('shouldCreatePr が true かつ shouldPublishBranchToOrigin で origin push が失敗したら prFailed を返す', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });
    mockPushBranch.mockImplementation(() => {
      throw new Error('! [rejected] task/fix-the-bug -> task/fix-the-bug (non-fast-forward)');
    });

    const result = await postExecutionFlow({
      ...baseOptions,
      shouldCreatePr: true,
      shouldPublishBranchToOrigin: true,
    });

    expect(mockPushBranch).toHaveBeenCalledWith('/project', 'task/fix-the-bug');
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(result.prFailed).toBe(true);
    expect(result.prError).toContain('Failed to push branch to origin.');
    expect(result.prError).toContain('non-fast-forward');
    expect(result.prError).not.toContain('stale local branch');
    expect(result.taskFailed).toBeUndefined();
  });

  it('root からの origin push が git 整形済み non-fast-forward エラーのとき prError に診断ヒントまで伝播する', async () => {
    const stderr =
      '! [rejected] task/fix-the-bug -> task/fix-the-bug (non-fast-forward)\n' +
      'hint: Updates were rejected because the tip of your current branch is behind its remote counterpart.\n';
    const base = 'Command failed: git push origin HEAD:refs/heads/task/fix-the-bug';
    const formatted = `${base}\n${stderr.trim()}\n${MOCK_NFF_DIAGNOSTIC_TAIL}`;

    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      message: 'Committed: abc123 - takt: Fix the bug',
    });
    mockPushBranch.mockImplementation(() => {
      throw new Error(formatted);
    });

    const result = await postExecutionFlow({
      ...baseOptions,
      shouldCreatePr: true,
      shouldPublishBranchToOrigin: true,
    });

    expect(result.prFailed).toBe(true);
    expect(result.prError).toContain('Failed to push branch to origin.');
    expect(result.prError).toMatch(/non-fast-forward/i);
    expect(result.prError).toContain('stale local branch');
  });

  it('shouldPublishBranchToOrigin が true でもローカル push 失敗時は origin push に進まず taskFailed を返す', async () => {
    mockAutoCommitAndPush.mockReturnValue({
      success: true,
      commitHash: 'abc123',
      localPushFailed: true,
      message: 'Committed: abc123 - takt: Fix the bug',
    });

    const result = await postExecutionFlow({
      ...baseOptions,
      shouldCreatePr: false,
      shouldPublishBranchToOrigin: true,
    });

    expect(mockPushBranch).not.toHaveBeenCalled();
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
    expect(result.prError).toBe('Failed to create pull request. --repo is not supported with GitLab provider. Use cwd context instead.');
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
