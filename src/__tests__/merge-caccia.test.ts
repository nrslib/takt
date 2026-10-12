import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({ assertReusableWorktreePath: vi.fn() }));

import { executePrWorkflow, executePersistedPrMergeTask, resolveMergeSettings } from '../features/merge/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { TaskRunner } from '../infra/task/index.js';

const initialSha = 'a'.repeat(40);
const updatedSha = 'b'.repeat(40);
const laterSha = 'c'.repeat(40);
const details = {
  number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: initialSha,
  headRepositoryUrl: '/head', headRepositoryPushUrls: ['/head'], sameRepository: true,
};

describe('Merge and Caccia handoff', () => {
  const fetchPrDetails = vi.fn();
  const fetchPrStatus = vi.fn();
  let projectDir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-merge-caccia-'));
    mocks.provider.mockReturnValue({
      checkCliStatus: () => ({ available: true }), fetchPrDetails, fetchPrStatus,
      commentOnPr: vi.fn(() => ({ success: true })),
      mergePr: mocks.mergePr,
    });
    mocks.execFileSync.mockReturnValue(`${updatedSha}\n`);
    fetchPrDetails.mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValue({ ...details, headSha: updatedSha });
    fetchPrStatus.mockResolvedValue({ merged: true });
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true }
      : key === 'worktreeDir' ? join(projectDir, '.takt', 'worktrees') : false);
    mocks.clone.mockImplementation(async (_source: string, target: string) => {
      mkdirSync(target, { recursive: true });
    });
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? updatedSha
              : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse' && call[1][1] === 'HEAD').length <= 2
                ? initialSha : updatedSha)
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
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  const run = () => executePrWorkflow({
    projectCwd: projectDir, prNumber: 123, workflow: 'custom-merge',
    settings: resolveMergeSettings(undefined),
  });

  it('push後にCacciaの完了を待ち最新headへcloneを進める', async () => {
    expect(await run()).toEqual({ merged: true });
    expect(mocks.operations.push).toHaveBeenCalledWith('HEAD:refs/heads/feature/pr');
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({
      entry: 'linked', prNumber: 123, projectCwd: projectDir, expectedInitialHeadSha: initialSha,
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

  it('CodeRabbit活動なしの判定をpush失敗後の再開でも保持する', async () => {
    let cloneHead = initialSha;
    let remoteHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = remoteHead;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? remoteHead
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    mocks.operations.push.mockRejectedValueOnce(new Error('network failure'))
      .mockImplementation(async () => { remoteHead = cloneHead; });
    mocks.reviewStatus.mockResolvedValue({ headSha: initialSha, hasCodeRabbitPost: false, reviewedHeadShas: [] });
    mocks.commitActivity.mockResolvedValue({ headSha: initialSha, detected: false });
    mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'no_coderabbit_activity', headSha: updatedSha });
    mocks.workflow.mockReset()
      .mockImplementationOnce(async (options: { prGitOperations: PrGitOperations }) => {
        cloneHead = updatedSha;
        await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
        return { success: true };
      })
      .mockResolvedValue({ success: true });

    await expect(run()).rejects.toThrow('network failure');
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_pushed_head_sha: updatedSha,
      merge_skip_caccia_if_no_activity: true });

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({
      expectedInitialHeadSha: updatedSha,
      skipIfNoCodeRabbitActivity: true,
    }));
  });

  it('Cacciaが未完了なら後続のhead同期を許可しない', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'limit', unresolvedCount: 1 });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    expect(mocks.operations.fetch).toHaveBeenCalledTimes(2);
    expect(fetchPrDetails).toHaveBeenCalledTimes(2);
  });

  it('CodeRabbitの初回投稿がない場合は確認済みheadを保持して再開時にmergeする', async () => {
    let cloneHead = initialSha;
    let remoteHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = remoteHead;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? remoteHead
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    mocks.operations.push.mockImplementation(async () => { remoteHead = cloneHead; });
    mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'initial_review_unavailable' });
    fetchPrStatus.mockResolvedValueOnce({ merged: false }).mockResolvedValue({ merged: true });
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      cloneHead = updatedSha;
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
      return { success: true };
    });

    expect(await run()).toEqual({ merged: false });
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_caccia_skipped_head_sha: updatedSha });
    expect(failed.data?.merge_caccia_approved_head_sha).toBeUndefined();
    expect(mocks.operations.fetch).toHaveBeenCalledWith('origin', 'refs/heads/feature/pr');
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(true);

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
      return { success: true };
    });
    expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledOnce();
  });

  it('初回レビュー不在を記録した後の新しいpushでその許可を消す', async () => {
    let cloneHead = initialSha;
    let remoteHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = remoteHead;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? remoteHead
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    mocks.operations.push.mockImplementation(async () => { remoteHead = cloneHead; });
    mocks.caccia.mockResolvedValueOnce({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'initial_review_unavailable' })
      .mockResolvedValueOnce({ outcome: 'limit', unresolvedCount: 1 });
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      cloneHead = updatedSha;
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
      cloneHead = laterSha;
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      return { success: true };
    });

    await expect(run()).rejects.toThrow('Caccia did not complete');
    const failed = new TaskRunner(projectDir).listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_pushed_head_sha: laterSha });
    expect(failed.data?.merge_caccia_skipped_head_sha).toBeUndefined();
    expect(failed.data?.merge_caccia_approved_head_sha).toBeUndefined();
  });

  it('Caccia修正後のレビュー制限ではそのpushのheadだけを引き継ぐ', async () => {
    let cloneHead = initialSha;
    let remoteHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = remoteHead;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? remoteHead
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    mocks.operations.push.mockImplementation(async () => { remoteHead = cloneHead; });
    mocks.caccia.mockImplementation(async (input: { onPushedHead: (sha: string) => void }) => {
      remoteHead = laterSha;
      input.onPushedHead(laterSha);
      return { outcome: 'skipped', unresolvedCount: 0, skipReason: 'review_rate_limited', headSha: laterSha };
    });
    fetchPrStatus.mockResolvedValueOnce({ merged: false }).mockResolvedValue({ merged: true });
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      cloneHead = updatedSha;
      await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      expect(() => options.prGitOperations.assertMergeAllowed?.(laterSha)).not.toThrow();
      return { success: true };
    });

    expect(await run()).toEqual({ merged: false });
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_pushed_head_sha: laterSha,
      merge_caccia_skipped_head_sha: laterSha });
    expect(mocks.operations.fetch).toHaveBeenCalledWith('origin', 'refs/heads/feature/pr');

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      expect(() => options.prGitOperations.assertMergeAllowed?.(laterSha)).not.toThrow();
      return { success: true };
    });
    expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledOnce();
  });

  it('初回レビュー不在以外のCacciaスキップはmergeを許可しない', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      reason: 'GitHub is not the configured or detected provider' });
    await expect(run()).rejects.toThrow('Caccia did not complete');
  });

  it('CodeRabbit初回投稿なしでも外部headへ変わったPRは採用しない', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'initial_review_unavailable' });
    fetchPrDetails.mockReset().mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValue({ ...details, headSha: laterSha });
    await expect(run()).rejects.toThrow('Pull request head changed after Caccia review');
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(false);
  });

  it('レビュー制限でスキップしてもCaccia後に外部headへ変われば拒否する', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'review_rate_limited', headSha: updatedSha });
    fetchPrDetails.mockReset().mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValue({ ...details, headSha: laterSha });
    await expect(run()).rejects.toThrow('Pull request head changed after Caccia review');
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(false);
    expect(mocks.mergePr).not.toHaveBeenCalled();
  });

  it('Caccia確認後の外部pushを引き継がず停止する', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: initialSha });
    await expect(run()).rejects.toThrow('Pull request head changed after Caccia review');
    expect(mocks.operations.fetch).toHaveBeenCalledTimes(2);
  });

  it('取得したFETCH_HEADが確認済みSHAと違うときはcloneをfast-forwardしない', async () => {
    let cloneHead = initialSha;
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = laterSha;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? laterSha
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    await expect(run()).rejects.toThrow('Pull request head changed during Caccia synchronization');
    expect(cloneHead).toBe(initialSha);
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(false);
    expect(mocks.mergePr).not.toHaveBeenCalled();
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
        error: expect.stringContaining('PR merge is blocked until Caccia completes the pushed head handoff') });
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
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: false }
      : key === 'worktreeDir' ? join(projectDir, '.takt', 'worktrees') : false);
    expect(await run()).toEqual({ merged: true });
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.operations.push).toHaveBeenCalledOnce();
  });

  it('再開時に未承認pushを再待機し、保存した承認headだけでmergeを許す', async () => {
    fetchPrDetails.mockReset().mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValueOnce(details).mockResolvedValue({ ...details, headSha: updatedSha });
    mocks.caccia.mockResolvedValueOnce({ outcome: 'limit', unresolvedCount: 1 })
      .mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: updatedSha });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_caccia_required: true, merge_pushed_head_sha: initialSha });
    expect(failed.data?.merge_caccia_approved_head_sha).toBeUndefined();

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? updatedSha
              : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse' && call[1][1] === 'HEAD').length <= 3
                ? initialSha : updatedSha)
              : '/project',
    }));
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
      return { success: true };
    });
    expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledTimes(2);
    expect(mocks.caccia.mock.calls[1]?.[0]).toMatchObject({ expectedInitialHeadSha: initialSha });
    expect(runner.listAllTaskItems().find((task) => task.name === failed.name)?.kind).toBe('completed');
  });

  it.each(['limit', 'review-timeout', 'resolve-thread-error'] as const)(
    'Caccia自身のpush後に%sで停止しても保存したheadだけを同期して再開する', async (failure) => {
      let cloneHead = initialSha;
      let remoteHead = initialSha;
      const localPushedSha = 'd'.repeat(40);
      fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
      mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
        if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = remoteHead;
        return { stdout: args[0] === 'remote' && args[1] === 'get-url'
          ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
          : args[0] === 'remote' ? 'origin\n'
            : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? remoteHead
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
      });
      mocks.caccia.mockReset().mockImplementationOnce(async (input: { onPushedHead: (sha: string) => void }) => {
        remoteHead = updatedSha;
        input.onPushedHead(updatedSha);
        if (failure !== 'limit') throw new Error(failure);
        return { outcome: 'limit', unresolvedCount: 1, headSha: updatedSha };
      }).mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: updatedSha });
      mocks.workflow.mockImplementationOnce(async (options: { prGitOperations: PrGitOperations }) => {
        cloneHead = localPushedSha;
        await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
        return { success: true };
      });
      await expect(run()).rejects.toThrow(failure === 'limit' ? 'Caccia did not complete' : failure);
      const runner = new TaskRunner(projectDir);
      const failed = runner.listFailedTasks()[0]!;
      expect(failed.data).toMatchObject({ merge_pushed_head_sha: updatedSha,
        merge_push_base_head_sha: localPushedSha, merge_caccia_approved_head_sha: undefined });
      expect(cloneHead).toBe(localPushedSha);

      runner.requeueTask(failed.name, ['failed']);
      const claimed = runner.claimNextTasks(1)[0]!;
      mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
        expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
        return { success: true };
      });
      expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
      expect(cloneHead).toBe(updatedSha);
      expect(mocks.caccia.mock.calls[1]?.[0]).toMatchObject({ expectedInitialHeadSha: updatedSha });
      expect(mocks.operations.push).toHaveBeenCalledOnce();
    });

  it('Caccia停止後に外部headへ進んだPRは再開時に採用しない', async () => {
    let remoteHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.caccia.mockReset().mockImplementationOnce(async (input: { onPushedHead: (sha: string) => void }) => {
      remoteHead = updatedSha;
      input.onPushedHead(updatedSha);
      return { outcome: 'limit', unresolvedCount: 1, headSha: updatedSha };
    });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    remoteHead = laterSha;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    await expect(executePersistedPrMergeTask(claimed, runner, projectDir))
      .rejects.toThrow('PR head changed since clone preparation');
    expect(mocks.caccia).toHaveBeenCalledOnce();
  });

  it('再開時にFETCH_HEADが保存した自己SHAと違えばcloneを進めない', async () => {
    let remoteHead = initialSha;
    let cloneHead = initialSha;
    fetchPrDetails.mockReset().mockImplementation(async () => ({ ...details, headSha: remoteHead }));
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') cloneHead = laterSha;
      return { stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? laterSha
              : args[0] === 'rev-parse' ? cloneHead : '/project' };
    });
    mocks.caccia.mockReset().mockImplementationOnce(async (input: { onPushedHead: (sha: string) => void }) => {
      remoteHead = updatedSha;
      input.onPushedHead(updatedSha);
      return { outcome: 'limit', unresolvedCount: 1, headSha: updatedSha };
    });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    await expect(executePersistedPrMergeTask(claimed, runner, projectDir))
      .rejects.toThrow('Pull request head changed during pending Caccia synchronization');
    expect(cloneHead).toBe(initialSha);
    expect(mocks.git.mock.calls.some((call) => call[1].join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(false);
    expect(mocks.caccia).toHaveBeenCalledOnce();
  });

  it('push失敗後はリモートが旧headのときだけ同じcommitを再pushしてCacciaを待つ', async () => {
    fetchPrDetails.mockReset().mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValueOnce(details).mockResolvedValue({ ...details, headSha: updatedSha });
    mocks.operations.push.mockRejectedValueOnce(new Error('network failure')).mockResolvedValue(undefined);
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD' ? updatedSha
              : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse' && call[1][1] === 'HEAD').length === 1
                ? initialSha : updatedSha)
              : '/project',
    }));
    await expect(run()).rejects.toThrow('network failure');
    const runner = new TaskRunner(projectDir);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_pushed_head_sha: updatedSha,
      merge_caccia_approved_head_sha: undefined });
    expect(mocks.caccia).not.toHaveBeenCalled();

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      expect(() => options.prGitOperations.assertMergeAllowed?.(updatedSha)).not.toThrow();
      return { success: true };
    });
    expect(await executePersistedPrMergeTask(claimed, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.operations.push).toHaveBeenCalledTimes(2);
    expect(mocks.operations.push).toHaveBeenLastCalledWith('HEAD:refs/heads/feature/pr');
    expect(mocks.caccia).toHaveBeenCalledOnce();
    expect(mocks.caccia).toHaveBeenCalledWith(expect.objectContaining({ expectedInitialHeadSha: updatedSha }));
  });

  it('AからBを承認後にBからCのpushが失敗しても保存したBからだけCを再送する', async () => {
    fetchPrDetails.mockReset()
      .mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValueOnce({ ...details, headSha: updatedSha })
      .mockResolvedValueOnce({ ...details, headSha: updatedSha })
      .mockResolvedValueOnce({ ...details, headSha: updatedSha })
      .mockResolvedValue({ ...details, headSha: laterSha });
    fetchPrStatus.mockResolvedValueOnce({ merged: false }).mockResolvedValue({ merged: true });
    mocks.operations.push.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network failure')).mockResolvedValue(undefined);
    mocks.caccia.mockResolvedValueOnce({ outcome: 'success', unresolvedCount: 0, headSha: updatedSha })
      .mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: laterSha });
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD'
              ? (mocks.caccia.mock.calls.length >= 2 ? laterSha : updatedSha)
              : args[0] === 'rev-parse'
              ? (() => { const count = mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse' && call[1][1] === 'HEAD').length;
                return count === 1 ? initialSha : count <= 4 ? updatedSha : laterSha; })()
              : '/project',
    }));
    mocks.workflow.mockImplementation(async (options: { prGitOperations: PrGitOperations }) => {
      const call = mocks.workflow.mock.calls.length;
      if (call <= 2) await options.prGitOperations.push('HEAD:refs/heads/feature/pr');
      else expect(() => options.prGitOperations.assertMergeAllowed?.(laterSha)).not.toThrow();
      return { success: true };
    });
    expect(await run()).toEqual({ merged: false });
    const runner = new TaskRunner(projectDir);
    const first = runner.listFailedTasks()[0]!;
    expect(first.data).toMatchObject({ merge_pushed_head_sha: updatedSha,
      merge_caccia_approved_head_sha: updatedSha });
    runner.requeueTask(first.name, ['failed']);
    const second = runner.claimNextTasks(1)[0]!;
    await expect(executePersistedPrMergeTask(second, runner, projectDir)).rejects.toThrow('network failure');
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data).toMatchObject({ merge_pushed_head_sha: laterSha,
      merge_push_base_head_sha: updatedSha });
    runner.requeueTask(failed.name, ['failed']);
    const third = runner.claimNextTasks(1)[0]!;
    expect(await executePersistedPrMergeTask(third, runner, projectDir)).toEqual({ merged: true });
    expect(mocks.operations.push).toHaveBeenCalledTimes(3);
    expect(mocks.caccia).toHaveBeenCalledTimes(2);
    expect(mocks.caccia.mock.calls[1]?.[0]).toMatchObject({ expectedInitialHeadSha: laterSha });
  });
});
