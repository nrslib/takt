import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetCurrentBranch,
  mockExecFileSync,
  mockAgentCall,
  mockFetchIssue,
  mockFetchPrReviewComments,
  mockFindExistingPr,
  mockCommentOnPr,
  mockMergePr,
  mockSaveTaskFile,
  mockCreateIssueFromTask,
  mockTaskRunnerListAllTaskItems,
  mockResolveBaseBranch,
} = vi.hoisted(() => ({
  mockGetCurrentBranch: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockAgentCall: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockCommentOnPr: vi.fn(),
  mockMergePr: vi.fn(),
  mockSaveTaskFile: vi.fn(),
  mockCreateIssueFromTask: vi.fn(),
  mockTaskRunnerListAllTaskItems: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    listAllTaskItems() {
      return mockTaskRunnerListAllTaskItems();
    }
  },
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  materializeCloneHeadToRootBranch: vi.fn(),
  relayPushCloneToOrigin: vi.fn(),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  saveTaskFile: (...args: unknown[]) => mockSaveTaskFile(...args),
  createIssueFromTask: (...args: unknown[]) => mockCreateIssueFromTask(...args),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn((name: string, _lang: string, vars?: Record<string, string>) => {
    if (name === 'sync_conflict_resolver_system_prompt') {
      return 'system-prompt';
    }
    if (name === 'sync_conflict_resolver_message') {
      return `message:${vars?.originalInstruction ?? ''}`;
    }
    return '';
  }),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: vi.fn(() => ({
    checkCliStatus: vi.fn(() => ({ available: true })),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
    mergePr: (...args: unknown[]) => mockMergePr(...args),
  })),
}));

vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn(() => 'en'),
  resolveConfigValues: vi.fn(() => ({ syncConflictResolver: undefined })),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({
    setup: vi.fn(() => ({ call: mockAgentCall })),
  })),
}));

