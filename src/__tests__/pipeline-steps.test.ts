import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExpandPipelineTemplate = vi.fn();
const mockExecuteTask = vi.fn();
const mockGetGitProvider = vi.fn();
const mockStatusStart = vi.fn();
const mockStatusStop = vi.fn();

vi.mock('../features/pipeline/templateExpander.js', () => ({
  expandPipelineTemplate: (...args: unknown[]) =>
    mockExpandPipelineTemplate(...(args as [string, Record<string, string>])),
}));

vi.mock('../features/tasks/index.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
  confirmAndCreateWorktree: vi.fn(),
}));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => mockGetGitProvider(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../shared/ui/StatusLine.js', () => ({
  statusLine: {
    start: mockStatusStart,
    stop: mockStatusStop,
  },
}));

const { buildCommitMessage, runWorkflow } = await import('../features/pipeline/steps.js');

describe('buildCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate commit message template expansion to the shared pipeline helper', () => {
    mockExpandPipelineTemplate.mockReturnValueOnce('expanded commit message');

    const result = buildCommitMessage(
      { commitMessageTemplate: 'feat: {title} (#{issue})' },
      {
        number: 42,
        title: 'Fix pipeline',
        body: 'Issue body',
        labels: [],
        comments: [],
      },
      undefined,
    );

    expect(result).toBe('expanded commit message');
    expect(mockExpandPipelineTemplate).toHaveBeenCalledWith('feat: {title} (#{issue})', {
      title: 'Fix pipeline',
      issue: '42',
    });
  });
});

describe('runWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTask.mockResolvedValue(true);
    mockGetGitProvider.mockReturnValue({ name: 'pipeline-provider' });
  });

  it('passes the task spec prompt and matching run slug while retaining PR and execution settings', async () => {
    const taskSpec = {
      runSlug: 'image-run', sourceTaskDir: '/project/.takt/tasks/source', attachmentManifest: [],
      taskPrompt: 'Read .takt/runs/image-run/context/task/order.md', orderContent: 'Source order', stagedOrderContent: 'Staged order',
    };
    const prContext = {
      source: 'pr_review' as const, prNumber: 792, headBranch: 'feature/images', baseBranch: 'main', baseBranchSource: 'pull_request' as const,
    };

    await runWorkflow('/project', 'default', 'Original body', '/worktree', { provider: 'mock', model: 'test-model' }, {
      execCwd: '/worktree', isWorktree: true, branch: 'feature/images', baseBranch: 'main', prContext,
    }, undefined, taskSpec);

    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      task: taskSpec.taskPrompt, taskSpec, reportDirName: taskSpec.runSlug, cwd: '/worktree', projectCwd: '/project',
      prContext, agentOverrides: { provider: 'mock', model: 'test-model' },
    }));
  });

  it('Given an auto-PR pipeline branch, When workflow execution starts, Then loop analysis receives the resolved PR context', async () => {
    const loopAnalysisPublication = {
      branch: 'takt/pipeline-task',
      register: vi.fn(),
      settle: vi.fn(),
    };

    const result = await runWorkflow(
      '/project',
      'default',
      'Pipeline task',
      '/worktree/clone',
      { autoPr: true } as never,
      {
        execCwd: '/worktree/clone',
        isWorktree: true,
        branch: 'takt/pipeline-task',
        baseBranch: 'main',
      },
      loopAnalysisPublication,
    );

    expect(result).toBe(true);
    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      loopAnalysisPublication,
    }));
  });

  it.each(['terminal', 'silent'] as const)('passes the parent %s display and task label to workflow execution', async (outputMode) => {
    const display = { provider: undefined, outputMode, taskPrefix: 'pipeline-task', taskDisplayLabel: 'pipeline-display-label', taskColorIndex: 2 };
    await runWorkflow('/project', 'default', 'Pipeline task', '/worktree/clone', display, {
      execCwd: '/worktree/clone', isWorktree: true, branch: 'takt/pipeline', baseBranch: 'main',
    });
    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      outputMode, taskPrefix: display.taskPrefix, taskDisplayLabel: display.taskDisplayLabel, taskColorIndex: display.taskColorIndex,
    }));
    if (outputMode === 'silent') {
      expect(mockStatusStart).not.toHaveBeenCalled();
      expect(mockStatusStop).not.toHaveBeenCalled();
    }
  });
});
