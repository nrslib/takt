import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowExecutionRequest } from '../features/tasks/execute/workflowExecutionApi.js';
import type { WorkflowExecutionEvent } from '../features/tasks/execute/types.js';
import type { WorkflowResumePoint } from '../core/models/workflow-types.js';
import type { runSyncConflictResolver } from '../infra/service/runSyncConflictResolver.js';

const mocks = vi.hoisted(() => ({ details: vi.fn(), status: vi.fn(), workflow: vi.fn(), logError: vi.fn(), agent: vi.fn(), comment: vi.fn(), resolver: vi.fn() }));
vi.mock('../infra/service/runSyncConflictResolver.js', () => ({ runSyncConflictResolver: mocks.resolver }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({ checkCliStatus: () => ({ available: true }),
    fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, commentOnPr: mocks.comment }),
}));
vi.mock('../infra/github/pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), fetchPrDetails: mocks.details, fetchPrStatus: mocks.status,
}));
vi.mock('../infra/github/issue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/github/issue.js')>()),
  checkGhCli: () => ({ available: true }),
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));
vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
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
import { runAgent } from '../agents/runner.js';
import { issueTellableRunningTask } from '../features/tasks/liveIntervention.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { stageTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { executeRunTaskAndCompleteWithDetails } from '../features/tasks/execute/runTaskExecution.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

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
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    git(root, 'init', '--initial-branch=main', project);
    git(project, 'config', 'user.name', 'Merge Test');
    git(project, 'config', 'user.email', 'merge@example.com');
    writeFileSync(join(project, 'code.txt'), 'base\n');
    git(project, 'add', 'code.txt');
    git(project, 'commit', '-m', 'base');
    baseHead = git(project, 'rev-parse', 'HEAD');
    git(root, 'config', '--file', gitConfig, `url.file://${project}.insteadOf`, 'git@github.com:org/repo.git');
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function run() {
    return runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: 'merge-review' }) });
  }

  describe('requeued merge preparation', () => {
    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: [{ workflow: 'merge-review', workflow_ref: 'merge-review', step: 'review',
        kind: 'agent', occurrence: 2, step_iterations: { sync: 1, resolve_conflicts: 1, review: 2 } }],
      iteration: 7, elapsed_ms: 1234,
      workflow_call_invocations: {}, workflow_step_participations: {},
    };

    function commitFile(cwd: string, path: string, content: string): string {
      writeFileSync(join(cwd, path), content);
      git(cwd, 'add', '--', path);
      git(cwd, 'commit', '-m', `update ${path}`);
      return git(cwd, 'rev-parse', 'HEAD');
    }

    function advancePr(path: string, content: string): void {
      const author = join(root, 'author');
      const head = commitFile(author, path, content);
      git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
      prHead = head;
      mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: head,
        headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: false });
    }

    function useSameRepository(): void {
      const details = mocks.details.getMockImplementation()!();
      mocks.details.mockReturnValue({ ...details, sameRepository: true });
    }

    async function prepareRetry(editClone: (cwd: string, request: WorkflowExecutionRequest) => void) {
      const execute = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
        await execute(request);
        editClone(request.cwd, request);
        throw new Error('review interrupted before push');
      });
      expect(await run()).toMatchObject({ exitCode: 1 });
      const runner = new TaskRunner(project);
      const failed = runner.listFailedTasks()[0]!;
      expect(failed.failure?.error).toBe('review interrupted before push');
      expect(failed.data?.merge_clone_prepared).toBe(true);
      const clone = failed.worktreePath!;
      const localHead = git(clone, 'rev-parse', 'HEAD');
      expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(prHead);
      runner.requeueTask(failed.name, ['failed'], { resumePoint });
      const claimed = runner.claimNextTasks(1)[0]!;
      expect(claimed.name).toBe(failed.name);
      expect(claimed.worktreePath).toBe(clone);
      expect(claimed.data?.resume_point).toEqual(resumePoint);
      mocks.workflow.mockClear().mockImplementation(async (request: WorkflowExecutionRequest) => {
        expect(request.cwd).toBe(clone);
        expect(request.resumePoint).toEqual(claimed.data!.resume_point);
        expect(request.startStep).toBeUndefined();
        expect(git(clone, 'merge-base', localHead, 'HEAD')).toBe(localHead);
        expect(git(clone, 'merge-base', prHead, 'HEAD')).toBe(prHead);
        expect(request.prExecutionContext?.headSha).toBe(git(clone, 'rev-parse', 'HEAD'));
        expect(git(clone, 'ls-files', '-u')).toBe('');
        expect(existsSync(join(clone, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(prHead);
        return { success: true };
      });
      mocks.status.mockResolvedValue({ merged: true });
      mocks.resolver.mockReset();
      return { runner, claimed, clone, localHead };
    }

    function retry(context: Awaited<ReturnType<typeof prepareRetry>>) {
      return executeRunTaskAndCompleteWithDetails(context.claimed, context.runner, project,
        undefined, { outputMode: 'silent' });
    }

    async function expectContinued(context: Awaited<ReturnType<typeof prepareRetry>>) {
      expect(await retry(context)).toEqual({ success: true });
      expect(mocks.workflow).toHaveBeenCalledOnce();
      expect(context.runner.listAllTaskItems().find((task) => task.name === context.claimed.name)?.kind)
        .toBe('completed');
      expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(prHead);
    }

    async function expectPreparationFailed(context: Awaited<ReturnType<typeof prepareRetry>>) {
      const result = await retry(context);
      expect(result.success).toBe(false);
      expect(result.failureReason).toEqual(expect.any(String));
      expect(mocks.workflow).not.toHaveBeenCalled();
      const failed = context.runner.listFailedTasks().find((task) => task.name === context.claimed.name)!;
      expect(failed.worktreePath).toBe(context.clone);
      expect(failed.failure?.error).toBe(result.failureReason);
      expect(existsSync(context.clone)).toBe(true);
      expect(git(context.clone, 'rev-parse', 'HEAD')).toBe(context.localHead);
      expect(git(context.clone, 'ls-files', '-u')).toBe('');
      expect(existsSync(join(context.clone, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(prHead);
    }

    function resolveConflict(options: Parameters<typeof runSyncConflictResolver>[0]) {
      expect(options.projectCwd).toBe(project);
      expect(options.cwd).not.toBe(project);
      expect(options.abortSignal?.aborted).toBe(false);
      expect(git(options.cwd, 'ls-files', '-u')).toContain('code.txt');
      expect(existsSync(join(options.cwd, '.git', 'MERGE_HEAD'))).toBe(true);
      writeFileSync(join(options.cwd, 'code.txt'), 'local resolution and remote change\n');
      return { persona: 'conflict-resolver', status: 'done', content: 'resolved', timestamp: new Date() };
    }

    it('同じheadなら同じcloneと保存済みの再開位置から継続する', async () => {
      const context = await prepareRetry(() => {});
      await expectContinued(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('未pushのマージコミットを保持し保存済みの再開位置から継続する', async () => {
      const context = await prepareRetry((cwd, request) => {
        request.prMergePushRecorder!.record(prHead, baseHead, request.prExecutionContext!);
        commitFile(project, 'base-work.txt', 'previous base work\n');
        git(cwd, 'fetch', 'base', 'refs/heads/main');
        git(cwd, 'merge', '--no-ff', '--no-edit', 'FETCH_HEAD');
        expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
      });
      const execute = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
        expect(git(request.cwd, 'rev-parse', 'HEAD')).toBe(context.localHead);
        expect(readFileSync(join(request.cwd, 'base-work.txt'), 'utf8')).toBe('previous base work\n');
        return execute(request);
      });
      await expectContinued(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('PR側だけが進んだ場合は最新headへfast-forwardして継続する', async () => {
      const context = await prepareRetry(() => {});
      advancePr('remote-only.txt', 'new remote work\n');
      const execute = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
        expect(git(request.cwd, 'rev-parse', 'HEAD')).toBe(prHead);
        expect(readFileSync(join(request.cwd, 'remote-only.txt'), 'utf8')).toBe('new remote work\n');
        return execute(request);
      });
      await expectContinued(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('分岐したPR headを取り込み双方のコミットと内容を保持する', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'local-only.txt', 'unpushed local work\n'); });
      advancePr('remote-only.txt', 'new remote work\n');
      commitFile(project, 'later-base.txt', 'base work after the interrupted run\n');
      git(context.clone, 'config', 'merge.ff', 'only');
      const execute = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
        expect(readFileSync(join(request.cwd, 'local-only.txt'), 'utf8')).toBe('unpushed local work\n');
        expect(readFileSync(join(request.cwd, 'remote-only.txt'), 'utf8')).toBe('new remote work\n');
        expect(existsSync(join(request.cwd, 'later-base.txt'))).toBe(false);
        return execute(request);
      });
      await expectContinued(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('分岐したheadの衝突をAIが編集した後に検証してマージを完了する', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'code.txt', 'local resolution\n'); });
      advancePr('code.txt', 'remote change\n');
      useSameRepository();
      mocks.resolver.mockImplementation(resolveConflict);
      const execute = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
        expect(readFileSync(join(request.cwd, 'code.txt'), 'utf8')).toBe('local resolution and remote change\n');
        return execute(request);
      });
      await expectContinued(context);
      expect(mocks.resolver).toHaveBeenCalledOnce();
      expect(mocks.resolver.mock.calls[0]![0]).toMatchObject({ cwd: context.clone, projectCwd: project,
        abortSignal: mocks.workflow.mock.calls[0]![0].abortSignal });
    });

    it.each(['error response', 'exception', 'unresolved markers'] as const)(
      'AIの%sではworkflowを開始せず失敗を保存し今回のマージを中止する', async (failure) => {
        const context = await prepareRetry((cwd) => { commitFile(cwd, 'code.txt', 'local resolution\n'); });
        advancePr('code.txt', 'remote change\n');
        useSameRepository();
        mocks.resolver.mockImplementation((options: Parameters<typeof runSyncConflictResolver>[0]) => {
          expect(git(options.cwd, 'ls-files', '-u')).toContain('code.txt');
          if (failure === 'exception') throw new Error('resolver unavailable');
          return { persona: 'conflict-resolver', status: failure === 'error response' ? 'error' : 'done',
            content: '', error: failure === 'error response' ? 'resolver failed' : undefined, timestamp: new Date() };
        });
        await expectPreparationFailed(context);
        expect(mocks.resolver).toHaveBeenCalledOnce();
        expect(readFileSync(join(context.clone, 'code.txt'), 'utf8')).toBe('local resolution\n');
      });

    it('メタデータ取得後にPR headが動いたらfetch結果を拒否する', async () => {
      const context = await prepareRetry(() => {});
      const snapshot = mocks.details.getMockImplementation()!;
      mocks.details.mockImplementationOnce(() => {
        const details = snapshot();
        advancePr('remote-only.txt', 'head moved during fetch\n');
        return details;
      });
      await expectPreparationFailed(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('AI解消中にPR headがさらに動いたらworkflowを開始しない', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'code.txt', 'local resolution\n'); });
      advancePr('code.txt', 'remote change\n');
      useSameRepository();
      mocks.resolver.mockImplementation((options: Parameters<typeof runSyncConflictResolver>[0]) => {
        const response = resolveConflict(options);
        advancePr('later.txt', 'head moved during AI resolution\n');
        return response;
      });
      const result = await retry(context);
      expect(mocks.resolver).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ success: false, failureReason: expect.any(String) });
      expect(mocks.workflow).not.toHaveBeenCalled();
      expect(context.runner.listFailedTasks().find((task) => task.name === context.claimed.name)?.failure?.error)
        .toBe(result.failureReason);
      expect(git(context.clone, 'merge-base', context.localHead, 'HEAD')).toBe(context.localHead);
      expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(prHead);
    });

    it('forkの衝突はAI解消前に停止してマージを中止する', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'code.txt', 'local resolution\n'); });
      advancePr('code.txt', 'remote change\n');
      await expectPreparationFailed(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('force-pushで削除されたremote履歴を再導入せず停止する', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'local-only.txt', 'local work\n'); });
      const author = join(root, 'author');
      git(author, 'reset', '--hard', baseHead);
      prHead = commitFile(author, 'replacement.txt', 'replacement\n');
      git(author, 'push', '--force', 'origin', 'HEAD:refs/heads/feature/pr');
      mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
        headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: false });
      await expectPreparationFailed(context);
      expect(mocks.resolver).not.toHaveBeenCalled();
    });

    it('取り込んだforkの変更を脅威検査し拒否時はworkflowを開始しない', async () => {
      const context = await prepareRetry((cwd) => { commitFile(cwd, 'local-only.txt', 'unpushed local work\n'); });
      advancePr('remote-only.txt', 'new remote work\n');
      const check = vi.spyOn(threatCheck, 'checkForkThreats').mockImplementation(async (options) => {
        expect(options.cwd).toBe(context.clone);
        expect(git(options.cwd, 'merge-base', prHead, 'HEAD')).toBe(prHead);
        expect(git(options.cwd, 'merge-base', context.localHead, 'HEAD')).toBe(context.localHead);
        return { passed: false, comment: 'review required' };
      });
      expect(await retry(context)).toEqual({ success: false });
      expect(check).toHaveBeenCalledOnce();
      expect(mocks.workflow).not.toHaveBeenCalled();
      expect(mocks.comment).toHaveBeenCalledOnce();
      expect(context.runner.listFailedTasks().some((task) => task.name === context.claimed.name)).toBe(true);
    });

    it.each(['PR number', 'head branch', 'clone branch', 'origin remote', 'base remote'] as const)(
      '%sが別の識別情報なら同期とworkflowを開始しない', async (identity) => {
        const context = await prepareRetry(() => {});
        if (identity === 'PR number' || identity === 'head branch') {
          const details = mocks.details.getMockImplementation()!();
          mocks.details.mockReturnValue({ ...details,
            ...(identity === 'PR number' ? { number: 456 } : { headBranch: 'other/pr' }) });
        } else if (identity === 'clone branch') {
          git(context.clone, 'checkout', '-b', 'other/pr');
        } else {
          git(context.clone, 'remote', 'set-url', identity === 'origin remote' ? 'origin' : 'base', join(root, 'other.git'));
        }
        const fetch = vi.spyOn(cloneExec, 'runGitCommandAbortable');
        await expectPreparationFailed(context);
        expect(fetch.mock.calls.filter(([, args]) => args[0] === 'fetch')).toEqual([]);
        expect(mocks.resolver).not.toHaveBeenCalled();
      });
    });

  it.each(['Requeue', 'Retry'])('%sでもCLIの実行並列数から決まる取り込み直し上限を設定変更後まで保持する', async (mode) => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nmerge:\n  concurrency: 2\n');
    const execute = mocks.workflow.getMockImplementation()!;
    const limits: unknown[] = [];
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      const config = normalizeWorkflowConfig({ name: 'sync-observation', initial_step: 'sync', steps: [
        { name: 'sync', mode: 'system', effects: [{ type: 'sync_with_root', pr: 123 }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ] }, project);
      const state = createInitialState(config, { provider: 'mock', projectCwd: project });
      state.stepIterations.set('sync', 1);
      const service = createDefaultSystemStepServices({ cwd: request.cwd, projectCwd: project, task: request.task,
        prExecutionContext: request.prExecutionContext, prGitOperations: request.prGitOperations });
      const result = await service.executeEffect({ type: 'sync_with_root', pr: 123 }, { pr: 123 }, state);
      expect(result).toMatchObject({ success: true, failed: false });
      limits.push(result.resyncLimit);
      return execute(request);
    });
    await runMerge({ projectCwd: project, prNumber: 123, concurrency: 5,
      settings: resolveMergeSettings({ workflow: 'merge-review', concurrency: 2 }) });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nmerge:\n  concurrency: 3\n');
    if (mode === 'Requeue') {
      runner.requeueTask(failed.name, ['failed']);
    } else {
      await persistFailedTaskRetry({ task: failed, projectDir: project, worktreePath: failed.worktreePath!,
        startStep: undefined, retryNote: undefined, resumePoint: undefined, workflow: undefined,
        taskDir: undefined, sourceRunSlug: null, restartPoint: undefined });
    }
    const claimed = runner.claimNextTasks(1)[0]!;
    await executePersistedPrMergeTask(claimed, runner, project);
    expect(mocks.workflow).toHaveBeenCalledTimes(2);
    expect(limits).toEqual([4, 4]);
    expect(mocks.workflow.mock.calls[1]![0].cwd).toBe(failed.worktreePath);
  });
  it('relays only child warning progress during a silent linked merge and preserves the merge result', async () => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'merge:\n  auto_start: true\n  workflow: merge-review\n');
    const warning = { type: 'progress', level: 'warn', message: 'merge trace failed' } as const;
    mocks.workflow.mockImplementationOnce(async (request: WorkflowExecutionRequest) => {
      await request.eventSink?.({ type: 'run_started', runDirectory: request.cwd, reportDirectory: request.cwd, ndjsonLogPath: 'log' });
      await request.eventSink?.({ type: 'output', outputType: 'text', message: warning.message });
      await request.eventSink?.({ type: 'progress', message: 'ordinary progress' });
      await request.eventSink?.(warning);
      await request.eventSink?.({ type: 'completed', success: true });
      return { success: true };
    });
    mocks.status.mockResolvedValue({ merged: true });
    const events: WorkflowExecutionEvent[] = [];
    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123', undefined, {
      outputMode: 'silent', eventSink: (event) => { events.push(event); },
    });
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(events).toEqual([warning]);
    expect(new TaskRunner(project).listAllTaskItems().filter((task) => task.kind === 'completed')).toHaveLength(1);
  });

  it('同秒の再投入でもプロジェクト側の既存runを避け、保存値とtaskSpecを同じslugで実行する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-16T01:02:03.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const execute = mocks.workflow.getMockImplementation()!;
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      expect(request.taskSpec).toBeDefined();
      expect(request.taskSpec!.runSlug).toBe(request.reportDirName);
      stageTaskSpecForExecution(request.taskSpec!, buildRunPaths(project, request.reportDirName!));
      return execute(request);
    });
    await run();
    const runner = new TaskRunner(project);
    const first = runner.listFailedTasks()[0]!;
    expect(first.runSlug).toContain(`-${first.name}-`);
    expect(existsSync(buildRunPaths(project, first.runSlug!).runRootAbs)).toBe(true);
    expect(existsSync(buildRunPaths(first.worktreePath!, first.runSlug!).runRootAbs)).toBe(false);
    runner.requeueTask(first.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;

    await executePersistedPrMergeTask(claimed, runner, project);

    const resumed = runner.listFailedTasks()[0]!;
    const request = mocks.workflow.mock.calls[1]![0] as WorkflowExecutionRequest;
    expect(resumed.runSlug).toBe(`${first.runSlug}-2`);
    expect(request.reportDirName).toBe(resumed.runSlug);
    expect(request.resumeSource?.sourceRunSlug).toBe(first.runSlug);
    expect(request.task).toBe(request.taskSpec!.taskPrompt);
    expect(readFileSync(buildRunPaths(project, resumed.runSlug!).contextTaskOrderAbs, 'utf8'))
      .toBe(readFileSync(join(project, resumed.taskDir!, 'order.md'), 'utf8'));
  });
  it('creates the real merge source and lets agents read delivered instructions from project context after resume', async () => {
    const threatAgent = mocks.agent.getMockImplementation()!;
    mocks.agent.mockImplementation((...args: Parameters<typeof runAgent>) =>
      args[2]?.workflowMeta?.workflowName === 'tell-merge' ? runAgent(...args) : threatAgent(...args));
    const workflow = join(project, 'tell-merge.yaml');
    writeFileSync(workflow, [
      'name: tell-merge', 'max_steps: 5', 'initial_step: review', 'steps:',
      '  - name: review', '    instruction: Read the primary spec.',
      '    rules:', '      - condition: done', '        next: COMPLETE',
    ].join('\n'));
    const actual = await vi.importActual<typeof import('../features/tasks/execute/workflowExecutionApi.js')>(
      '../features/tasks/execute/workflowExecutionApi.js',
    );
    mocks.workflow.mockImplementation((request: WorkflowExecutionRequest) => actual.runWorkflowExecution({
      ...request, agentOverrides: { provider: 'mock' }, outputMode: 'silent',
    }));
    const content = 'merge の再開後も保存した指示を読む';
    const reads: string[] = [];
    let issued = false;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      if (!issued) {
        const orderRef = instruction.match(/Primary spec: `([^`]+)`/)![1]!;
        reads.push(readFileSync(join(options.cwd!, orderRef), 'utf8'));
        issued = true;
        const running = new TaskRunner(project).listTaskStateItems().find((task) => task.kind === 'running')!;
        const source = join(project, running.taskDir!, 'order.md');
        expect(readFileSync(source, 'utf8')).toMatch(/^Evaluate pull request #123 using this workflow\./);
        await issueTellableRunningTask(project, running.runSlug!, content);
        expect(readFileSync(source, 'utf8')).not.toContain(content);
        return { persona: persona ?? 'reviewer', status: 'done', content: 'done',
          sessionId: 'merge-session', timestamp: new Date() };
      }
      expect(options.sessionId).toBe('merge-session');
      return { persona: persona ?? 'reviewer', status: 'error', content: 'failed',
        error: 'failure after delivery', timestamp: new Date() };
    });
    await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow,
      settings: resolveMergeSettings(undefined) });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    const originalSpecDir = failed.taskDir;
    const workflowResult = await mocks.workflow.mock.results[0]!.value as Awaited<ReturnType<typeof actual.runWorkflowExecution>>;
    expect(new LiveInterventionFileStore(project, failed.runSlug!).read().deliveredSameSession, workflowResult.reason).toBe(1);
    expect(reads[0]).not.toContain(content);
    expect(readFileSync(buildRunPaths(project, failed.runSlug!).contextTaskOrderAbs, 'utf8')).toContain(content);
    expect(existsSync(buildRunPaths(failed.worktreePath!, failed.runSlug!).contextTaskAbs)).toBe(false);
    runner.requeueTask(failed.name, ['failed']);
    const claimed = runner.claimNextTasks(1)[0]!;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      const ref = instruction.match(/Primary spec: `([^`]+)`/)![1]!;
      reads.push(readFileSync(join(options.cwd!, ref), 'utf8'));
      return { persona: persona ?? 'reviewer', status: 'done', content: 'done', timestamp: new Date() };
    });
    await executePersistedPrMergeTask(claimed, runner, project);
    expect(reads.at(-1)).toContain(content);
    const resumed = runner.listFailedTasks()[0]!;
    expect(resumed.taskDir).toBe(originalSpecDir);
    expect(resumed.runSlug).not.toBe(failed.runSlug);
    expect(readFileSync(buildRunPaths(project, resumed.runSlug!).contextTaskOrderAbs, 'utf8')).toContain(content);
  });
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

  it('失敗後の新規mergeは別タスクとcloneを作り、listのRequeueは元のcloneを再開する', async () => {
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    expect(failed.data?.merge_task).toBe(true);
    expect(failed.worktreePath).toBe(executedCwd);
    expect(existsSync(failed.worktreePath!)).toBe(true);
    const oldCloneNote = join(failed.worktreePath!, 'old-clone-note.txt');
    writeFileSync(oldCloneNote, 'preserve old clone\n');
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    const fresh = runner.listFailedTasks().find((item) => item.name !== failed.name)!;
    expect(fresh.name).not.toBe(failed.name);
    expect(fresh.worktreePath).not.toBe(failed.worktreePath);
    expect(fresh.worktreePath).toBe(executedCwd);
    expect(existsSync(fresh.worktreePath!)).toBe(true);
    expect(readFileSync(oldCloneNote, 'utf8')).toBe('preserve old clone\n');
    rmSync(oldCloneNote);

    runner.requeueTask(failed.name, ['failed']);
    await expect(executePrWorkflow({ projectCwd: project, prNumber: 123,
      workflow: 'merge-review', settings: resolveMergeSettings(undefined) }))
      .rejects.toThrow('Active task target already exists');
    const claimed = runner.claimNextTasks(1)[0]!;
    expect(claimed.resumeMode).toBe('requeue');
    expect(claimed.name).toBe(failed.name);
    expect(claimed.worktreePath).toBe(failed.worktreePath);
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await executePersistedPrMergeTask(claimed, runner, project)).toEqual({ merged: true });
    expect(existsSync(failed.worktreePath!)).toBe(false);
    expect(existsSync(fresh.worktreePath!)).toBe(true);
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
      threatCheckMaxDiffBytes: 1000,
    });
    start(123, '/fork-one');
    expect(() => start(124, '/fork-two')).not.toThrow();
    expect(() => start(123, '/fork-three')).toThrow('Active task target already exists');
    expect(() => start(125, '/fork-one')).toThrow('Active task target already exists');
  });

  it('新規mergeが実行中なら旧失敗タスクのRequeueとRetryを拒否する', async () => {
    expect(await run()).toMatchObject({ exitCode: 1 });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    const active = runner.startPrMergeTask({
      prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork],
      workflow: 'merge-review', method: 'squash', worktreePath: join(root, 'active-clone'),
      threatCheckMaxDiffBytes: 1000,
    });
    expect(() => runner.requeueTask(failed.name, ['failed']))
      .toThrow('Active task target already exists');
    expect(() => runner.startReExecution(failed.name, ['failed'], 'retry'))
      .toThrow('Active task target already exists');
    expect(runner.listFailedTasks().some((task) => task.name === failed.name)).toBe(true);
    expect(runner.listAllTaskItems().some((task) => task.name === active.name && task.kind === 'running')).toBe(true);
    expect(existsSync(failed.worktreePath!)).toBe(true);
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

  it.each(['test.yml', '@org/team'])('番号指定のforkで累積指示・CI変更%sを安全にコメントし本体を停止する', async (fileName) => {
    const author = join(root, 'author');
    const workflowPath = `.github/workflows/${fileName}`;
    for (const file of ['CLAUDE.md', workflowPath]) {
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
    expect(comment).toContain('CLAUDE.md'); expect(comment).toContain(workflowPath.replaceAll('@', '＠'));
    expect(comment).not.toContain('@');
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
