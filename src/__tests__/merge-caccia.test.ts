import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrGitOperations } from '../core/workflow/system/pr-execution-context.js';
import type { WorkflowState } from '../core/models/types.js';

const mocks = vi.hoisted(() => ({
  provider: vi.fn(), mergePr: vi.fn(), execFileSync: vi.fn(), config: vi.fn(), clone: vi.fn(), git: vi.fn(), operations: {
    fetch: vi.fn(), push: vi.fn(),
  }, workflow: vi.fn(), caccia: vi.fn(), threat: vi.fn(),
  reviewStatus: vi.fn(), commitActivity: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: (...args: unknown[]) => mocks.execFileSync(...args),
}));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<Record<string, unknown>>(), resolveConfigValue: mocks.config,
}));
vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolateAbortable: mocks.clone, runGitCommandAbortable: mocks.git,
}));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({
  createPrCloneGitOperations: vi.fn(async () => ({
    headRepositoryUrl: '/head', headRepositoryPushUrls: ['/head'], baseRepositoryUrl: '/project',
    operations: mocks.operations,
  })),
}));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: mocks.workflow }));
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<Record<string, unknown>>(), runCaccia: mocks.caccia,
}));
vi.mock('../features/merge/threat-check.js', () => ({ checkForkThreats: mocks.threat }));
vi.mock('../infra/github/pr.js', () => ({
  fetchCodeRabbitReviewStatus: mocks.reviewStatus,
  fetchCodeRabbitCommitActivity: mocks.commitActivity,
}));

import { executePrWorkflow, resolveMergeSettings } from '../features/merge/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

const initialSha = 'a'.repeat(40);
const updatedSha = 'b'.repeat(40);
const details = {
  number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: initialSha,
  headRepositoryUrl: '/head', headRepositoryPushUrls: ['/head'], sameRepository: true,
};

