import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(), pipelineCommit: vi.fn(), push: vi.fn(), createPr: vi.fn(), findPr: vi.fn(),
  caccia: vi.fn(), merge: vi.fn(), runWorkflow: vi.fn(), submitPr: vi.fn(),
}));
vi.mock('../features/caccia/index.js', () => ({ runLinkedCacciaSafely: mocks.caccia }));
vi.mock('../features/merge/index.js', () => ({ runLinkedMergeSafely: mocks.merge }));
vi.mock('../infra/task/index.js', () => ({ autoCommitAndPush: mocks.commit }));
vi.mock('../infra/task/git.js', () => ({ pushBranch: mocks.push }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({ findExistingPr: mocks.findPr, createPullRequest: mocks.createPr }),
}));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValues: () => ({ pipeline: undefined }) }));
vi.mock('../features/pipeline/steps.js', () => ({
  resolveTaskContent: () => ({ task: 'Implement task' }),
  resolveExecutionContext: () => ({ execCwd: '/clone', branch: 'takt/task', baseBranch: 'main', isWorktree: true }),
  runWorkflow: mocks.runWorkflow, commitAndPush: mocks.pipelineCommit, buildCommitMessage: () => 'Implement task',
}));
vi.mock('../features/pipeline/prSubmission.js', () => ({ submitPullRequest: mocks.submitPr }));
vi.mock('../features/tasks/execute/loopAnalysisPublication.js', () => ({
  createLoopAnalysisPublicationCoordinator: vi.fn(), settleLoopAnalysisPublication: vi.fn(),
}));
vi.mock('../shared/ui/index.js', () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), status: vi.fn(), blankLine: vi.fn() }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSlackWebhookUrl: () => undefined,
}));

import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { executePipeline } from '../features/pipeline/execute.js';

const prUrl = 'https://github.com/org/repo/pull/123';
const entries = [
  ['postExecutionFlow', () => postExecutionFlow({ execCwd: '/clone', projectCwd: '/project',
    task: 'Implement task', branch: 'takt/task', shouldCreatePr: true, draftPr: false })],
  ['pipeline', () => executePipeline({ cwd: '/project', task: 'Implement task', workflow: 'takt-default', autoPr: true })],
] as const;

describe('Merge launch after PR creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.commit.mockResolvedValue({ success: true, commitHash: 'a'.repeat(40) });
    mocks.pipelineCommit.mockResolvedValue(true);
    mocks.createPr.mockReturnValue({ success: true, url: prUrl });
    mocks.submitPr.mockReturnValue(prUrl);
    mocks.runWorkflow.mockResolvedValue(true);
    mocks.caccia.mockResolvedValue(undefined);
    mocks.merge.mockResolvedValue(undefined);
  });

  it.each(entries)('%sはcaccia無効でも作成した同じPRをmerge起動入口へ渡す', async (_name, execute) => {
    await execute();
    expect(mocks.merge).toHaveBeenCalledOnce();
    expect(mocks.merge.mock.calls[0]?.slice(0, 2)).toEqual(['/project', prUrl]);
  });

  it.each(entries)('%sはcacciaの完了前にmergeを起動しない', async (_name, execute) => {
    let finishCaccia!: () => void;
    mocks.caccia.mockImplementation(() => new Promise<void>((resolve) => { finishCaccia = resolve; }));
    const running = execute();
    await vi.waitFor(() => expect(mocks.caccia).toHaveBeenCalledOnce());
    expect(mocks.merge).not.toHaveBeenCalled();
    finishCaccia();
    await running;
    expect(mocks.merge).toHaveBeenCalledOnce();
    expect(mocks.merge.mock.calls[0]?.slice(0, 2)).toEqual(['/project', prUrl]);
  });

  it.each(entries)('%sはPR作成失敗時にmergeを起動しない', async (_name, execute) => {
    mocks.createPr.mockReturnValue({ success: false, error: 'PR creation failed' });
    mocks.submitPr.mockReturnValue(undefined);
    await execute();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('通常実行は中断signalを自動起動へ引き継ぐ', async () => {
    const controller = new AbortController();
    await postExecutionFlow({ execCwd: '/clone', projectCwd: '/project', task: 'Implement task',
      branch: 'takt/task', shouldCreatePr: true, draftPr: false, abortSignal: controller.signal });
    expect(mocks.merge).toHaveBeenCalledWith('/project', prUrl, controller.signal,
      expect.objectContaining({ outputMode: 'terminal' }));
  });

  it.each(['terminal', 'silent'] as const)('通常実行とpipelineは親の%s表示設定を自動mergeへ渡す', async (outputMode) => {
    const display = { outputMode, taskPrefix: 'parent-task', taskColorIndex: 2, taskDisplayLabel: 'parent-label' };
    await postExecutionFlow({ execCwd: '/clone', projectCwd: '/project', task: 'Implement task',
      branch: 'takt/task', shouldCreatePr: true, draftPr: false, ...display });
    expect(mocks.merge).toHaveBeenCalledWith('/project', prUrl, undefined, display);

    mocks.merge.mockClear();
    await executePipeline({ cwd: '/project', task: 'Implement task', workflow: 'takt-default', autoPr: true, ...display });
    expect(mocks.merge).toHaveBeenCalledWith('/project', prUrl, undefined, display);
  });
});
