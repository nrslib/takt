import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import type { WorkflowExecutionRequest } from '../features/tasks/execute/workflowExecutionApi.js';

const mocks = vi.hoisted(() => ({
  details: vi.fn(), status: vi.fn(), merge: vi.fn(), config: vi.fn(), clone: vi.fn(), git: vi.fn(),
  operations: { fetch: vi.fn(), push: vi.fn() }, workflow: vi.fn(), caccia: vi.fn(),
  reviewStatus: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(() => 'a'.repeat(40)),
}));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: () => ({
  checkCliStatus: () => ({ available: true }), fetchPrDetails: mocks.details, fetchPrStatus: mocks.status,
  commentOnPr: vi.fn(() => ({ success: true })), mergePr: mocks.merge,
}) }));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(), resolveConfigValue: mocks.config,
}));
vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolateAbortable: mocks.clone, runGitCommandAbortable: mocks.git,
}));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({
  createPrCloneGitOperations: vi.fn(async () => ({ headRepositoryUrl: '/head',
    headRepositoryPushUrls: ['/head'], baseRepositoryUrl: '/project', operations: mocks.operations })),
}));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: mocks.workflow }));
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<typeof import('../features/caccia/index.js')>(), runCaccia: mocks.caccia,
}));
vi.mock('../infra/github/pr.js', () => ({
  fetchCodeRabbitReviewStatus: mocks.reviewStatus,
}));
vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({ assertReusableWorktreePath: vi.fn() }));

import { executePrWorkflow, executePersistedPrMergeTask, resolveMergeSettings } from '../features/merge/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { TaskRunner } from '../infra/task/index.js';

const headSha = 'a'.repeat(40);
const details = { number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha,
  headRepositoryUrl: '/head', headRepositoryPushUrls: ['/head'], sameRepository: true };

