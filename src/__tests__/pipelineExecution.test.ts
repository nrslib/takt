/**
 * Tests for pipeline execution
 *
 * Tests the orchestration logic with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
const mockFetchIssue = vi.fn();
const mockCheckGhCli = vi.fn().mockReturnValue({ available: true });
vi.mock('../infra/github/issue.js', () => ({
  fetchIssue: mockFetchIssue,
  formatIssueAsTask: vi.fn((issue: { title: string; body: string; number: number }) =>
    `## GitHub Issue #${issue.number}: ${issue.title}\n\n${issue.body}`
  ),
  checkGhCli: mockCheckGhCli,
}));

const mockCreatePullRequest = vi.fn();
const mockPushBranch = vi.fn();
const mockBuildPrBody = vi.fn(() => 'Default PR body');
vi.mock('../infra/github/pr.js', () => ({
  createPullRequest: mockCreatePullRequest,
  pushBranch: mockPushBranch,
  buildPrBody: mockBuildPrBody,
}));

const mockExecuteTask = vi.fn();
const mockConfirmAndCreateWorktree = vi.fn();
vi.mock('../features/tasks/index.js', () => ({
  executeTask: mockExecuteTask,
  confirmAndCreateWorktree: mockConfirmAndCreateWorktree,
}));

const mockResolveConfigValues = vi.fn();
vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: mockResolveConfigValues,
  resolveConfigValue: vi.fn(() => undefined),
}));

// Mock execFileSync for git operations
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// Mock UI
vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  header: vi.fn(),
  section: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
// Mock Slack + utils
const mockGetSlackWebhookUrl = vi.fn<() => string | undefined>(() => undefined);
const mockSendSlackNotification = vi.fn<(url: string, message: string) => Promise<void>>();
const mockBuildSlackRunSummary = vi.fn<(params: unknown) => string>(() => 'TAKT Run Summary');
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getSlackWebhookUrl: (...args: unknown[]) => mockGetSlackWebhookUrl(...args as []),
  sendSlackNotification: (...args: unknown[]) => mockSendSlackNotification(...(args as [string, string])),
  buildSlackRunSummary: (...args: unknown[]) => mockBuildSlackRunSummary(...(args as [unknown])),
}));

// Mock generateRunId
vi.mock('../features/tasks/execute/slackSummaryAdapter.js', () => ({
  generateRunId: () => 'run-20260222-000000',
}));

const { executePipeline } = await import('../features/pipeline/index.js');

describe('executePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no Slack webhook
    mockGetSlackWebhookUrl.mockReturnValue(undefined);
    // Default: git operations succeed
    mockExecFileSync.mockReturnValue('abc1234\n');
    // Default: no pipeline config
    mockResolveConfigValues.mockReturnValue({ pipeline: undefined });
  });

  it('should return exit code 2 when neither --issue nor --task is specified', async () => {
    const exitCode = await executePipeline({
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(2);
  });

  it('should return exit code 2 when gh CLI is not available', async () => {
    mockCheckGhCli.mockReturnValueOnce({ available: false, error: 'gh not found' });

    const exitCode = await executePipeline({
      issueNumber: 99,
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(2);
  });

  it('should return exit code 2 when issue fetch fails', async () => {
    mockFetchIssue.mockImplementationOnce(() => {
      throw new Error('Issue not found');
    });

    const exitCode = await executePipeline({
      issueNumber: 999,
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(2);
  });

  it('should return exit code 3 when piece fails', async () => {
    mockFetchIssue.mockReturnValueOnce({
      number: 99,
      title: 'Test issue',
      body: 'Test body',
      labels: [],
      comments: [],
    });
    mockExecuteTask.mockResolvedValueOnce(false);

    const exitCode = await executePipeline({
      issueNumber: 99,
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(3);
  });

  it('should return exit code 0 on successful task-only execution', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'Fix the bug',
      cwd: '/tmp/test',
      pieceIdentifier: 'default',
      projectCwd: '/tmp/test',
      agentOverrides: undefined,
    });
  });

  it('passes provider/model overrides to task execution', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      autoPr: false,
      cwd: '/tmp/test',
      provider: 'codex',
      model: 'codex-model',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'Fix the bug',
      cwd: '/tmp/test',
      pieceIdentifier: 'default',
      projectCwd: '/tmp/test',
      agentOverrides: { provider: 'codex', model: 'codex-model' },
    });
  });

  it('should return exit code 5 when PR creation fails', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: false, error: 'PR failed' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      autoPr: true,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(5);
  });

  it('should create PR with correct branch when --auto-pr', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      repo: 'owner/repo',
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/tmp/test',
      expect.objectContaining({
        branch: 'fix/my-branch',
        repo: 'owner/repo',
      }),
    );
  });

  it('draftPr: true の場合、createPullRequest に draft: true が渡される', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      draftPr: true,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/tmp/test',
      expect.objectContaining({ draft: true }),
    );
  });

  it('draftPr: false の場合、createPullRequest に draft: false が渡される', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      draftPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/tmp/test',
      expect.objectContaining({ draft: false }),
    );
  });

  it('should pass baseBranch as base to createPullRequest', async () => {
    // Given: detectDefaultBranch returns 'develop' (via symbolic-ref)
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/develop\n';
      }
      return 'abc1234\n';
    });
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    // When
    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      cwd: '/tmp/test',
    });

    // Then
    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/tmp/test',
      expect.objectContaining({
        branch: 'fix/my-branch',
        base: 'develop',
      }),
    );
  });

  it('should use --task when both --task and positional task are provided', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'From --task flag',
      piece: 'magi',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'From --task flag',
      cwd: '/tmp/test',
      pieceIdentifier: 'magi',
      projectCwd: '/tmp/test',
      agentOverrides: undefined,
    });
  });

  describe('PipelineConfig template expansion', () => {
    it('should use commit_message_template when configured', async () => {
      mockResolveConfigValues.mockReturnValue({
        pipeline: {
          commitMessageTemplate: 'fix: {title} (#{issue})',
        },
      });

      mockFetchIssue.mockReturnValueOnce({
        number: 42,
        title: 'Login broken',
        body: 'Cannot login.',
        labels: [],
        comments: [],
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      await executePipeline({
        issueNumber: 42,
        piece: 'default',
        branch: 'test-branch',
        autoPr: false,
        cwd: '/tmp/test',
      });

      // Verify commit was called with expanded template
      const commitCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'commit',
      );
      expect(commitCall).toBeDefined();
      expect((commitCall![1] as string[])[2]).toBe('fix: Login broken (#42)');
    });

    it('should use default_branch_prefix when configured', async () => {
      mockResolveConfigValues.mockReturnValue({
        pipeline: {
          defaultBranchPrefix: 'feat/',
        },
      });

      mockFetchIssue.mockReturnValueOnce({
        number: 10,
        title: 'Add feature',
        body: 'Please add.',
        labels: [],
        comments: [],
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      await executePipeline({
        issueNumber: 10,
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      // Verify checkout -b was called with prefix
      const checkoutCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'checkout' && (call[1] as string[])[1] === '-b',
      );
      expect(checkoutCall).toBeDefined();
      const branchName = (checkoutCall![1] as string[])[2];
      expect(branchName).toMatch(/^feat\/issue-10-\d+$/);
    });

    it('should use pr_body_template when configured for PR creation', async () => {
      mockResolveConfigValues.mockReturnValue({
        pipeline: {
          prBodyTemplate: '## Summary\n{issue_body}\n\nCloses #{issue}',
        },
      });

      mockFetchIssue.mockReturnValueOnce({
        number: 50,
        title: 'Fix auth',
        body: 'Auth is broken.',
        labels: [],
        comments: [],
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/pr/1' });

      await executePipeline({
        issueNumber: 50,
        piece: 'default',
        branch: 'fix-auth',
        autoPr: true,
        cwd: '/tmp/test',
      });

      // When prBodyTemplate is set, buildPrBody (mock) should NOT be called
      // Instead, the template is expanded directly
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        '/tmp/test',
        expect.objectContaining({
          body: '## Summary\nAuth is broken.\n\nCloses #50',
        }),
      );
    });

    it('should fall back to buildPrBody when no template is configured', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/pr/1' });

      await executePipeline({
        task: 'Fix bug',
        piece: 'default',
        branch: 'fix-branch',
        autoPr: true,
        cwd: '/tmp/test',
      });

      // Should use buildPrBody (the mock)
      expect(mockBuildPrBody).toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        '/tmp/test',
        expect.objectContaining({
          body: 'Default PR body',
        }),
      );
    });
  });

  describe('--skip-git', () => {
    it('should skip branch creation, commit, push when skipGit is true', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        pieceIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });

      // No git operations should have been called
      const gitCalls = mockExecFileSync.mock.calls.filter(
        (call: unknown[]) => call[0] === 'git',
      );
      expect(gitCalls).toHaveLength(0);
      expect(mockPushBranch).not.toHaveBeenCalled();
    });

    it('should ignore --auto-pr when skipGit is true', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: true,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it('should still return piece failure exit code when skipGit is true', async () => {
      mockExecuteTask.mockResolvedValueOnce(false);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(3);
    });
  });

  describe('--create-worktree', () => {
    it('should create worktree and execute task in worktree directory when createWorktree is true', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: 'main',
        taskSlug: 'fix-the-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).toHaveBeenCalledWith('/tmp/test', 'Fix the bug', true);
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test-worktree',
        pieceIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });
    });

    it('should not create worktree when createWorktree is false', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: false,
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).not.toHaveBeenCalled();
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        pieceIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });
    });

    it('should use original cwd when createWorktree is undefined', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).not.toHaveBeenCalled();
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        pieceIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });
    });

    it('should pass provider/model overrides when worktree is created', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: 'main',
        taskSlug: 'fix-the-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
        provider: 'codex',
        model: 'codex-model',
      });

      expect(exitCode).toBe(0);
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test-worktree',
        pieceIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: { provider: 'codex', model: 'codex-model' },
      });
    });

    it('should return exit code 4 when worktree creation fails', async () => {
      mockConfirmAndCreateWorktree.mockRejectedValueOnce(new Error('Failed to create worktree'));

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(4);
    });

    it('should commit in worktree and push via clone→project→origin', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: 'main',
        taskSlug: 'fix-the-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);

      // Commit should happen in worktree (execCwd), not project cwd
      const addCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'add',
      );
      expect(addCall).toBeDefined();
      expect((addCall![2] as { cwd: string }).cwd).toBe('/tmp/test-worktree');

      // Clone→project push: git push /tmp/test HEAD from worktree
      const pushToProjectCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'git' &&
          (call[1] as string[])[0] === 'push' &&
          (call[1] as string[])[1] === '/tmp/test',
      );
      expect(pushToProjectCall).toBeDefined();
      expect((pushToProjectCall![2] as { cwd: string }).cwd).toBe('/tmp/test-worktree');

      // Project→origin push
      expect(mockPushBranch).toHaveBeenCalledWith('/tmp/test', 'fix/the-bug');
    });

    it('should create PR from project cwd when worktree is used with --auto-pr', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: 'main',
        taskSlug: 'fix-the-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: true,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        '/tmp/test',
        expect.objectContaining({
          branch: 'fix/the-bug',
          base: 'main',
        }),
      );
    });
  });

  it('should return exit code 4 when git commit/push fails', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    // stageAndCommit calls execFileSync('git', ['add', ...]) then ('git', ['commit', ...])
    // Make the commit call throw
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'commit') {
        throw new Error('nothing to commit');
      }
      return 'abc1234\n';
    });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      piece: 'default',
      branch: 'fix/my-branch',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(4);
  });

  describe('Slack notification', () => {
    it('should not send Slack notification when webhook is not configured', async () => {
      mockGetSlackWebhookUrl.mockReturnValue(undefined);
      mockExecuteTask.mockResolvedValueOnce(true);

      await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(mockSendSlackNotification).not.toHaveBeenCalled();
    });

    it('should send success notification when webhook is configured', async () => {
      mockGetSlackWebhookUrl.mockReturnValue('https://hooks.slack.com/test');
      mockExecuteTask.mockResolvedValueOnce(true);

      await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(mockBuildSlackRunSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-20260222-000000',
          total: 1,
          success: 1,
          failed: 0,
          concurrency: 1,
          tasks: [expect.objectContaining({
            name: 'pipeline',
            success: true,
            piece: 'default',
          })],
        }),
      );
      expect(mockSendSlackNotification).toHaveBeenCalledWith(
        'https://hooks.slack.com/test',
        'TAKT Run Summary',
      );
    });

    it('should send failure notification when piece fails', async () => {
      mockGetSlackWebhookUrl.mockReturnValue('https://hooks.slack.com/test');
      mockExecuteTask.mockResolvedValueOnce(false);

      await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(mockBuildSlackRunSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          success: 0,
          failed: 1,
          tasks: [expect.objectContaining({
            success: false,
          })],
        }),
      );
      expect(mockSendSlackNotification).toHaveBeenCalled();
    });

    it('should include PR URL in notification when auto-pr succeeds', async () => {
      mockGetSlackWebhookUrl.mockReturnValue('https://hooks.slack.com/test');
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/99' });

      await executePipeline({
        task: 'Fix the bug',
        piece: 'default',
        branch: 'fix/test',
        autoPr: true,
        cwd: '/tmp/test',
      });

      expect(mockBuildSlackRunSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          tasks: [expect.objectContaining({
            prUrl: 'https://github.com/test/pr/99',
          })],
        }),
      );
    });
  });
});
