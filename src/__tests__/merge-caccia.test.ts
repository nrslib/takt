vi.mock('../infra/goals/branch-sync.js', async (original) => ({ ...await original<typeof import('../infra/goals/branch-sync.js')>(), synchronizeGoalBranch: vi.fn(async () => ({ status: 'unchanged', localSha: 'a'.repeat(40) })) }));
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, mergePr: mocks.merge,
}));
vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({ assertReusableWorktreePath: vi.fn() }));

import { executePrWorkflow, executePersistedPrMergeTask, runMerge, resolveMergeSettings } from '../features/merge/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { TaskRunner } from '../infra/task/index.js';
import { TaskStore } from '../infra/task/store.js';
import { GoalStore } from '../infra/goals/store.js';
import * as goalGit from '../infra/goals/git-command.js';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import { GoalAbortMonitor, GoalAbortedError } from '../features/tasks/execute/goalAbortMonitor.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const headSha = 'a'.repeat(40);
const details = { number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha,
  headRepositoryUrl: '/head', headRepositoryPushUrls: ['/head'], sameRepository: true };

describe('Merge workflows own Caccia execution', () => {
  let project: string;
  let cloneHead: string;
  let remoteHead: string;
  beforeEach(() => {
    vi.resetAllMocks();
    project = mkdtempSync(join(tmpdir(), 'takt-merge-caccia-'));
    cloneHead = headSha;
    remoteHead = headSha;
    mocks.details.mockResolvedValue(details);
    mocks.status.mockResolvedValue({ merged: true });
    mocks.config.mockImplementation((_cwd: string, key: string) => key === 'caccia' ? { enabled: true }
      : key === 'worktreeDir' ? join(project, '.takt', 'worktrees') : false);
    mocks.clone.mockImplementation(async (_source: string, target: string) => { mkdirSync(target, { recursive: true }); });
    mocks.git.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: args[2] === 'remote.origin.url' ? '/head' : '/project' };
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: cwd === project || args[2] !== 'origin' ? '/project' : '/head' };
      }
      if (args[0] === 'remote') return { stdout: 'origin\n' };
      if (args[0] === 'symbolic-ref') return { stdout: 'feature/pr' };
      if (args[0] === 'rev-parse') {
        if (args.includes('--git-path')) return { stdout: `.git/${args.at(-1)!}` };
        if (args.at(-1) === 'MERGE_HEAD') throw new Error('MERGE_HEAD not found');
        if (args.at(-1) === 'FETCH_HEAD') return { stdout: remoteHead };
        return { stdout: cloneHead };
      }
      if (args[0] === 'merge-base') {
        const resolveRef = (ref: string) => ref === 'HEAD' ? cloneHead : ref === 'FETCH_HEAD' ? remoteHead : ref;
        const left = resolveRef(args.at(-2)!);
        const right = resolveRef(args.at(-1)!);
        return { stdout: left === right ? left : headSha };
      }
      if (args[0] === 'merge' && args.includes('--ff-only')) cloneHead = remoteHead;
      return { stdout: '' };
    });
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

  async function claimGoalMergeTask(until: 'prepare' | 'merge') {
    const prUrl = `https://github.com/org/repo/pull/${details.number}`;
    const goals = new GoalStore(project);
    await goals.create({ ...goalRecord(), branch: details.headBranch, status: 'awaiting_merge',
      pullRequest: { number: details.number, url: prUrl },
      completion: { goalBranch: details.headBranch, goalSha: headSha, targetBranch: details.baseBranch,
        summary: 'verified', instructions: [], humanChecks: 'Read the result',
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0,
          files: [], truncated: false, totalsTruncated: false } } });
    const runner = new TaskRunner(project);
    const worktreePath = join(project, 'merge-clone');
    runner.enqueuePrMergeTask({ goalId, prUrl, prNumber: details.number, headBranch: details.headBranch,
      baseBranch: details.baseBranch, headSha, headRepositoryUrl: details.headRepositoryUrl,
      headRepositoryPushUrls: details.headRepositoryPushUrls, until, workflow: 'custom-merge',
      method: 'squash', worktreePath, threatCheckMaxDiffBytes: 100_000 });
    return { goals, runner, claimed: runner.claimNextTasks(1)[0]!, worktreePath };
  }

  it.each(['prepare', 'merge'] as const)('%s 実行中にゴールを created へ戻すと中断理由を保存し clone を保持する', async (until) => {
    const { goals, runner, claimed, worktreePath } = await claimGoalMergeTask(until);
    const stop = vi.spyOn(GoalAbortMonitor.prototype, 'stop');
    const unpublished = vi.spyOn(goalGit, 'hasUnpublishedPrWork').mockResolvedValue(false);
    const cleanup = new AbortController();
    mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
      const signal = request.abortSignal!;
      signal.throwIfAborted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('System wait interrupted.')), { once: true });
      });
      return { success: true };
    });
    const settled = executePersistedPrMergeTask(claimed, runner, project, cleanup.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(mocks.workflow).toHaveBeenCalledOnce());
      const request = mocks.workflow.mock.calls[0]![0] as WorkflowExecutionRequest;
      const signal = request.abortSignal!;
      expect(request.goalId).toBe(goalId);
      expect(signal.aborted).toBe(false);
      expect(goals.getSync(goalId).status).toBe('awaiting_merge');

      await goals.update(goalId, (goal) => ({ ...goal, status: 'created' }));
      await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 3000 });
      const error = await settled;
      const saved = new TaskStore(project).read().tasks.find((task) => task.name === claimed.name)!;

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: signal.reason.name, message: signal.reason.message });
      expect(signal.reason.message).toContain('awaiting_merge');
      expect(signal.reason.message).toContain('created');
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null, worktree_path: worktreePath,
        completion: { success: false, workflowResult: 'aborted', mergeOutcome: 'unresolved' } });
      expect(saved.failure!.error).toContain(signal.reason.message);
      expect(saved.completion!.failureReason).toBe(saved.failure!.error);
      expect(existsSync(worktreePath)).toBe(true);
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(unpublished).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      cleanup.abort(new Error('Test cleanup'));
      await settled;
    }
  });

  it.each(['prepare', 'merge'] as const)('%s 実行中も awaiting_merge のままなら監視後に正常完了する', async (until) => {
    const { goals, runner, claimed } = await claimGoalMergeTask(until);
    const reads = vi.spyOn(GoalStore.prototype, 'getSync');
    vi.spyOn(goalGit, 'hasUnpublishedPrWork').mockResolvedValue(false);
    mocks.status.mockResolvedValue({ merged: until === 'merge' });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mocks.workflow.mockImplementationOnce(async () => { await pending; return { success: true }; });
    const execution = executePersistedPrMergeTask(claimed, runner, project);
    try {
      await vi.waitFor(() => expect(mocks.workflow).toHaveBeenCalledOnce());
      const signal = (mocks.workflow.mock.calls[0]![0] as WorkflowExecutionRequest).abortSignal!;
      const initialReads = reads.mock.calls.length;
      await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(initialReads), { timeout: 3000 });
      expect(goals.getSync(goalId).status).toBe('awaiting_merge');
      expect(signal.aborted).toBe(false);
      release();
      expect(await execution).toMatchObject({ success: true, merged: until === 'merge',
        outcome: until === 'merge' ? 'merged' : 'prepared' });
      expect(new TaskStore(project).read().tasks.find((task) => task.name === claimed.name))
        .toMatchObject({ status: 'completed', completion: { success: true, workflowResult: 'completed' } });
    } finally { release(); await execution; }
  });

  it.each(['completed', 'created'] as const)('マージ確定後にゴールが %s になってもタスクを正常完了として保存する', async (status) => {
    vi.useFakeTimers();
    try {
      const { goals, runner, claimed } = await claimGoalMergeTask('merge');
      vi.spyOn(goalGit, 'hasUnpublishedPrWork').mockResolvedValue(false);
      mocks.status.mockResolvedValue({ merged: false });
      mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
        expect(goals.getSync(goalId).status).toBe('awaiting_merge');
        expect(request.abortSignal!.aborted).toBe(false);
        await request.prGitOperations!.push('HEAD:refs/heads/feature/pr');
        const services = createDefaultSystemStepServices({ ...request, task: request.task });
        expect(await services.executeEffect({ type: 'merge_pr', pr: 123 }, { pr: 123 }, {} as WorkflowState))
          .toMatchObject({ success: true, failed: false });
        mocks.status.mockResolvedValue({ merged: true, headSha });
        await goals.update(goalId, (goal) => ({ ...goal, status,
          completion: { ...goal.completion!, targetSha: 'b'.repeat(40) } }));
        return { success: true };
      });

      expect(await executePersistedPrMergeTask(claimed, runner, project))
        .toMatchObject({ success: true, merged: true, outcome: 'merged',
          completion: { success: true, workflowResult: 'completed', mergeOutcome: 'merged' } });

      expect(goals.getSync(goalId).status).toBe(status);
      expect(new TaskStore(project).read().tasks.find((task) => task.name === claimed.name))
        .toMatchObject({ status: 'completed', completion: {
          success: true, workflowResult: 'completed', mergeOutcome: 'merged' } });
      expect(existsSync(claimed.worktreePath!)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('監視周期の前にゴールが戻っても完了前の確認で中断し失敗結果を保存する', async () => {
    vi.useFakeTimers();
    try {
      const { goals, runner, claimed } = await claimGoalMergeTask('merge');
      mocks.status.mockResolvedValue({ merged: false });
      mocks.workflow.mockImplementationOnce(async () => {
        await goals.update(goalId, (goal) => ({ ...goal, status: 'created' }));
        return { success: true };
      });

      await expect(executePersistedPrMergeTask(claimed, runner, project)).rejects.toThrow(/awaiting_merge/u);

      const saved = new TaskStore(project).read().tasks.find((task) => task.name === claimed.name)!;
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null,
        completion: { success: false, workflowResult: 'aborted' } });
      expect(saved.completion!.mergeOutcome).not.toBe('merged');
      expect(saved.failure!.error).toContain('created');
      expect(saved.completion!.failureReason).toBe(saved.failure!.error);
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['prepare', 'merge'] as const)('%s intent uses workflow completion and current PR state', async (until) => {
    for (const completed of [true, false]) {
      for (const merged of [true, false]) {
        mocks.status.mockResolvedValue({ merged });
        mocks.workflow.mockResolvedValue({ success: completed });
        const result = await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'custom-merge',
          until, settings: resolveMergeSettings(undefined) });
        expect(result).toMatchObject({ success: completed, merged,
          outcome: completed ? (merged ? 'merged' : 'prepared') : 'unresolved' });
        const tasks = new TaskRunner(project).listTaskStateItems();
        expect(tasks.at(-1)).toMatchObject({ status: completed ? 'completed' : 'failed',
          completion: { success: completed, workflowResult: completed ? 'completed' : 'aborted',
            mergeOutcome: result.outcome } });
      }
    }
  });

  it.each(['merge-review', '/workflows/merge-prepare.yaml'])('%s completes successfully through the merge entry without merging', async (workflow) => {
    mocks.workflow.mockResolvedValue({ success: true });
    mocks.status.mockResolvedValue({ merged: false });
    const result = await runMerge({ projectCwd: project, prNumber: 123, workflow, concurrency: 1,
      settings: resolveMergeSettings(undefined) });
    expect(result).toEqual({ exitCode: 0, processedCount: 1, mergedCount: 0, preparedCount: 1 });
    expect(mocks.workflow).toHaveBeenCalledWith(expect.objectContaining({ workflowIdentifier: workflow }));
    expect(new TaskRunner(project).listTaskStateItems()[0]).toMatchObject({ status: 'completed',
      completion: { success: true, workflowResult: 'completed', mergeOutcome: 'prepared' } });
  });

  it.each(['paused', 'aborted'] as const)('ゴールの %s でマージを止め、監視を解放して clone を保持する', async (status) => {
    mocks.workflow.mockRejectedValueOnce(new Error('initial failure'));
    await expect(run()).rejects.toThrow('initial failure');
    const prUrl = `https://github.com/org/repo/pull/${details.number}`;
    await new GoalStore(project).create({ ...goalRecord(), branch: details.headBranch,
      status: 'awaiting_merge', pullRequest: { number: details.number, url: prUrl },
      completion: { goalBranch: details.headBranch, goalSha: headSha, targetBranch: details.baseBranch,
        summary: 'verified', instructions: [], humanChecks: 'Read the result',
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0,
          files: [], truncated: false, totalsTruncated: false } } });
    const store = new TaskStore(project);
    store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, goal_id: goalId, pr_url: prUrl })) }));
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    const stop = vi.spyOn(GoalAbortMonitor.prototype, 'stop');
    const unpublished = vi.spyOn(goalGit, 'hasUnpublishedPrWork').mockResolvedValue(false);
    mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
      const signal = request.abortSignal!;
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { success: true };
    });
    const execution = executePersistedPrMergeTask(claimed, runner, project);
    const settled = execution.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(mocks.workflow).toHaveBeenCalledTimes(2));
      expect(mocks.workflow).toHaveBeenLastCalledWith(expect.objectContaining({ goalId,
        prExecutionContext: expect.objectContaining({ prUrl }) }), expect.any(Object));
      await setGoalExecutionStatus(project, goalId, status, new AbortController().signal);
      const result = await settled;
      const saved = store.read().tasks[0]!;
      if (status === 'paused') {
        expect(saved.completion).toMatchObject({ success: false, interrupted: true, workflowResult: 'aborted' });
        expect(result).toMatchObject({ success: false, merged: false, outcome: 'unresolved', completion: saved.completion, runSlug: saved.run_slug });
      } else {
        expect(result).toBeInstanceOf(GoalAbortedError);
        expect(saved.completion).toMatchObject({ success: false, mergeOutcome: 'unresolved' });
      }
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null, worktree_path: failed.worktreePath });
      expect(saved.failure!.retryable === false).toBe(status === 'aborted');
      expect(existsSync(failed.worktreePath!)).toBe(true);
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      expect(unpublished).not.toHaveBeenCalled();
      if (status === 'paused') {
        await setGoalExecutionStatus(project, goalId, 'active', new AbortController().signal);
        runner.requeueTask(claimed.name, ['failed']);
        const retried = runner.claimNextTasks(1)[0]!;
        mocks.workflow.mockResolvedValueOnce({ success: true });
        expect(await executePersistedPrMergeTask(retried, runner, project)).toMatchObject({ success: true, merged: true, outcome: 'merged' });
        expect(unpublished).toHaveBeenCalledExactlyOnceWith(failed.worktreePath, details.headBranch, undefined, undefined);
        expect(existsSync(failed.worktreePath!)).toBe(false);
        expect(stop).toHaveBeenCalledTimes(2);
      }
    } finally {
      await setGoalExecutionStatus(project, goalId, 'aborted', new AbortController().signal);
      await settled;
    }
  });

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
    mocks.workflow.mockResolvedValueOnce({ success: true });
    const save = runner.completeTask.bind(runner);
    vi.spyOn(runner, 'completeTask').mockImplementationOnce((result) => {
      runner.requestTaskStop(undefined, claimed.name, claimed.executionId!);
      return save(result);
    });
    await expect(executePersistedPrMergeTask(claimed, runner, project)).rejects.toThrow(/stopped by manager/);
    const saved = runner.listTaskStateItems().find((task) => task.name === claimed.name)!;
    expect(saved.status).toBe('failed');
    expect(saved.completion).toMatchObject({ success: false, interrupted: true, failureReason: saved.failure!.error });
  });

  it('設定が有効でも効果のないworkflowは通常のpushだけを実行する', async () => {
    expect(await run()).toMatchObject({ success: true, merged: true, outcome: 'merged' });
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
    expect(await run()).toMatchObject({ success: true, merged: true, outcome: 'merged' });
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
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toMatchObject({ success: true, merged: true, outcome: 'merged' });
    expect(mocks.workflow.mock.calls[1]?.[0].cwd).toBe(failed.worktreePath);
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.operations.push).toHaveBeenCalledOnce();
  });

  it('再開前にPR headが進んでいても取り込んで同じcloneでworkflowを実行する', async () => {
    mocks.workflow.mockRejectedValueOnce(new Error('workflow failed'));
    await expect(run()).rejects.toThrow('workflow failed');
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    remoteHead = 'c'.repeat(40);
    mocks.details.mockResolvedValue({ ...details, headSha: remoteHead });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toMatchObject({ success: true, merged: true, outcome: 'merged' });
    expect(mocks.workflow).toHaveBeenCalledTimes(2);
    expect(mocks.workflow.mock.calls[1]?.[0]).toMatchObject({ cwd: failed.worktreePath,
      prExecutionContext: { headSha: remoteHead } });
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it.each(['manual', 'caccia'] as const)('pushの生成元%sでも先行したcloneを保持して再試行する', async (source) => {
    mocks.workflow.mockRejectedValueOnce(new Error('workflow failed'));
    await expect(run()).rejects.toThrow();
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    const localHead = 'b'.repeat(40);
    runner.recordPrMergePushedHead(failed.name, localHead, headSha, source);
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    cloneHead = localHead;
    mocks.workflow.mockClear().mockResolvedValue({ success: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toMatchObject({ success: true, merged: true, outcome: 'merged' });
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.workflow.mock.calls[0]?.[0]).toMatchObject({ cwd: failed.worktreePath,
      prExecutionContext: { headSha: localHead } });
  });
});