describe('Merge workflows own Caccia execution', () => {
  let project: string;
  beforeEach(() => {
    vi.resetAllMocks();
    project = mkdtempSync(join(tmpdir(), 'takt-merge-caccia-'));
    mocks.details.mockResolvedValue(details);
    mocks.status.mockResolvedValue({ merged: true });
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true }
      : key === 'worktreeDir' ? join(project, '.takt', 'worktrees') : false);
    mocks.clone.mockImplementation(async (_source: string, target: string) => { mkdirSync(target, { recursive: true }); });
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => ({ stdout:
      args[0] === 'config' && args[1] === '--get'
        ? args[2] === 'remote.origin.url' ? '/head' : '/project'
        : args[0] === 'remote' && args[1] === 'get-url'
        ? cwd === project ? '/project' : args[2] === 'origin' ? '/head' : '/project'
        : args[0] === 'remote' ? 'origin\n' : args[0] === 'symbolic-ref' ? 'feature/pr'
          : args[0] === 'rev-parse' ? headSha : '/project' }));
    mocks.reviewStatus.mockResolvedValue({ headSha, hasCodeRabbitPost: true, reviewedHeadShas: [headSha] });
    mocks.caccia.mockResolvedValue({ outcome: 'success', headSha, unresolvedCount: 0 });
    mocks.merge.mockReturnValue({ success: true });
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      await request.prGitOperations!.push('HEAD:refs/heads/feature/pr');
      return { success: true };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(project, { recursive: true, force: true }); });

  const run = () => executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'custom-merge',
    settings: resolveMergeSettings(undefined) });

  it('再キューされたマージ実行は停止を検知し、処理終了を待って停止理由付きで保存する', async () => {
    mocks.workflow.mockRejectedValueOnce(new Error('initial failure'));
    await expect(run()).rejects.toThrow('initial failure');
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mocks.workflow.mockImplementationOnce(async () => { await pending; return { success: true }; });
    const execution = executePersistedPrMergeTask(claimed, runner, project);
    const settled = execution.then(() => undefined, (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(mocks.workflow).toHaveBeenCalledTimes(2));
      const signal = mocks.workflow.mock.calls[1]![0].abortSignal as AbortSignal;
      expect(signal.aborted).toBe(false);
      runner.requestTaskStop(undefined, claimed.name, claimed.executionId!);
      await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 3000 });
      expect(runner.listAllTaskItems().find((task) => task.name === claimed.name)!.kind).toBe('running');
      release();
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      const saved = runner.listTaskStateItems().find((task) => task.name === claimed.name)!;
      expect(saved).toMatchObject({ status: 'failed', ownerPid: undefined,
        completion: { success: false, interrupted: true, workflowResult: 'aborted' } });
      expect(saved.failure!.error).toContain('stopped by manager');
      expect(saved.completion!.failureReason).toBe(saved.failure!.error);
      expect((error as Error).message).toBe(saved.failure!.error);
    } finally { release(); await settled; }
  });

  it.each([true, false])('マージ終端保存直前の停止を同じ停止理由で保存する (merged=%s)', async (merged) => {
    mocks.workflow.mockRejectedValueOnce(new Error('initial failure'));
    await expect(run()).rejects.toThrow('initial failure');
    const runner = new TaskRunner(project);
    runner.requeueTask(runner.listFailedTasks()[0]!.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.workflow.mockResolvedValue({ success: true });
    mocks.status.mockResolvedValue({ merged });
    const method = merged ? 'completeTask' : 'failTask';
    const save = runner[method].bind(runner);
    vi.spyOn(runner, method).mockImplementationOnce((result) => {
      runner.requestTaskStop(undefined, claimed.name, claimed.executionId!);
      return save(result);
    });
    await expect(executePersistedPrMergeTask(claimed, runner, project)).rejects.toThrow(/stopped by manager/);
    const saved = runner.listTaskStateItems().find((task) => task.name === claimed.name)!;
    expect(saved.status).toBe('failed');
    expect(saved.completion).toMatchObject({ success: false, interrupted: true, failureReason: saved.failure!.error });
  });

  it('設定が有効でも効果のないworkflowは通常のpushだけを実行する', async () => {
    expect(await run()).toEqual({ merged: true });
    expect(mocks.operations.push).toHaveBeenCalledExactlyOnceWith('HEAD:refs/heads/feature/pr');
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.reviewStatus).not.toHaveBeenCalled();
  });

  it('効果のないworkflowはpush後にcloneのexpected SHAでmergeする', async () => {
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      await request.prGitOperations!.push('HEAD:refs/heads/feature/pr');
      const services = createDefaultSystemStepServices({ ...request, task: request.task });
      expect(await services.executeEffect({ type: 'merge_pr', pr: 123 }, { pr: 123 }, {} as WorkflowState))
        .toMatchObject({ success: true, failed: false });
      return { success: true };
    });
    expect(await run()).toEqual({ merged: true });
    expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(123, project, 'squash', headSha);
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it('失敗したworkflowの再開では専用のCaccia待機を追加せず同じcloneを使う', async () => {
    mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
      await request.prGitOperations!.push('HEAD:refs/heads/feature/pr');
      throw new Error('workflow failed after push');
    });
    await expect(run()).rejects.toThrow('workflow failed after push');
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.workflow.mockResolvedValue({ success: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toEqual({ merged: true });
    expect(mocks.workflow.mock.calls[1]?.[0].cwd).toBe(failed.worktreePath);
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.operations.push).toHaveBeenCalledOnce();
  });

  it('再開前にPR headが外部変更された場合はworkflowを実行しない', async () => {
    mocks.workflow.mockRejectedValueOnce(new Error('workflow failed'));
    await expect(run()).rejects.toThrow('workflow failed');
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.details.mockResolvedValue({ ...details, headSha: 'c'.repeat(40) });
    await expect(executePersistedPrMergeTask(claimed, runner, project)).rejects.toThrow();
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it.each(['manual', 'caccia'] as const)('同じ送信前の状態でもpushの生成元%sで再試行を分ける', async (source) => {
    mocks.workflow.mockRejectedValueOnce(new Error('workflow failed'));
    await expect(run()).rejects.toThrow();
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    const localHead = 'b'.repeat(40);
    runner.recordPrMergePushedHead(failed.name, localHead, headSha, source);
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    const git = mocks.git.getMockImplementation()!;
    mocks.git.mockImplementation(async (cwd, args) => args.join(' ') === 'rev-parse HEAD'
      ? { stdout: localHead } : git(cwd, args));
    mocks.workflow.mockClear().mockResolvedValue({ success: true });
    const result = executePersistedPrMergeTask(claimed, runner, project);
    if (source === 'manual') {
      expect(await result).toEqual({ merged: true });
      expect(mocks.workflow).toHaveBeenCalledOnce();
      expect(mocks.workflow.mock.calls[0]?.[0].cwd).toBe(failed.worktreePath);
    } else {
      await expect(result).rejects.toThrow();
      expect(mocks.workflow).not.toHaveBeenCalled();
    }
  });
});
