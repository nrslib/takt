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
});
