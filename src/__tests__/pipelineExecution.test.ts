import { describe, it, expect, vi, beforeEach } from 'vitest';
import { info, error, success, status } from '../shared/ui/index.js';

const mockFetchIssue = vi.fn();
const mockCheckGhCli = vi.fn().mockReturnValue({ available: true });
const mockCreatePullRequest = vi.fn();
const mockCreatePullRequestSafely = vi.fn();
const mockPushBranch = vi.fn();
const mockBuildPrBody = vi.fn(() => 'Default PR body');
const mockBuildTaktManagedPrOptions = vi.fn((body: string) => ({
  body: `${body}\n\n<!-- takt:managed -->`,
  labels: ['takt-managed'],
}));
const mockFetchPrReviewComments = vi.fn();
const mockFormatPrReviewAsTask = vi.fn((pr: { number: number; title: string }) =>
  `## PR #${pr.number} Review Comments: ${pr.title}`
);

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckGhCli(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
  }),
  formatIssueAsTask: vi.fn((issue: { title: string; body: string; number: number }) =>
    `## Issue #${issue.number}: ${issue.title}\n\n${issue.body}`
  ),
  buildPrBody: (...args: unknown[]) => mockBuildPrBody(...args),
  buildTaktManagedPrOptions: (...args: unknown[]) => mockBuildTaktManagedPrOptions(...args as [string]),
  formatPrReviewAsTask: (...args: unknown[]) => mockFormatPrReviewAsTask(...args),
  createPullRequestSafely: (...args: unknown[]) => mockCreatePullRequestSafely(...args),
}));

vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
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

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

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
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  playWarningSound: vi.fn(),
  getSlackWebhookUrl: (...args: unknown[]) => mockGetSlackWebhookUrl(...args as []),
  sendSlackNotification: (...args: unknown[]) => mockSendSlackNotification(...(args as [string, string])),
  buildSlackRunSummary: (...args: unknown[]) => mockBuildSlackRunSummary(...(args as [unknown])),
}));

// Mock generateRunId
vi.mock('../features/tasks/execute/slackSummaryAdapter.js', () => ({
  generateRunId: () => 'run-20260222-000000',
}));

const { executePipeline } = await import('../features/pipeline/index.js');
const mockInfo = vi.mocked(info);
const mockError = vi.mocked(error);
const mockSuccess = vi.mocked(success);
const mockStatus = vi.mocked(status);

