import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import type { PostExecutionOptions } from '../features/tasks/execute/postExecution.js';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(), pipelineCommit: vi.fn(), push: vi.fn(), createPr: vi.fn(), findPr: vi.fn(),
  caccia: vi.fn(), merge: vi.fn(), runWorkflow: vi.fn(), submitPr: vi.fn(),
  config: vi.fn(), loadWorkflow: vi.fn(), resolveCall: vi.fn(), comment: vi.fn(),
}));
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<typeof import('../features/caccia/index.js')>(), runCaccia: mocks.caccia,
}));
vi.mock('../features/merge/index.js', async (original) => ({
  ...await original<typeof import('../features/merge/index.js')>(), runLinkedMergeSafely: mocks.merge,
}));
vi.mock('../infra/task/index.js', () => ({ autoCommitAndPush: mocks.commit }));
vi.mock('../infra/task/git.js', () => ({ pushBranch: mocks.push }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({ findExistingPr: mocks.findPr, createPullRequest: mocks.createPr, commentOnPr: mocks.comment }),
}));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(),
  resolveConfigValues: () => ({ pipeline: undefined }), resolveConfigValue: mocks.config,
}));
vi.mock('../infra/config/loaders/workflowResolver.js', async (original) => ({
  ...await original<typeof import('../infra/config/loaders/workflowResolver.js')>(),
  loadWorkflowByIdentifier: mocks.loadWorkflow,
}));
vi.mock('../infra/config/loaders/workflowCallResolver.js', async (original) => ({
  ...await original<typeof import('../infra/config/loaders/workflowCallResolver.js')>(),
  resolveWorkflowCallTarget: mocks.resolveCall,
}));
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
const postOptions = {
  execCwd: '/clone', projectCwd: '/project', task: 'Implement task',
  branch: 'takt/task', shouldCreatePr: true, draftPr: false, workflowHasCaccia: false,
};
const entries = [
  ['postExecutionFlow', () => postExecutionFlow(postOptions)],
  ['pipeline', () => executePipeline({ cwd: '/project', task: 'Implement task', workflow: 'takt-default', autoPr: true })],
] as const;