vi.mock('../core/config/provider-resolution.js', () => ({
  resolveAssistantProviderModelFromConfig: vi.fn(() => ({ provider: 'codex', model: 'gpt-5.4' })),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

import { DefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

function createCommandError(message: string, stderr?: string): Error {
  const error = new Error(message);
  if (stderr !== undefined) {
    Object.assign(error, { stderr: Buffer.from(stderr, 'utf-8') });
  }
  return error;
}

describe('DefaultSystemStepServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentBranch.mockReturnValue('task/test-branch');
    mockFindExistingPr.mockReturnValue(undefined);
    mockAgentCall.mockResolvedValue({
      status: 'done',
      content: 'resolved',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });
    mockCommentOnPr.mockReturnValue({ success: true });
    mockMergePr.mockReturnValue({ success: true });
    mockSaveTaskFile.mockResolvedValue({ taskName: 'task-1', tasksFile: '/repo/.takt/tasks.yaml' });
    mockCreateIssueFromTask.mockReturnValue(undefined);
    mockTaskRunnerListAllTaskItems.mockReturnValue([]);
    mockResolveBaseBranch.mockImplementation((_cwd: string, branch?: string) => ({ branch: branch ?? 'main' }));
  });

  it('resolves issue_context from current task issue number', () => {
    mockFetchIssue.mockReturnValue({
      number: 586,
      title: 'Follow-up orchestration',
      body: 'Plan the next task',
      labels: ['automation'],
      comments: [{ author: 'reviewer', body: 'Needs follow-up' }],
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect issue context',
      taskContext: { issueNumber: 586 },
    });

    const result = services.resolveSystemInput({ type: 'issue_context', source: 'current_task', as: 'issue' });

    expect(mockFetchIssue).toHaveBeenCalledWith(586, '/repo');
    expect(result).toEqual({
      exists: true,
      number: 586,
      title: 'Follow-up orchestration',
      body: 'Plan the next task',
      labels: ['automation'],
      comments: [{ author: 'reviewer', body: 'Needs follow-up' }],
    });
  });

  it('returns exists: false for issue_context when current task has no issue number', () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect issue context',
    });

    const result = services.resolveSystemInput({ type: 'issue_context', source: 'current_task', as: 'issue' });

    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ exists: false });
  });

  it('resolves pr_context when the current branch has an open PR', () => {
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://example.test/pr/42' });
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect PR context',
    });

    const result = services.resolveSystemInput({ type: 'pr_context', source: 'current_branch', as: 'pr' });

    expect(mockFindExistingPr).toHaveBeenCalledWith('task/test-branch', '/repo');
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(42, '/repo');
    expect(result).toEqual({
      exists: true,
      number: 42,
      url: 'https://example.test/pr/42',
      branch: 'task/test-branch',
      baseBranch: 'improve',
      title: 'Follow-up PR',
      body: 'Body',
    });
  });

  it('returns branch only when pr_context has no open PR', () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect PR context',
    });

    const result = services.resolveSystemInput({ type: 'pr_context', source: 'current_branch', as: 'pr' });

    expect(result).toEqual({ exists: false, branch: 'task/test-branch' });
    expect(mockFetchPrReviewComments).not.toHaveBeenCalled();
  });

  it('resolves branch_context from the current branch', () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect branch context',
    });

    const result = services.resolveSystemInput({ type: 'branch_context', source: 'current_task', as: 'branch' });

    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/repo/worktree');
    expect(result).toEqual({ exists: true, name: 'task/test-branch' });
  });

  it('aggregates task_queue_context counts from TaskRunner', () => {
    mockTaskRunnerListAllTaskItems.mockReturnValue([
      { kind: 'running' },
      { kind: 'running' },
      { kind: 'pending' },
      { kind: 'completed' },
      { kind: 'failed' },
      { kind: 'exceeded' },
      { kind: 'pr_failed' },
    ]);

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect queue',
    });

    const result = services.resolveSystemInput({ type: 'task_queue_context', source: 'current_project', as: 'queue' });

    expect(result).toEqual({
      exists: true,
      total_count: 7,
      pending_count: 1,
      running_count: 2,
      completed_count: 1,
      failed_count: 1,
      exceeded_count: 1,
      pr_failed_count: 1,
    });
  });

  it('creates a new follow-up task and forwards worktree options', async () => {
    mockCreateIssueFromTask.mockReturnValue(586);

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    const result = await services.executeEffect({
      type: 'enqueue_task',
      mode: 'new',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      issue: {
        create: true,
        labels: ['bug', '', 'enhancement'],
      },
      base_branch: 'improve',
      worktree: {
        enabled: true,
        auto_pr: true,
        draft_pr: true,
      },
    }, {
      mode: 'new',
      workflow: 'takt-default',
      task: 'Implement follow-up effect',
      issue: {
        create: true,
        labels: ['bug', '', 'enhancement'],
      },
      base_branch: 'improve',
      worktree: {
        enabled: true,
        auto_pr: true,
        draft_pr: true,
      },
    }, {} as never);

    expect(mockCreateIssueFromTask).toHaveBeenCalledWith('Implement follow-up effect', {
      cwd: '/repo',
      labels: ['bug', 'enhancement'],
    });
    expect(mockSaveTaskFile).toHaveBeenCalledWith('/repo', 'Implement follow-up effect', {
      workflow: 'takt-default',
      issue: 586,
      worktree: true,
      baseBranch: 'improve',
      autoPr: true,
      draftPr: true,
    });
    expect(mockResolveBaseBranch).toHaveBeenCalledWith('/repo', 'improve');
    expect(result).toEqual({
      success: true,
      failed: false,
      taskName: 'task-1',
      tasksFile: '/repo/.takt/tasks.yaml',
      issueNumber: 586,
    });
  });

  it('returns failed result when issue creation for enqueue_task fails', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    const result = await services.executeEffect({
      type: 'enqueue_task',
      mode: 'new',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      issue: { create: true },
    }, {
      mode: 'new',
      workflow: 'takt-default',
      task: 'Implement follow-up effect',
      issue: { create: true },
    }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      error: 'Failed to create issue from task',
    });
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
  });

  it('creates a PR follow-up task using pr head and base branches', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'main',
      comments: [],
      reviews: [],
      files: [],
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    const result = await services.executeEffect({
      type: 'enqueue_task',
      mode: 'from_pr',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      pr: '{context:route.pr.number}',
    }, {
      mode: 'from_pr',
      workflow: 'takt-default',
      task: 'Address review comments',
      pr: 42,
    }, {} as never);

    expect(mockSaveTaskFile).toHaveBeenCalledWith('/repo', 'Address review comments', {
      workflow: 'takt-default',
      worktree: true,
      branch: 'task/test-branch',
      baseBranch: 'main',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
      prNumber: 42,
    });
    expect(mockResolveBaseBranch).toHaveBeenCalledWith('/repo', 'main');
    expect(result).toEqual({
      success: true,
      failed: false,
      taskName: 'task-1',
      tasksFile: '/repo/.takt/tasks.yaml',
      prNumber: 42,
    });
  });

  it('validates enqueue_task payload fields', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    await expect(services.executeEffect({
      type: 'enqueue_task',
      mode: 'from_pr',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      pr: '{context:route.pr.number}',
    }, {
      mode: 'from_pr',
      workflow: 'takt-default',
      task: 'Address review comments',
      pr: '42',
    }, {} as never)).rejects.toThrow('System effect requires positive integer field "pr"');
  });

  it('rejects malformed enqueue_task issue payloads at the effect boundary', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    await expect(services.executeEffect({
      type: 'enqueue_task',
      mode: 'new',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      issue: '{structured:plan.issue}',
    }, {
      mode: 'new',
      workflow: 'takt-default',
      task: 'Implement follow-up effect',
      issue: { create: 'yes', labels: ['bug'] },
    }, {} as never)).rejects.toThrow('System effect requires boolean field "issue.create"');
  });

  it('rejects malformed enqueue_task worktree payloads at the effect boundary', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    await expect(services.executeEffect({
      type: 'enqueue_task',
      mode: 'new',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      worktree: {
        enabled: true,
      },
    }, {
      mode: 'new',
      workflow: 'takt-default',
      task: 'Implement follow-up effect',
      worktree: { auto_pr: true },
    }, {} as never)).rejects.toThrow(
      'System effect requires "worktree.enabled" when auto_pr or draft_pr is true',
    );
  });

  it('fails enqueue_task when base_branch is rejected by resolveBaseBranch', async () => {
    mockResolveBaseBranch.mockImplementation(() => {
      throw new Error('Base branch must be a branch name, not a remote-tracking ref: origin/improve');
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    await expect(services.executeEffect({
      type: 'enqueue_task',
      mode: 'new',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      base_branch: 'origin/improve',
    }, {
      mode: 'new',
      workflow: 'takt-default',
      task: 'Implement follow-up effect',
      base_branch: 'origin/improve',
    }, {} as never)).rejects.toThrow(
      'Base branch must be a branch name, not a remote-tracking ref: origin/improve',
    );
  });

  it('rejects from_pr enqueue_task payloads that include issue or worktree at the effect boundary', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Plan follow-up',
    });

    await expect(services.executeEffect({
      type: 'enqueue_task',
      mode: 'from_pr',
      workflow: 'takt-default',
      task: '{structured:plan.task_markdown}',
      pr: '{context:route.pr.number}',
      issue: '{structured:plan.issue}',
    }, {
      mode: 'from_pr',
      workflow: 'takt-default',
      task: 'Address review comments',
      pr: 42,
      issue: { create: true },
    }, {} as never)).rejects.toThrow('System effect mode "from_pr" does not allow field "issue"');
  });

  it('treats non-conflict merge failures as failed sync_with_root effects', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge failed', 'fatal: refusing to merge unrelated histories');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Investigate failure',
    });

    const result = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      conflicted: false,
      error: 'fatal: refusing to merge unrelated histories',
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, 'git', ['fetch', 'origin', 'improve'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, 'git', ['merge', 'origin/improve'], expect.any(Object));
  });

  it('fails sync_with_root when cwd is not on the PR head branch', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Investigate failure',
    });

    const result = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      conflicted: false,
      error: 'Error: System effect requires cwd to be on PR branch "task/test-branch", but current branch is "main"',
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('marks merge conflicts as conflicted sync_with_root effects', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Investigate conflict',
    });

    const result = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: false,
      conflicted: true,
      error: 'CONFLICT (content): Merge conflict in src/file.ts',
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(3, 'git', ['merge', '--abort'], expect.any(Object));
  });

  it('fails sync_with_root when conflict cleanup cannot abort the merge', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockImplementationOnce(() => {
        throw createCommandError('abort failed', 'fatal: no merge to abort');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Investigate conflict',
    });

    const result = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      conflicted: false,
      error: 'CONFLICT (content): Merge conflict in src/file.ts (merge abort failed: fatal: no merge to abort)',
    });
  });

  it('returns success for sync_with_root when base branch merge succeeds', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync.mockReturnValue('');

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Sync branch',
    });

    const result = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: true,
      failed: false,
      conflicted: false,
    });
  });

  it('returns success for comment_pr effect', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Comment on PR',
    });

    const result = await services.executeEffect({ type: 'comment_pr', pr: 42, body: 'Looks good' }, {
      pr: 42,
      body: 'Looks good',
    }, {} as never);

    expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'Looks good', '/repo');
    expect(result).toEqual({ success: true, failed: false });
  });

  it('returns failed comment_pr effect results with provider errors', async () => {
    mockCommentOnPr.mockReturnValue({ success: false, error: 'comment failed' });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Comment on PR',
    });

    const result = await services.executeEffect({ type: 'comment_pr', pr: 42, body: 'Looks good' }, {
      pr: 42,
      body: 'Looks good',
    }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      error: 'comment failed',
    });
  });

  it('validates comment_pr payload fields', async () => {
    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Comment on PR',
    });

    await expect(services.executeEffect({ type: 'comment_pr', pr: 42, body: 'Looks good' }, {
      pr: '42',
      body: 'Looks good',
    }, {} as never)).rejects.toThrow('System effect requires positive integer field "pr"');
  });

  it('returns success for resolve_conflicts_with_ai when AI resolves a merge conflict', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const result = await services.executeEffect({ type: 'resolve_conflicts_with_ai', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: true,
      failed: false,
      conflicted: false,
    });
    expect(mockAgentCall).toHaveBeenCalled();
  });

  it('returns success for resolve_conflicts_with_ai without calling AI when there is no conflict', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync.mockReturnValue('');

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const result = await services.executeEffect({ type: 'resolve_conflicts_with_ai', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: true,
      failed: false,
      conflicted: false,
    });
    expect(mockAgentCall).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenNthCalledWith(1, 'git', ['fetch', 'origin', 'task/test-branch'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(2, 'git', ['merge', '--ff-only', 'origin/task/test-branch'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(3, 'git', ['fetch', 'origin', 'improve'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(4, 'git', ['merge', 'origin/improve'], expect.any(Object));
  });

  it('fails resolve_conflicts_with_ai when cwd is not on the PR head branch', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const result = await services.executeEffect(
      { type: 'resolve_conflicts_with_ai', pr: 42 },
      { pr: 42 },
      {} as never,
    );

    expect(result).toEqual({
      success: false,
      failed: true,
      conflicted: false,
      error: 'Error: System effect requires cwd to be on PR branch "task/test-branch", but current branch is "main"',
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('hands off sync_with_root conflicts to resolve_conflicts_with_ai on the same worktree', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const syncResult = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);
    const resolveResult = await services.executeEffect(
      { type: 'resolve_conflicts_with_ai', pr: 42 },
      { pr: 42 },
      {} as never,
    );

    expect(syncResult).toEqual({
      success: false,
      failed: false,
      conflicted: true,
      error: 'CONFLICT (content): Merge conflict in src/file.ts',
    });
    expect(resolveResult).toEqual({
      success: true,
      failed: false,
      conflicted: false,
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(3, 'git', ['merge', '--abort'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(4, 'git', ['fetch', 'origin', 'task/test-branch'], expect.any(Object));
    expect(mockExecFileSync).toHaveBeenNthCalledWith(5, 'git', ['merge', '--ff-only', 'origin/task/test-branch'], expect.any(Object));
    expect(mockAgentCall).toHaveBeenCalled();
  });

  it('includes merge abort failure details when AI conflict resolution fails', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockAgentCall.mockResolvedValue({
      status: 'error',
      error: 'AI conflict resolution failed',
      content: '',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockImplementationOnce(() => {
        throw createCommandError('abort failed', 'fatal: no merge to abort');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const result = await services.executeEffect({ type: 'resolve_conflicts_with_ai', pr: 42 }, { pr: 42 }, {} as never);

    expect(result).toEqual({
      success: false,
      failed: true,
      conflicted: true,
      error: 'AI conflict resolution failed (merge abort failed: fatal: no merge to abort)',
    });
  });

  it('keeps resolve_conflicts_with_ai failure reproducible after sync_with_root conflict handoff', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockAgentCall.mockResolvedValue({
      status: 'error',
      error: 'AI conflict resolution failed',
      content: '',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockReturnValueOnce('');

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const syncResult = await services.executeEffect({ type: 'sync_with_root', pr: 42 }, { pr: 42 }, {} as never);
    const resolveResult = await services.executeEffect(
      { type: 'resolve_conflicts_with_ai', pr: 42 },
      { pr: 42 },
      {} as never,
    );

    expect(syncResult).toEqual({
      success: false,
      failed: false,
      conflicted: true,
      error: 'CONFLICT (content): Merge conflict in src/file.ts',
    });
    expect(resolveResult).toEqual({
      success: false,
      failed: true,
      conflicted: true,
      error: 'AI conflict resolution failed',
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(7, 'git', ['merge', '--abort'], expect.any(Object));
  });

  it('aborts stale merge state before retrying resolve_conflicts_with_ai', async () => {
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge in progress', 'fatal: You have not concluded your merge (MERGE_HEAD exists)');
      })
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Resolve conflicts',
    });

    const result = await services.executeEffect(
      { type: 'resolve_conflicts_with_ai', pr: 42 },
      { pr: 42 },
      {} as never,
    );

    expect(result).toEqual({
      success: true,
      failed: false,
      conflicted: false,
    });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(3, 'git', ['merge', '--abort'], expect.any(Object));
    expect(mockAgentCall).toHaveBeenCalled();
  });

  it('throws when branch_context cannot resolve the current branch', () => {
    mockGetCurrentBranch.mockImplementationOnce(() => {
      throw createCommandError('branch lookup failed', 'fatal: not a git repository');
    });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Inspect context',
    });

    expect(() => services.resolveSystemInput({ type: 'branch_context', source: 'current_task', as: 'branch' })).toThrow(
      'Failed to resolve current branch: fatal: not a git repository',
    );
  });

  it('returns successful merge_pr effect results', async () => {
    mockMergePr.mockReturnValue({ success: true });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Prepare merge',
    });

    const result = await services.executeEffect({ type: 'merge_pr', pr: 42 }, { pr: 42 }, {} as never);

    expect(mockMergePr).toHaveBeenCalledWith(42, '/repo');
    expect(result).toEqual({ success: true, failed: false });
  });

  it('returns failed merge_pr effect results with provider errors', async () => {
    mockMergePr.mockReturnValue({ success: false, error: 'merge blocked by checks' });

    const services = new DefaultSystemStepServices({
      cwd: '/repo/worktree',
      projectCwd: '/repo',
      task: 'Prepare merge',
    });

    const result = await services.executeEffect({ type: 'merge_pr', pr: 42 }, { pr: 42 }, {} as never);

    expect(mockMergePr).toHaveBeenCalledWith(42, '/repo');
    expect(result).toEqual({
      success: false,
      failed: true,
      error: 'merge blocked by checks',
    });
  });
});
