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
vi.mock('../features/tasks/index.js', () => ({
  executeTask: mockExecuteTask,
}));

// Mock loadGlobalConfig
const mockLoadGlobalConfig = vi.fn();
vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  loadGlobalConfig: mockLoadGlobalConfig,
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
// Mock debug logger
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { executePipeline } = await import('../features/pipeline/index.js');

describe('executePipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: git operations succeed
    mockExecFileSync.mockReturnValue('abc1234\n');
    // Default: no pipeline config
    mockLoadGlobalConfig.mockReturnValue({
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      provider: 'claude',
    });
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

  it('should pass baseBranch as base to createPullRequest', async () => {
    // Given: getCurrentBranch returns 'develop' before branch creation
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return 'develop\n';
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
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        provider: 'claude',
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
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        provider: 'claude',
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
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        provider: 'claude',
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
});