describe('Merge launch after PR creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.commit.mockResolvedValue({ success: true, commitHash: 'a'.repeat(40) });
    mocks.pipelineCommit.mockResolvedValue(true);
    mocks.createPr.mockReturnValue({ success: true, url: prUrl });
    mocks.submitPr.mockReturnValue(prUrl);
    mocks.runWorkflow.mockResolvedValue({ success: true, workflowHasCaccia: false });
    mocks.comment.mockReturnValue({ success: true });
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: false } : undefined);
    mocks.caccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0 });
    mocks.merge.mockResolvedValue(undefined);
  });

  it.each(entries)('%sはCaccia無効時も作成した同じPRをmerge起動入口へ渡す', async (_name, execute) => {
    await execute();
    expect(mocks.merge).toHaveBeenCalledOnce();
    expect(mocks.merge.mock.calls[0]?.slice(0, 2)).toEqual(['/project', prUrl]);
    expect(mocks.caccia).not.toHaveBeenCalled();
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
      expect.objectContaining({ outputMode: 'terminal' }), undefined);
  });

  it.each(['terminal', 'silent'] as const)('通常実行とpipelineは親の%s表示設定を自動mergeへ渡す', async (outputMode) => {
    const display = { outputMode, taskPrefix: 'parent-task', taskColorIndex: 2, taskDisplayLabel: 'parent-label' };
    await postExecutionFlow({ execCwd: '/clone', projectCwd: '/project', task: 'Implement task',
      branch: 'takt/task', shouldCreatePr: true, draftPr: false, ...display });
    expect(mocks.merge).toHaveBeenCalledWith('/project', prUrl, undefined, display, undefined);

    mocks.merge.mockClear();
    await executePipeline({ cwd: '/project', task: 'Implement task', workflow: 'takt-default', autoPr: true, ...display });
    expect(mocks.merge).toHaveBeenCalledWith('/project', prUrl, undefined, display);
  });

  describe('Caccia enabled after PR publication', () => {
    beforeEach(() => {
      mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true } : undefined);
      mocks.runWorkflow.mockResolvedValue({ success: true, workflowHasCaccia: false });
    });

    it.each(entries)('%s runs Caccia once for the published PR without merge configuration', async (_name, execute) => {
      await execute();
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        entry: 'linked', projectCwd: '/project', prNumber: 123, settings: expect.objectContaining({ enabled: true }),
      }));
    });

    it('runs Caccia once after successfully updating an existing PR', async () => {
      mocks.findPr.mockReturnValue({ number: 123, url: prUrl });
      expect(await postExecutionFlow(postOptions)).toEqual({ prUrl });
      expect(mocks.comment).toHaveBeenCalledOnce();
      expect(mocks.createPr).not.toHaveBeenCalled();
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prNumber: 123, entry: 'linked' }));
    });

    it.each(entries)('%s does not run Caccia when publication fails', async (_name, execute) => {
      mocks.createPr.mockReturnValue({ success: false, error: 'PR creation failed' });
      mocks.submitPr.mockReturnValue(undefined);
      await execute();
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it('does not run Caccia when the existing PR comment fails', async () => {
      mocks.findPr.mockReturnValue({ number: 123, url: prUrl });
      mocks.comment.mockReturnValue({ success: false, error: 'comment rejected' });
      expect(await postExecutionFlow(postOptions)).toMatchObject({ prFailed: true });
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it.each([false, true])('does not launch Caccia or merge for a goal task (existing PR=%s)', async (existing) => {
      mocks.findPr.mockReturnValue(existing ? { number: 123, url: prUrl } : undefined);
      expect(await postExecutionFlow({ ...postOptions, goalId: 'goal-owned' })).toEqual({ prUrl });
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it.each([false, true])('suppresses post-processing for an executed workflow with Caccia (existing PR=%s)', async (existing) => {
      mocks.findPr.mockReturnValue(existing ? { number: 123, url: prUrl } : undefined);
      const options: PostExecutionOptions & { workflowHasCaccia: boolean } = { ...postOptions, workflowHasCaccia: true };
      expect(await postExecutionFlow(options)).toEqual({ prUrl });
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it('preserves workflow Caccia suppression in the pipeline execution result', async () => {
      mocks.runWorkflow.mockResolvedValue({ success: true, workflowHasCaccia: true });
      expect(await entries[1][1]()).toBe(0);
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it('does not publish or launch follow-up work for a failed workflow result object', async () => {
      mocks.runWorkflow.mockResolvedValue({ success: false, workflowHasCaccia: false });
      expect(await entries[1][1]()).toBe(3);
      expect(mocks.pipelineCommit).not.toHaveBeenCalled();
      expect(mocks.submitPr).not.toHaveBeenCalled();
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it.each([false, true])('does not run Caccia without a published pipeline PR (skipGit=%s)', async (skipGit) => {
      expect(await executePipeline({ cwd: '/project', task: 'Implement task', workflow: 'default',
        autoPr: skipGit, skipGit })).toBe(0);
      expect(mocks.submitPr).not.toHaveBeenCalled();
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it.each([...entries, ['updated PR', () => {
      mocks.findPr.mockReturnValue({ number: 123, url: prUrl });
      return postExecutionFlow(postOptions);
    }]] as const)('%s completes Caccia before launching merge', async (_name, execute) => {
      autoMerge(mergeWorkflow([agentStep]), true);
      let release!: () => void;
      const completion = new Promise<void>((resolve) => { release = resolve; });
      const events: string[] = [];
      mocks.caccia.mockImplementation(async () => {
        events.push('caccia started');
        await completion;
        events.push('caccia completed');
        return { outcome: 'success', unresolvedCount: 0 };
      });
      mocks.merge.mockImplementation(async () => { events.push('merge started'); });
      const pending = execute();
      try {
        // 呼び出し漏れでも待ち続けないよう、状態の確認には期限を設ける。
        await vi.waitFor(() => expect(mocks.caccia).toHaveBeenCalledOnce());
        expect(mocks.merge).not.toHaveBeenCalled();
      } finally {
        release();
        await pending;
      }
      expect(events).toEqual(['caccia started', 'caccia completed', 'merge started']);
    });

    it.each(['terminal', 'silent'] as const)('passes the parent %s display and abort signal to Caccia', async (outputMode) => {
      const controller = new AbortController();
      const display = { outputMode, taskPrefix: 'parent', taskColorIndex: 2, taskDisplayLabel: 'parent label' };
      await postExecutionFlow({ ...postOptions, ...display, abortSignal: controller.signal });
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        ...display, abortSignal: controller.signal, projectCwd: '/project', prNumber: 123,
      }));
    });

    const systemStep = {
      name: 'external-review', kind: 'system' as const, personaDisplayName: 'system', instruction: '',
      effects: [{ type: 'caccia' as const, pr: 123 }],
    };
    const agentStep = { name: 'caccia', personaDisplayName: 'coder', instruction: 'type: caccia' };
    function mergeWorkflow(steps: WorkflowConfig['steps']): WorkflowConfig {
      return { name: 'custom-merge', initialStep: steps[0]!.name, maxSteps: 3, steps };
    }
    function autoMerge(workflow: WorkflowConfig, autoStart: boolean) {
      mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true }
        : key === 'merge' ? { autoStart, workflow: 'custom-merge' } : undefined);
      mocks.loadWorkflow.mockImplementation((identifier: string) => identifier === 'custom-merge' ? workflow : null);
    }

    it.each(entries)('%s suppresses automatic Caccia when the selected merge workflow owns the effect', async (_name, execute) => {
      autoMerge(mergeWorkflow([systemStep]), true);
      await execute();
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it('includes Caccia in a called merge workflow when deciding suppression', async () => {
      autoMerge(mergeWorkflow([{
        name: 'delegate', kind: 'workflow_call', call: 'merge-child', personaDisplayName: 'child', instruction: '',
      }]), true);
      mocks.resolveCall.mockReturnValue(mergeWorkflow([systemStep]));
      await postExecutionFlow(postOptions);
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it.each(entries)('%s does not treat a merge instruction or step name as a Caccia effect', async (_name, execute) => {
      autoMerge(mergeWorkflow([agentStep]), true);
      await execute();
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prNumber: 123 }));
      expect(mocks.merge).toHaveBeenCalledOnce();
      expect(mocks.caccia.mock.invocationCallOrder[0]).toBeLessThan(mocks.merge.mock.invocationCallOrder[0]!);
    });

    it('does not suppress Caccia for a merge workflow that will not auto-start', async () => {
      autoMerge(mergeWorkflow([systemStep]), false);
      await postExecutionFlow(postOptions);
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prNumber: 123 }));
      expect(mocks.loadWorkflow).not.toHaveBeenCalled();
    });

    it('does not treat a missing execution decision as an effect-free workflow', async () => {
      expect(await postExecutionFlow({ ...postOptions, workflowHasCaccia: undefined })).toEqual({ prUrl });
      expect(mocks.caccia).not.toHaveBeenCalled();
    });

    it('does not start automatic Caccia for a non-GitHub PR', async () => {
      mocks.createPr.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/123' });
      await postExecutionFlow(postOptions);
      expect(mocks.caccia).not.toHaveBeenCalled();
    });

    it('does not start automatic Caccia without a published PR URL', async () => {
      mocks.createPr.mockReturnValue({ success: true });
      expect(await postExecutionFlow(postOptions)).toEqual({ prUrl: undefined });
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    });

    it('resolves separate calls with different arguments before deciding suppression', async () => {
      autoMerge(mergeWorkflow([
        { name: 'first', kind: 'workflow_call', call: 'child', args: { review: 'disabled' }, personaDisplayName: 'child', instruction: '' },
        { name: 'second', kind: 'workflow_call', call: 'child', args: { review: 'enabled' }, personaDisplayName: 'child', instruction: '' },
      ]), true);
      mocks.resolveCall.mockReturnValueOnce(mergeWorkflow([agentStep])).mockReturnValueOnce(mergeWorkflow([systemStep]));
      await postExecutionFlow(postOptions);
      expect(mocks.resolveCall).toHaveBeenCalledTimes(2);
      expect(mocks.caccia).not.toHaveBeenCalled();
    });

    it('does not assume an unresolved merge child has no Caccia effect', async () => {
      autoMerge(mergeWorkflow([
        { name: 'delegate', kind: 'workflow_call', call: 'missing', personaDisplayName: 'child', instruction: '' },
      ]), true);
      mocks.resolveCall.mockReturnValue(null);
      await postExecutionFlow(postOptions);
      expect(mocks.caccia).not.toHaveBeenCalled();
    });

    it('preserves the published PR result when linked Caccia fails', async () => {
      mocks.caccia.mockRejectedValue(new Error('Caccia failed'));
      expect(await postExecutionFlow(postOptions)).toEqual({ prUrl });
      expect(mocks.caccia).toHaveBeenCalledOnce();
      expect(mocks.merge).toHaveBeenCalledOnce();
    });

    it('does not assume a merge workflow has no effect when its definition cannot be resolved', async () => {
      autoMerge(mergeWorkflow([agentStep]), true);
      mocks.loadWorkflow.mockImplementation(() => { throw new Error('Merge definition unavailable'); });
      expect(await postExecutionFlow(postOptions)).toEqual({ prUrl });
      expect(mocks.caccia).not.toHaveBeenCalled();
    });
  });
});
