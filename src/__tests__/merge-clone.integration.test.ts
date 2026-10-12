import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowExecutionRequest } from '../features/tasks/execute/workflowExecutionApi.js';

const mocks = vi.hoisted(() => ({ details: vi.fn(), status: vi.fn(), workflow: vi.fn(), logError: vi.fn(), agent: vi.fn(), comment: vi.fn() }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({ checkCliStatus: () => ({ available: true }),
    fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, commentOnPr: mocks.comment }),
}));
vi.mock('../infra/github/pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), fetchPrDetails: mocks.details, fetchPrStatus: mocks.status,
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: mocks.workflow }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));

import { runMerge, resolveMergeSettings, runLinkedMergeSafely, executePrWorkflow,
  executePersistedPrMergeTask } from '../features/merge/index.js';
import { TaskRunner } from '../infra/task/index.js';
import { prepareFailedTaskRetry } from '../features/tasks/taskRetryPreparation.js';
import { persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';
import * as cloneExec from '../infra/task/clone-exec.js';
import * as threatCheck from '../features/merge/threat-check.js';
import { createCheckoutFilter } from './helpers/checkout-filter.js';

describe('Merge PR persistent clone ownership', () => {
  let root: string;
  let project: string;
  let fork: string;
  let prHead: string;
  let baseHead: string;
  let executedCwd: string | undefined;
  let reportPath: string;
  function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.agent.mockResolvedValue({ status: 'done', structuredOutput: { suspicious: false, reason: 'safe', files: [] } });
    mocks.comment.mockReturnValue({ success: true });
    executedCwd = undefined;
    root = mkdtempSync(join(tmpdir(), 'takt-merge-clone-'));
    project = join(root, 'project');
    fork = join(root, 'fork.git');
    git(root, 'init', '--initial-branch=main', project);
    git(project, 'config', 'user.name', 'Merge Test');
    git(project, 'config', 'user.email', 'merge@example.com');
    writeFileSync(join(project, 'code.txt'), 'base\n');
    git(project, 'add', 'code.txt');
    git(project, 'commit', '-m', 'base');
    baseHead = git(project, 'rev-parse', 'HEAD');
    git(root, 'clone', '--bare', project, fork);
    const author = join(root, 'author');
    git(root, 'clone', fork, author);
    git(author, 'config', 'user.name', 'PR Author');
    git(author, 'config', 'user.email', 'author@example.com');
    git(author, 'checkout', '-b', 'feature/pr');
    writeFileSync(join(author, 'code.txt'), 'PR head\n');
    git(author, 'add', 'code.txt');
    git(author, 'commit', '-m', 'PR change');
    writeFileSync(join(author, 'second.txt'), 'Second PR change\n');
    git(author, 'add', 'second.txt');
    git(author, 'commit', '-m', 'second PR change');
    git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    prHead = git(author, 'rev-parse', 'HEAD');
    reportPath = join(project, '.takt', 'runs', 'merge-test', 'reports', 'review.md');
    mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: false });
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false });
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      executedCwd = request.cwd;
      expect(request.cwd).not.toBe(project);
      expect(request.projectCwd).toBe(project);
      expect(request.workflowIdentifier).toBe('merge-review');
      expect(git(request.cwd, 'rev-parse', 'HEAD')).toBe(prHead);
      expect(git(request.cwd, 'branch', '--show-current')).toBe('feature/pr');
      expect(git(request.cwd, 'remote', 'get-url', 'origin')).toBe(fork);
      expect(request.prContext).toMatchObject({ prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main' });
      expect(request.prContext?.baseDiffRef).toBeDefined();
      expect(request.prContext?.headDiffRef).toBeDefined();
      const changedFiles = git(request.cwd, 'diff', '--name-only',
        `${request.prContext!.baseDiffRef}...${request.prContext!.headDiffRef}`).split('\n').sort();
      expect(changedFiles).toEqual(['code.txt', 'second.txt']);
      expect(request.runPathsDirectory).toBe(join(project, '.takt', 'runs'));
      mkdirSync(join(project, '.takt', 'runs', 'merge-test', 'reports'), { recursive: true });
      writeFileSync(reportPath, 'Review completed\n');
      return { success: true, reportDirectory: join(project, '.takt', 'runs', 'merge-test', 'reports') };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function run() {
    return runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: 'merge-review' }) });
  }
  it('forkのheadを専用cloneで実行し未マージ時はcloneを保持する', async () => {
    const result = await run();
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(executedCwd).toBeDefined();
    expect(existsSync(executedCwd!)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toBe('Review completed\n');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('base\n');
    expect(result).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.status).toHaveBeenCalled();
  });

  it('workflow例外後もcloneとrootのreportを保持する', async () => {
    const execute = mocks.workflow.getMockImplementation()!;
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      await execute(request);
      throw new Error('review failed');
    });
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(executedCwd).toBeDefined();
    expect(existsSync(executedCwd!)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
  });

  it('workflow成功だけではなくPRの実際のmerged状態を集計する', async () => {
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 1, exitCode: 0 });
    expect(existsSync(executedCwd!)).toBe(false);
  });

  it('未マージのcloneとタスクを保存し、再開後にPRがマージされた場合だけ削除する', async () => {
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data?.merge_task).toBe(true);
    expect(failed.worktreePath).toBe(executedCwd);
    expect(existsSync(failed.worktreePath!)).toBe(true);
    await expect(executePrWorkflow({ projectCwd: project, prNumber: 123,
      workflow: 'merge-review', settings: resolveMergeSettings(undefined) }))
      .rejects.toThrow('already has merge task');

    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    expect(claimed.resumeMode).toBe('requeue');
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toEqual({ merged: true });
    expect(existsSync(executedCwd!)).toBe(false);
    const completed = runner.listAllTaskItems().find((task) => task.name === failed.name);
    expect(completed).toMatchObject({ kind: 'completed' });
    expect(completed?.worktreePath).toBeUndefined();
  });

  it('clone準備中断後は変更のない未完成cloneだけを作り直して再開する', async () => {
    const clone = cloneExec.cloneAndIsolateAbortable;
    const interrupted = vi.spyOn(cloneExec, 'cloneAndIsolateAbortable').mockImplementationOnce(async (...args) => {
      await clone(...args);
      throw new Error('clone preparation interrupted');
    });
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    interrupted.mockRestore();
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data?.merge_clone_prepared).toBe(false);
    expect(existsSync(failed.worktreePath!)).toBe(true);
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toEqual({ merged: true });
    expect(existsSync(failed.worktreePath!)).toBe(false);
  });

  it('clone作成前の失敗でもlist用の再試行準備とRequeueから再開できる', async () => {
    const workflowDir = join(project, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\n');
    writeFileSync(join(workflowDir, 'merge-review.yaml'),
      'name: merge-review\ninitial_step: review\nmax_steps: 1\nsteps:\n  - name: review\n    instruction: "{task}"\n');
    const interrupted = vi.spyOn(cloneExec, 'cloneAndIsolateAbortable')
      .mockRejectedValueOnce(new Error('clone unavailable'));
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    interrupted.mockRestore();
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data?.merge_clone_prepared).toBe(false);
    expect(existsSync(failed.worktreePath!)).toBe(false);
    const preparation = prepareFailedTaskRetry(failed, project);
    expect(preparation).toMatchObject({ interactionCwd: project, runsBaseDir: project,
      worktreePath: failed.worktreePath });
    await persistFailedTaskRetry({ task: failed, projectDir: project, worktreePath: failed.worktreePath!,
      startStep: undefined, retryNote: undefined, resumePoint: undefined, workflow: undefined,
      taskDir: undefined, sourceRunSlug: preparation.matchedRunSlug, restartPoint: undefined });
    const claimed = runner.claimNextTasks(1)[0]!;
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toEqual({ merged: true });
  });

  it('別forkの同名head branchは許可し同番号PRと同repoの同名branchは拒否する', () => {
    const runner = new TaskRunner(project);
    const start = (number: number, repository: string) => runner.startPrMergeTask({
      prNumber: number, headBranch: 'main', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: repository, headRepositoryPushUrls: [repository],
      workflow: 'merge-review', method: 'squash', worktreePath: join(root, `clone-${number}-${repository.length}`),
      threatCheckMaxDiffBytes: 1000, cacciaRequired: false,
    });
    start(123, '/fork-one');
    expect(() => start(124, '/fork-two')).not.toThrow();
    expect(() => start(123, '/fork-three')).toThrow('already has merge task');
    expect(() => start(125, '/fork-one')).toThrow('Active task target already exists');
  });

  it('未完成cloneに利用者の変更がある場合は再作成せず保持する', async () => {
    const clone = cloneExec.cloneAndIsolateAbortable;
    const interrupted = vi.spyOn(cloneExec, 'cloneAndIsolateAbortable').mockImplementationOnce(async (...args) => {
      await clone(...args);
      throw new Error('clone preparation interrupted');
    });
    expect(await run()).toMatchObject({ exitCode: 1 });
    interrupted.mockRestore();
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    const localFile = join(failed.worktreePath!, 'local-note.txt');
    writeFileSync(localFile, 'keep this\n');
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    await expect(executePersistedPrMergeTask(claimed, runner, project))
      .rejects.toThrow('Incomplete PR merge clone has local changes');
    expect(readFileSync(localFile, 'utf8')).toBe('keep this\n');
  });

  it('同じbranchの実行中タスクからの自動起動だけを許可する', async () => {
    const runner = new TaskRunner(project);
    const parent = runner.addTask('Build feature', { branch: 'feature/pr', worktree: true });
    runner.claimNextTasks(1);
    await expect(executePrWorkflow({ projectCwd: project, prNumber: 123,
      workflow: 'merge-review', settings: resolveMergeSettings(undefined) }))
      .rejects.toThrow('Active task target already exists');
    expect(await executePrWorkflow({ projectCwd: project, prNumber: 123,
      workflow: 'merge-review', settings: resolveMergeSettings(undefined), parentTaskName: parent.name }))
      .toEqual({ merged: false });
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(runner.listFailedTasks().some((task) => task.data?.merge_task === true)).toBe(true);
  });

  it('相対workflow pathを元リポジトリから解決してclone実行へ渡す', async () => {
    mocks.workflow.mockResolvedValue({ success: true });
    await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './custom-merge.yaml' }) });
    expect(mocks.workflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowIdentifier: join(project, 'custom-merge.yaml'), projectCwd: project,
    }));
    const request = mocks.workflow.mock.calls[0]?.[0] as WorkflowExecutionRequest;
    expect(existsSync(request.cwd)).toBe(true);
  });

  it('最終状態取得の期限切れでは失敗を集計してcloneとreportを保持する', async () => {
    mocks.status.mockRejectedValue(new PrStatusTimeoutError());
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.status).toHaveBeenCalledWith(123, project, { signal: undefined });
    expect(existsSync(executedCwd!)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
  });

  it('最終状態取得中の外部abortを伝播してcloneを保持する', async () => {
    const controller = new AbortController();
    mocks.status.mockImplementation((_number, _cwd, options: { signal: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        controller.abort();
      });
    });
    expect(await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: 'merge-review' }), abortSignal: controller.signal }))
      .toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(existsSync(executedCwd!)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
  });

  it.each([
    ['smudge', false], ['smudge', true], ['process', false], ['process', true],
  ] as const)('PR checkoutは%s filterを許可設定%sでも実行しない', async (kind, allowGitFilters) => {
    const author = join(root, 'author');
    writeFileSync(join(author, '.gitattributes'), 'code.txt filter=probe\n');
    git(author, 'add', '.gitattributes');
    git(author, 'commit', '-m', 'PR filter attribute');
    git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    prHead = git(author, 'rev-parse', 'HEAD');
    const probe = createCheckoutFilter(root, kind);
    vi.stubEnv('GIT_CONFIG_GLOBAL', probe.configPath);
    const control = join(root, 'control');
    git(root, 'clone', '--no-checkout', fork, control);
    git(control, 'checkout', 'feature/pr');
    expect(existsSync(probe.markerPath)).toBe(true);
    rmSync(probe.markerPath);
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt/config.yaml'), `allow_git_filters: ${allowGitFilters}\n`);
    mocks.details.mockResolvedValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: false });
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      executedCwd = request.cwd;
      expect(git(request.cwd, 'rev-parse', 'HEAD')).toBe(prHead);
      expect(readFileSync(join(request.cwd, 'code.txt'), 'utf8')).toBe('PR head\n');
      expect(existsSync(probe.markerPath)).toBe(false);
      return { success: true };
    });
    await run();
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(existsSync(probe.markerPath)).toBe(false);
    expect(existsSync(executedCwd!)).toBe(true);
  });

  it('自動起動設定を省略した場合はPRがあってもworkflowを起動しない', async () => {
    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123');
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.details).not.toHaveBeenCalled();
  });

  it('caccia無効でもmerge自動起動設定が有効なら同じPRのworkflowを起動する', async () => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'merge:\n  auto_start: true\n  workflow: merge-review\ncaccia:\n  enabled: false\n');
    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123');
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.details.mock.calls[0]?.[0]).toBe(123);
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(existsSync(executedCwd!)).toBe(true);
  });

  it.each(['terminal', 'silent'] as const)('自動mergeの子workflowへ親の%s表示設定を引き継ぐ', async (outputMode) => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'merge:\n  auto_start: true\n  workflow: merge-review\n');
    const display = { outputMode, taskPrefix: 'parent-task', taskColorIndex: 2, taskDisplayLabel: 'parent-label' };

    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123', undefined, display);

    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.workflow.mock.calls[0]?.[0]).toMatchObject(display);
    expect(existsSync(executedCwd!)).toBe(true);
  });

  function observeClone(configure?: (cwd: string) => void) {
    const paths: string[] = [];
    const clone = cloneExec.cloneAndIsolateAbortable;
    vi.spyOn(cloneExec, 'cloneAndIsolateAbortable').mockImplementation(async (...args) => {
      paths.push(args[1]);
      await clone(...args);
      configure?.(args[1]);
    });
    return paths;
  }

  it.each(['reject', 'error', 'safe'] as const)('脅威判定の%s時に中断したらコメント・本体・状態取得を開始せずcloneを保持する', async (outcome) => {
    const paths = observeClone();
    const controller = new AbortController();
    const reason = new Error('cancelled during threat check');
    mocks.agent.mockImplementation(async (_persona, _instruction, options: { abortSignal: AbortSignal }) => {
      expect(options.abortSignal).toBe(controller.signal);
      controller.abort(reason);
      if (outcome === 'reject') throw new Error('provider failed');
      return { status: outcome === 'error' ? 'error' : 'done', structuredOutput: {
        suspicious: false, reason: 'safe', files: [] } };
    });
    await expect(executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'merge-review',
      settings: resolveMergeSettings(undefined), abortSignal: controller.signal })).rejects.toBe(reason);
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it.each(['reject', 'error'] as const)('未中断の脅威判定%sは確認コメントを投稿してcloneを保持する', async (outcome) => {
    const paths = observeClone();
    if (outcome === 'reject') mocks.agent.mockRejectedValue(new Error('provider failed'));
    else mocks.agent.mockResolvedValue({ status: 'error' });
    expect(await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'merge-review',
      settings: resolveMergeSettings(undefined), abortSignal: new AbortController().signal })).toEqual({ merged: false });
    expect(mocks.comment).toHaveBeenCalledOnce();
    expect(mocks.comment.mock.calls[0]?.[1]).toContain('人間による確認');
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it.each([[true, true], [false, true], [true, false], [false, false]])(
    'helperのpassed=%s・中断=%sをコメントと本体の開始前に確認する', async (passed, aborted) => {
      const paths = observeClone();
      const controller = new AbortController();
      const reason = new Error('cancelled after helper');
      vi.spyOn(threatCheck, 'checkForkThreats').mockImplementation(() => {
        const result = Promise.resolve(passed ? { passed: true as const } : { passed: false as const, comment: 'review required' });
        if (aborted) queueMicrotask(() => controller.abort(reason));
        return result;
      });
      const running = executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'merge-review',
        settings: resolveMergeSettings(undefined), abortSignal: controller.signal });
      if (aborted) await expect(running).rejects.toBe(reason);
      else expect(await running).toEqual({ merged: false });
      expect(mocks.comment).toHaveBeenCalledTimes(!aborted && !passed ? 1 : 0);
      expect(mocks.workflow).toHaveBeenCalledTimes(!aborted && passed ? 1 : 0);
      expect(mocks.status).toHaveBeenCalledTimes(!aborted && passed ? 1 : 0);
      expect(paths).toHaveLength(1);
      expect(existsSync(paths[0]!)).toBe(true);
    });

  it('自動起動の脅威判定中断でも追加コメントと本体を開始せず未マージを記録する', async () => {
    const paths = observeClone();
    const controller = new AbortController();
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'merge:\n  auto_start: true\n  workflow: merge-review\n');
    mocks.agent.mockImplementation(async () => {
      controller.abort(new Error('cancelled linked merge'));
      return { status: 'error' };
    });
    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123', controller.signal);
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith('Linked merge workflow left the PR unmerged', expect.any(Object));
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it('番号指定のforkで累積指示・CI変更をコメントし本体開始前にcloneを保持する', async () => {
    const author = join(root, 'author');
    for (const file of ['CLAUDE.md', '.github/workflows/test.yml']) {
      mkdirSync(join(author, file, '..'), { recursive: true });
      writeFileSync(join(author, file), 'untrusted instructions\n');
      git(author, 'add', file); git(author, 'commit', '-m', `add ${file}`);
    }
    git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    prHead = git(author, 'rev-parse', 'HEAD');
    mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: false });
    const paths = observeClone();
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.comment).toHaveBeenCalledOnce();
    const [number, comment, cwd] = mocks.comment.mock.calls[0]!;
    expect(number).toBe(123); expect(cwd).toBe(project);
    expect(comment).toContain('CLAUDE.md'); expect(comment).toContain('.github/workflows/test.yml');
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.workflow).not.toHaveBeenCalled();
    expect(paths).toHaveLength(1); expect(existsSync(paths[0]!)).toBe(true);
  });

  it('実cloneのcore.sshCommandキーを検出し二層目と本体を呼ばない', async () => {
    const paths = observeClone((cwd) => git(cwd, 'config', 'core.sshCommand', 'ssh'));
    await run();
    expect(mocks.comment.mock.calls[0]?.[1]).toMatch(/core\.sshcommand/iu);
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.workflow).not.toHaveBeenCalled();
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it('同一repositoryはfork検査を省略してcloneで本体を実行する', async () => {
    mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: true });
    await run();
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.workflow).toHaveBeenCalledOnce(); expect(existsSync(executedCwd!)).toBe(true);
  });

  it.each(['suspicious', 'invalid', 'overflow'])('%sのforkを未マージとして集計し理由を投稿する', async (kind) => {
    const paths = observeClone();
    if (kind === 'suspicious') mocks.agent.mockResolvedValue({ status: 'done', structuredOutput: {
      suspicious: true, reason: '認証情報を送信する', files: ['code.txt'] } });
    if (kind === 'invalid') mocks.agent.mockResolvedValue({ status: 'done', content: '安全です' });
    expect(await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: 'merge-review', threatCheckMaxDiffBytes: kind === 'overflow' ? 1 : 200_000 }) }))
      .toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.comment.mock.calls[0]?.[1]).toContain(kind === 'suspicious' ? '認証情報を送信する' : '人間による確認');
    expect(mocks.agent).toHaveBeenCalledTimes(kind === 'overflow' ? 0 : 1);
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it('一括のforkコメント失敗後も同一repositoryのPRを実行して集計する', async () => {
    const paths = observeClone();
    mocks.agent.mockResolvedValue({ status: 'done', structuredOutput: { suspicious: true, reason: '危険な変更', files: ['code.txt'] } });
    mocks.comment.mockReturnValue({ success: false, error: 'comment denied' });
    mocks.details.mockImplementation((number: number) => ({ number, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: number === 456 }));
    mocks.status.mockResolvedValue({ merged: true });
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      expect(request.prContext?.prNumber).toBe(456);
      expect(request.cwd).not.toBe(project);
      expect(git(request.cwd, 'rev-parse', 'HEAD')).toBe(prHead);
      return { success: true };
    });
    const result = await runMerge({ projectCwd: project, concurrency: 1,
      includeForks: true, settings: resolveMergeSettings({ workflow: 'merge-review' }) }, {
      listOpenPrNumbers: () => [123, 456],
      fetchPrListItem: (number) => ({ number, author: 'author', labels: [], base_branch: 'main',
        head_branch: 'feature/pr', managed_by_takt: false, same_repository: number === 456, draft: false, updated_at: '' }),
      executePrWorkflow,
    });
    expect(result).toMatchObject({ processedCount: 2, mergedCount: 1, exitCode: 1 });
    expect(mocks.agent).toHaveBeenCalledOnce(); expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith('PR merge workflow failed', expect.objectContaining({ prNumber: 123, error: 'comment denied' }));
    expect(paths).toHaveLength(2); expect(existsSync(paths[0]!)).toBe(true); expect(existsSync(paths[1]!)).toBe(false);
  });

});