describe('Merge and Caccia handoff', () => {
  const fetchPrDetails = vi.fn();
  const fetchPrStatus = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.provider.mockReturnValue({
      checkCliStatus: () => ({ available: true }), fetchPrDetails, fetchPrStatus,
      commentOnPr: vi.fn(() => ({ success: true })),
      mergePr: mocks.mergePr,
    });
    mocks.execFileSync.mockReturnValue(`${updatedSha}\n`);
    fetchPrDetails.mockResolvedValueOnce(details).mockResolvedValue({ ...details, headSha: updatedSha });
    fetchPrStatus.mockResolvedValue({ merged: true });
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true } : false);
    mocks.git.mockImplementation(async (_cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' ? 'origin\n' : args[0] === 'rev-parse'
        ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse').length <= 2 ? initialSha : updatedSha)
        : '/project',
    }));
    mocks.caccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: updatedSha });
    mocks.reviewStatus.mockResolvedValue({
      headSha: initialSha, hasCodeRabbitPost: true, reviewedHeadShas: [initialSha],
    });
    mocks.commitActivity.mockResolvedValue({ headSha: initialSha, detected: true });
    mocks.threat.mockResolvedValue({ passed: true });
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      return { success: true };
    });
  });

  const run = () => executePrWorkflow({
    projectCwd: '/project', prNumber: 123, workflow: 'custom-merge',
    settings: resolveMergeSettings(undefined),
  });

  it('push後にCacciaの完了を待ち最新headへcloneを進める', async () => {
    expect(await run()).toEqual({ merged: true });
    expect(mocks.operations.push).toHaveBeenCalledWith('HEAD:refs/heads/feature/pr');
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({
      entry: 'linked', prNumber: 123, projectCwd: '/project', expectedInitialHeadSha: initialSha,
    }));
    expect(mocks.operations.fetch).toHaveBeenCalledWith('origin', 'refs/heads/feature/pr');
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(true);
  });

  it('活動がpush前後にないPRではCaccia待機を省略し、実際のmerge_prまで進む', async () => {
    mocks.reviewStatus.mockResolvedValue({ headSha: initialSha, hasCodeRabbitPost: false, reviewedHeadShas: [] });
    mocks.commitActivity.mockResolvedValue({ headSha: initialSha, detected: false });
    mocks.caccia.mockResolvedValue({
      outcome: 'skipped', skipReason: 'no_coderabbit_activity', unresolvedCount: 0, headSha: initialSha,
    });
    fetchPrDetails.mockReset().mockResolvedValue({ ...details, headSha: initialSha });
    mocks.git.mockImplementation(async (_cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' ? 'origin\n' : args[0] === 'rev-parse' ? initialSha : '/project',
    }));
    mocks.execFileSync.mockReturnValue(`${initialSha}\n`);
    mocks.mergePr.mockReturnValue({ success: true });
    mocks.workflow.mockImplementation(async (options: {
      cwd: string; projectCwd: string; prGitOperations: PrGitOperations;
      prExecutionContext: typeof details;
    }) => {
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      const services = createDefaultSystemStepServices({
        cwd: options.cwd, projectCwd: options.projectCwd, task: 'merge PR',
        prExecutionContext: { ...options.prExecutionContext, prNumber: 123 },
        prGitOperations: options.prGitOperations,
      });
      expect(await services.executeEffect({ type: 'merge_pr', pr: 123 }, { pr: 123 }, {} as WorkflowState))
        .toMatchObject({ success: true });
      return { success: true };
    });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ skipIfNoCodeRabbitActivity: true }));
    expect(mocks.mergePr).toHaveBeenCalledWith(123, '/project', undefined, initialSha);
  });

  it('旧headのstatusがある場合は新headでのCaccia待機を省略させない', async () => {
    mocks.reviewStatus.mockResolvedValue({ headSha: initialSha, hasCodeRabbitPost: false, reviewedHeadShas: [] });
    mocks.commitActivity.mockResolvedValue({ headSha: initialSha, detected: true });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ skipIfNoCodeRabbitActivity: false }));
  });

  it('完了扱いにならない旧レビューも活動として待機を維持する', async () => {
    mocks.reviewStatus.mockResolvedValue({
      headSha: initialSha, hasCodeRabbitPost: false,
      hasCodeRabbitReviewActivity: true, reviewedHeadShas: [],
    });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.commitActivity).not.toHaveBeenCalled();
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ skipIfNoCodeRabbitActivity: false }));
  });

  it('人のスレッドに対する旧headのCodeRabbit返信があれば待機を維持する', async () => {
    mocks.reviewStatus.mockResolvedValue({
      headSha: initialSha, hasCodeRabbitPost: false,
      hasCodeRabbitThreadReplyActivity: true, reviewedHeadShas: [],
    });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.commitActivity).not.toHaveBeenCalled();
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ skipIfNoCodeRabbitActivity: false }));
  });

  it('push前の活動取得が不明なら待機省略を承認しない', async () => {
    mocks.reviewStatus.mockResolvedValue(undefined);
    mocks.caccia.mockResolvedValue({
      outcome: 'skipped', skipReason: 'no_coderabbit_activity', unresolvedCount: 0, headSha: initialSha,
    });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ skipIfNoCodeRabbitActivity: false }));
  });

  it('push前のAPI失敗ではpushもmergeも進めない', async () => {
    mocks.reviewStatus.mockRejectedValue(new Error('API failed'));
    await expect(run()).rejects.toThrow('API failed');
    expect(mocks.operations.push).not.toHaveBeenCalled();
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it('push前の中断ではpushもmergeも進めない', async () => {
    mocks.reviewStatus.mockRejectedValue(new Error('Caccia was aborted'));
    await expect(run()).rejects.toThrow('Caccia was aborted');
    expect(mocks.operations.push).not.toHaveBeenCalled();
    expect(mocks.mergePr).not.toHaveBeenCalled();
  });

  it.each(['CodeRabbit did not post within the wait limit', 'GitHub is not the configured or detected provider'])(
    '通常のskip理由「%s」ではmergeを許可しない', async (reason) => {
      mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0, reason });
      await expect(run()).rejects.toThrow('Caccia did not complete');
      expect(mocks.mergePr).not.toHaveBeenCalled();
    },
  );

  it('活動不在skipでもhead SHAが欠ければmergeを拒否する', async () => {
    mocks.reviewStatus.mockResolvedValue({ headSha: initialSha, hasCodeRabbitPost: false, reviewedHeadShas: [] });
    mocks.commitActivity.mockResolvedValue({ headSha: initialSha, detected: false });
    mocks.caccia.mockResolvedValue({
      outcome: 'skipped', skipReason: 'no_coderabbit_activity', unresolvedCount: 0,
    });
    await expect(run()).rejects.toThrow('Pull request head changed after Caccia review');
  });

  it('Cacciaが未完了なら後続のhead同期を許可しない', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'limit', unresolvedCount: 1 });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    expect(mocks.operations.fetch).toHaveBeenCalledTimes(2);
    expect(fetchPrDetails).toHaveBeenCalledTimes(1);
  });

  it('Caccia確認後の外部pushを引き継がず停止する', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: initialSha });
    await expect(run()).rejects.toThrow('Pull request head changed after Caccia review');
    expect(mocks.operations.fetch).toHaveBeenCalledTimes(2);
  });

  it('Caccia失敗をworkflowが飲み込んでもmerge承認を与えない', async () => {
    mocks.caccia.mockRejectedValue(new Error('review failed'));
    mocks.workflow.mockImplementation(async (options: {
      cwd: string; projectCwd: string; prGitOperations: PrGitOperations;
      prExecutionContext: typeof details;
    }) => {
      await expect(options.prGitOperations.push('HEAD:refs/heads/feature/pr')).rejects.toThrow('review failed');
      const assertMergeAllowed = vi.fn((headSha: string) => options.prGitOperations.assertMergeAllowed?.(headSha));
      const services = createDefaultSystemStepServices({
        cwd: options.cwd, projectCwd: options.projectCwd, task: 'merge PR',
        prExecutionContext: { ...options.prExecutionContext, prNumber: 123 },
        prGitOperations: { ...options.prGitOperations, assertMergeAllowed },
      });
      const result = await services.executeEffect({ type: 'merge_pr', pr: 123 }, { pr: 123 }, {} as WorkflowState);
      expect(result).toMatchObject({ success: false, failed: true,
        error: expect.stringContaining('PR merge is blocked until Caccia approves the pushed head') });
      expect(assertMergeAllowed).toHaveBeenCalledWith(updatedSha);
      return { success: false };
    });
    fetchPrStatus.mockResolvedValue({ merged: false });
    expect(await run()).toEqual({ merged: false });
    expect(mocks.execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'],
      expect.objectContaining({ encoding: 'utf8' }));
    expect(mocks.execFileSync).toHaveReturnedWith(`${updatedSha}\n`);
    expect(mocks.mergePr).not.toHaveBeenCalled();
  });

  it('pushしないcustom workflowのmergeはCaccia待ちを要求しない', async () => {
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      expect(() => options.prGitOperations.assertMergeAllowed?.(initialSha)).not.toThrow();
      return { success: true };
    });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it('Cacciaが無効ならpushをそのまま実行する', async () => {
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: false } : false);
    expect(await run()).toEqual({ merged: true });
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.operations.push).toHaveBeenCalledOnce();
  });
});