describe('executePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildTaktManagedPrOptions.mockImplementation((body: string) => ({
      body: `${body}\n\n<!-- takt:managed -->`,
      labels: ['takt-managed'],
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
    // Default: no Slack webhook
    mockGetSlackWebhookUrl.mockReturnValue(undefined);
    // Default: git operations succeed
    mockExecFileSync.mockReturnValue('abc1234\n');
    // Default: no pipeline config
    mockResolveConfigValues.mockReturnValue({ pipeline: undefined });
  });

  it('should return exit code 2 when neither --issue nor --task is specified', async () => {
    const exitCode = await executePipeline({
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(2);
  });

  it('should return exit code 2 when gh CLI is not available', async () => {
    mockCheckGhCli.mockReturnValueOnce({ available: false, error: 'gh not found' });

    const exitCode = await executePipeline({
      issueNumber: 99,
      workflow: 'default',
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
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(2);
  });

  it('should return exit code 3 when workflow fails', async () => {
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
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(3);
    expect(mockInfo).toHaveBeenCalledWith('Running workflow: default');
    expect(mockError).toHaveBeenCalledWith("Workflow 'default' failed");
  });

  it('should return exit code 0 on successful task-only execution', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'Fix the bug',
      cwd: '/tmp/test',
      workflowIdentifier: 'default',
      projectCwd: '/tmp/test',
      agentOverrides: undefined,
    });
    expect(mockInfo).toHaveBeenCalledWith('Running workflow: default');
    expect(mockSuccess).toHaveBeenCalledWith("Workflow 'default' completed");
    expect(mockStatus).toHaveBeenCalledWith('Workflow', 'default');
    expect(mockStatus).toHaveBeenCalledWith('Result', 'Success', 'green');
  });

  it('should report workflow status for issue execution success', async () => {
    mockFetchIssue.mockReturnValueOnce({
      number: 99,
      title: 'Test issue',
      body: 'Test body',
      labels: [],
      comments: [],
    });
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      issueNumber: 99,
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockInfo).toHaveBeenCalledWith('Running workflow: default');
    expect(mockSuccess).toHaveBeenCalledWith("Workflow 'default' completed");
    expect(mockStatus).toHaveBeenCalledWith('Workflow', 'default');
    expect(mockStatus).toHaveBeenCalledWith('Result', 'Success', 'green');
  });

  it('should sanitize workflow names before terminal output', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'bad\x1b[31m-workflow\n',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockInfo).toHaveBeenCalledWith('Running workflow: bad-workflow\\n');
    expect(mockSuccess).toHaveBeenCalledWith("Workflow 'bad-workflow\\n' completed");
    expect(mockStatus).toHaveBeenCalledWith('Workflow', 'bad-workflow\\n');
  });

  it('should sanitize issue title and branch in terminal output', async () => {
    mockFetchIssue.mockReturnValueOnce({
      number: 99,
      title: 'Issue\x1b[31m\n',
      body: 'Test body',
      labels: [],
      comments: [],
    });
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      issueNumber: 99,
      workflow: 'default',
      branch: 'feature\x1b[2J\t',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockSuccess).toHaveBeenCalledWith('Issue #99 fetched: "Issue\\n"');
    expect(mockInfo).toHaveBeenCalledWith('Creating branch: feature\\t');
    expect(mockSuccess).toHaveBeenCalledWith('Branch created: feature\\t');
    expect(mockStatus).toHaveBeenCalledWith('Issue', '#99 "Issue\\n"');
    expect(mockStatus).toHaveBeenCalledWith('Branch', 'feature\\t');
  });

  it('should sanitize PR titles, branch names, and worktree paths in terminal output', async () => {
    mockFetchPrReviewComments.mockReturnValueOnce({
      number: 12,
      title: 'PR\x1b[31m\n',
      headRefName: 'feature\x1b[2J',
      baseRefName: 'main',
      comments: [],
    });
    mockConfirmAndCreateWorktree.mockResolvedValueOnce({
      execCwd: '/tmp/worktree\tpath',
      isWorktree: true,
      branch: 'feature\x1b[2J',
      baseBranch: 'main',
    });
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      prNumber: 12,
      workflow: 'default',
      autoPr: false,
      createWorktree: true,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockSuccess).toHaveBeenCalledWith('PR #12 fetched: "PR\\n"');
    expect(mockSuccess).toHaveBeenCalledWith('Worktree created: /tmp/worktree\\tpath');
  });

  it('passes provider/model overrides to task execution', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
      autoPr: false,
      cwd: '/tmp/test',
      provider: 'codex',
      model: 'codex-model',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'Fix the bug',
      cwd: '/tmp/test',
      workflowIdentifier: 'default',
      projectCwd: '/tmp/test',
      agentOverrides: { provider: 'codex', model: 'codex-model' },
    });
  });

  it('should return exit code 5 when PR creation fails', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: false, error: 'PR failed' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
      autoPr: true,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(5);
  });

  it('should return exit code 5 when createPullRequest throws', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockImplementationOnce(() => {
      throw new Error('--repo is not supported with GitLab provider. Use cwd context instead.');
    });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
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
      workflow: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      repo: 'owner/repo',
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'fix/my-branch',
        labels: ['takt-managed'],
        repo: 'owner/repo',
      }),
      '/tmp/test',
    );
  });

  it('should pass draft: true to createPullRequest when draftPr is true', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      draftPr: true,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
      '/tmp/test',
    );
  });

  it('should pass draft: false to createPullRequest when draftPr is false', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Fix the bug',
      workflow: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      draftPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ draft: false }),
      '/tmp/test',
    );
  });

  it('should pass baseBranch as base to createPullRequest when autoPr is true', async () => {
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
      workflow: 'default',
      branch: 'fix/my-branch',
      autoPr: true,
      cwd: '/tmp/test',
    });

    // Then
    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const prOptions = mockCreatePullRequest.mock.calls[0]?.[0] as { branch?: string; base?: string };
    expect(prOptions.branch).toBe('fix/my-branch');
    expect(prOptions.base).toBe('develop');
    expect(prOptions.base).not.toBeUndefined();
  });

  it('should use --task when both --task and positional task are provided', async () => {
    mockExecuteTask.mockResolvedValueOnce(true);

    const exitCode = await executePipeline({
      task: 'From --task flag',
      workflow: 'magi',
      autoPr: false,
      cwd: '/tmp/test',
    });

    expect(exitCode).toBe(0);
    expect(mockExecuteTask).toHaveBeenCalledWith({
      task: 'From --task flag',
      cwd: '/tmp/test',
      workflowIdentifier: 'magi',
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
        workflow: 'default',
        branch: 'test-branch',
        autoPr: false,
        cwd: '/tmp/test',
      });

      // Verify commit was called with expanded template
      const commitCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'commit',
      );
      expect(commitCall).toBeDefined();
      const commitArgs = commitCall![1] as string[];
      expect(commitArgs[commitArgs.indexOf('-m') + 1]).toBe('fix: Login broken (#42)');
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
        workflow: 'default',
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
        workflow: 'default',
        branch: 'fix-auth',
        autoPr: true,
        cwd: '/tmp/test',
      });

      // When prBodyTemplate is set, buildPrBody (mock) should NOT be called
      // Instead, the template is expanded directly
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: '## Summary\nAuth is broken.\n\nCloses #50\n\n<!-- takt:managed -->',
          labels: ['takt-managed'],
        }),
        '/tmp/test',
      );
      expect(mockBuildTaktManagedPrOptions).toHaveBeenCalledWith('## Summary\nAuth is broken.\n\nCloses #50');
    });

    it('should use pr_body_template for task-based PR creation when issue is unavailable', async () => {
      mockResolveConfigValues.mockReturnValue({
        pipeline: {
          prBodyTemplate: '## Summary\n{report}\n\nIssue:{issue}\nDetails:{issue_body}',
        },
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/pr/2' });

      await executePipeline({
        task: 'Fix task-only PR body',
        workflow: 'default',
        branch: 'fix-task-pr-body',
        autoPr: true,
        cwd: '/tmp/test',
      });

      expect(mockBuildPrBody).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: '## Summary\nWorkflow `default` completed successfully.\n\nIssue:\nDetails:\n\n<!-- takt:managed -->',
          labels: ['takt-managed'],
        }),
        '/tmp/test',
      );
      expect(mockBuildTaktManagedPrOptions).toHaveBeenCalledWith(
        '## Summary\nWorkflow `default` completed successfully.\n\nIssue:\nDetails:',
      );
    });

    it('should fall back to buildPrBody when no template is configured', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/pr/1' });

      await executePipeline({
        task: 'Fix bug',
        workflow: 'default',
        branch: 'fix-branch',
        autoPr: true,
        cwd: '/tmp/test',
      });

      // Should use buildPrBody (the mock)
      expect(mockBuildPrBody).toHaveBeenCalled();
      expect(mockBuildPrBody).toHaveBeenCalledWith(undefined, 'Workflow `default` completed successfully.');
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Default PR body\n\n<!-- takt:managed -->',
          labels: ['takt-managed'],
        }),
        '/tmp/test',
      );
      expect(mockBuildTaktManagedPrOptions).toHaveBeenCalledWith('Default PR body');
    });
  });

  describe('--skip-git', () => {
    it('should skip branch creation, commit, push when skipGit is true', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: false,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        workflowIdentifier: 'default',
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
        workflow: 'default',
        autoPr: true,
        skipGit: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it('should still return workflow failure exit code when skipGit is true', async () => {
      mockExecuteTask.mockResolvedValueOnce(false);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
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
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).toHaveBeenCalledWith(
        '/tmp/test',
        'Fix the bug',
        true,
        undefined,
        undefined,
      );
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test-worktree',
        workflowIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });
    });

    it('should not create worktree when createWorktree is false', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: false,
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).not.toHaveBeenCalled();
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        workflowIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: undefined,
      });
    });

    it('should use original cwd when createWorktree is undefined', async () => {
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).not.toHaveBeenCalled();
      expect(mockExecuteTask).toHaveBeenCalledWith({
        task: 'Fix the bug',
        cwd: '/tmp/test',
        workflowIdentifier: 'default',
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
        workflow: 'default',
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
        workflowIdentifier: 'default',
        projectCwd: '/tmp/test',
        agentOverrides: { provider: 'codex', model: 'codex-model' },
      });
    });

    it('should return exit code 4 when worktree creation fails', async () => {
      mockConfirmAndCreateWorktree.mockRejectedValueOnce(new Error('Failed to create worktree'));

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(4);
    });

    it('should return exit code 4 when worktree baseBranch is unresolved', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: undefined,
        taskSlug: 'fix-the-bug',
      });

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(4);
      expect(mockExecuteTask).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
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
        workflow: 'default',
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
        workflow: 'default',
        autoPr: true,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'fix/the-bug',
          base: 'main',
        }),
        '/tmp/test',
      );
    });

    it('should use worktree base branch for PR creation', async () => {
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/the-bug',
        baseBranch: 'release/main',
        taskSlug: 'fix-the-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/test/pr/1' });

      const exitCode = await executePipeline({
        task: 'Fix the bug',
        workflow: 'default',
        autoPr: true,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'fix/the-bug',
          base: 'release/main',
        }),
        '/tmp/test',
      );
    });

    it('should pass PR base branch to worktree creation when createWorktree is true', async () => {
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        baseRefName: 'release/main',
        headRefName: 'fix/auth-bug',
        comments: [{ author: 'reviewer1', body: 'Fix null check' }],
        reviews: [],
        files: ['src/auth.ts'],
      });
      mockConfirmAndCreateWorktree.mockResolvedValueOnce({
        execCwd: '/tmp/test-worktree',
        isWorktree: true,
        branch: 'fix/auth-bug',
        baseBranch: 'release/main',
        taskSlug: 'fix-auth-bug',
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
        createWorktree: true,
      });

      expect(exitCode).toBe(0);
      expect(mockConfirmAndCreateWorktree).toHaveBeenCalledWith(
        '/tmp/test',
        expect.any(String),
        true,
        'fix/auth-bug',
        'release/main',
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
      workflow: 'default',
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
      workflow: 'default',
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
      workflow: 'default',
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
            workflow: 'default',
          })],
        }),
      );
      expect(mockSendSlackNotification).toHaveBeenCalledWith(
        'https://hooks.slack.com/test',
        'TAKT Run Summary',
      );
    });

    it('should send failure notification when workflow fails', async () => {
      mockGetSlackWebhookUrl.mockReturnValue('https://hooks.slack.com/test');
      mockExecuteTask.mockResolvedValueOnce(false);

      await executePipeline({
        task: 'Fix the bug',
      workflow: 'default',
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
        workflow: 'default',
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

  describe('--pr pipeline', () => {
    it('should resolve PR review comments and execute pipeline with PR branch checkout', async () => {
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        headRefName: 'fix/auth-bug',
        comments: [{ author: 'commenter1', body: 'Update tests' }],
        reviews: [{ author: 'reviewer1', body: 'Fix null check' }],
        files: ['src/auth.ts'],
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, '/tmp/test');
      expect(mockFormatPrReviewAsTask).toHaveBeenCalled();
      // PR branch checkout
      const checkoutCall = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'checkout' && (call[1] as string[])[1] === 'fix/auth-bug',
      );
      expect(checkoutCall).toBeDefined();
    });

    it('should return exit code 2 when gh CLI is unavailable for --pr', async () => {
      mockCheckGhCli.mockReturnValueOnce({ available: false, error: 'gh not found' });

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(2);
    });

    it('should succeed even when PR has no review comments', async () => {
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        headRefName: 'fix/auth-bug',
        comments: [],
        reviews: [],
        files: ['src/auth.ts'],
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockFormatPrReviewAsTask).toHaveBeenCalled();
    });

    it('should return exit code 2 when PR fetch fails', async () => {
      mockFetchPrReviewComments.mockImplementationOnce(() => {
        throw new Error('PR not found');
      });

      const exitCode = await executePipeline({
        prNumber: 999,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(2);
    });

    it('should checkout PR branch instead of creating new branch', async () => {
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        headRefName: 'fix/auth-bug',
        comments: [{ author: 'reviewer1', body: 'Fix this' }],
        reviews: [],
        files: ['src/auth.ts'],
      });
      mockExecuteTask.mockResolvedValueOnce(true);

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: false,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      // Should checkout existing branch, not create new
      const checkoutNewBranch = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'checkout' && (call[1] as string[])[1] === '-b',
      );
      expect(checkoutNewBranch).toBeUndefined();
      // Should checkout existing PR branch
      const checkoutPrBranch = mockExecFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === 'git' && (call[1] as string[])[0] === 'checkout' && (call[1] as string[])[1] === 'fix/auth-bug',
      );
      expect(checkoutPrBranch).toBeDefined();
    });

    it('should pass PR base branch to PR creation when baseRefName is provided', async () => {
      // Given: remote default branch is develop, PR base is release/main
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
          return 'refs/remotes/origin/develop\n';
        }
        return 'abc1234\n';
      });
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        baseRefName: 'release/main',
        headRefName: 'fix/auth-bug',
        comments: [{ author: 'commenter1', body: 'Update tests' }],
        reviews: [{ author: 'reviewer1', body: 'Fix null check' }],
        files: ['src/auth.ts'],
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/org/repo/pull/1' });

      // When
      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: true,
        cwd: '/tmp/test',
      });

      // Then
      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
      const prOptions = mockCreatePullRequest.mock.calls[0]?.[0] as { base?: string };
      expect(prOptions.base).toBe('release/main');
      expect(prOptions.base).not.toBeUndefined();
      expect(prOptions.base).not.toBe('develop');
    });

    it('should resolve default base branch for PR creation when baseRefName is undefined', async () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
          return 'refs/remotes/origin/develop\n';
        }
        return 'abc1234\n';
      });
      mockFetchPrReviewComments.mockReturnValueOnce({
        number: 456,
        title: 'Fix auth bug',
        body: 'PR description',
        url: 'https://github.com/org/repo/pull/456',
        baseRefName: undefined,
        headRefName: 'fix/auth-bug',
        comments: [{ author: 'commenter1', body: 'Update tests' }],
        reviews: [{ author: 'reviewer1', body: 'Fix null check' }],
        files: ['src/auth.ts'],
      });
      mockExecuteTask.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockReturnValueOnce({ success: true, url: 'https://github.com/org/repo/pull/1' });

      const exitCode = await executePipeline({
        prNumber: 456,
        workflow: 'default',
        autoPr: true,
        cwd: '/tmp/test',
      });

      expect(exitCode).toBe(0);
      expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
      const prOptions = mockCreatePullRequest.mock.calls[0]?.[0] as { base?: string };
      expect(prOptions.base).toBe('develop');
      expect(prOptions.base).not.toBeUndefined();
    });
  });
});
