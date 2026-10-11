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
            : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse').length <= 2 ? initialSha : updatedSha)
              : '/project',
    }));
    mocks.caccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0, headSha: updatedSha });
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

  it('Cacciaが未完了なら後続のhead同期を許可しない', async () => {
    mocks.caccia.mockResolvedValue({ outcome: 'limit', unresolvedCount: 1 });
    await expect(run()).rejects.toThrow('Caccia did not complete');
    expect(mocks.operations.fetch).toHaveBeenCalledTimes(2);
    expect(fetchPrDetails).toHaveBeenCalledTimes(2);
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
            : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse').length <= 3 ? initialSha : updatedSha)
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

  it('push失敗後はリモートが旧headのときだけ同じcommitを再pushしてCacciaを待つ', async () => {
    fetchPrDetails.mockReset().mockResolvedValueOnce(details).mockResolvedValueOnce(details)
      .mockResolvedValueOnce(details).mockResolvedValue({ ...details, headSha: updatedSha });
    mocks.operations.push.mockRejectedValueOnce(new Error('network failure')).mockResolvedValue(undefined);
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({
      stdout: args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === projectDir ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n'
          : args[0] === 'symbolic-ref' ? 'feature/pr'
            : args[0] === 'rev-parse'
              ? (mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse').length === 1
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
            : args[0] === 'rev-parse'
              ? (() => { const count = mocks.git.mock.calls.filter((call) => call[1][0] === 'rev-parse').length;
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
