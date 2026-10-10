import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowExecutionRequest } from '../features/tasks/execute/workflowExecutionApi.js';

const mocks = vi.hoisted(() => ({ details: vi.fn(), status: vi.fn(), workflow: vi.fn(), logError: vi.fn(), agent: vi.fn(), comment: vi.fn(), reviewStatus: vi.fn() }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({ checkCliStatus: () => ({ available: true }),
    fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, commentOnPr: mocks.comment }),
}));
vi.mock('../infra/github/pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), fetchPrDetails: mocks.details, fetchPrStatus: mocks.status,
  fetchCodeRabbitReviewStatus: mocks.reviewStatus,
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: mocks.workflow }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));

import { runMerge, resolveMergeSettings, runLinkedMergeSafely, executePrWorkflow } from '../features/merge/index.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';
import * as cloneExec from '../infra/task/clone-exec.js';
import * as threatCheck from '../features/merge/threat-check.js';
import { createCheckoutFilter } from './helpers/checkout-filter.js';

describe('Merge PR temporary clone ownership', () => {
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
    mocks.reviewStatus.mockImplementation(async () => ({ headSha: prHead, hasCodeRabbitPost: false,
      hasCodeRabbitStatus: false, reviewedHeadShas: [], unresolvedThreadCount: 0 }));
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
  }, 120_000);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function run() {
    return runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: 'merge-review' }) });
  }
  it('forkのheadを一時cloneで実行し正常終了後にcloneだけを削除する', async () => {
    const result = await run();
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(executedCwd).toBeDefined();
    expect(existsSync(executedCwd!)).toBe(false);
    expect(readFileSync(reportPath, 'utf8')).toBe('Review completed\n');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('base\n');
    expect(result).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.status).toHaveBeenCalled();
  });

  it('workflow例外後もcloneを削除し作成済みreportをrootに残す', async () => {
    const execute = mocks.workflow.getMockImplementation()!;
    mocks.workflow.mockImplementation(async (request: WorkflowExecutionRequest) => {
      await execute(request);
      throw new Error('review failed');
    });
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(executedCwd).toBeDefined();
    expect(existsSync(executedCwd!)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
  });

  it('workflow成功だけではなくPRの実際のmerged状態を集計する', async () => {
    mocks.status.mockResolvedValue({ number: 123, headSha: prHead, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true });
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 1, exitCode: 0 });
    expect(existsSync(executedCwd!)).toBe(false);
  });

  it('相対workflow pathを元リポジトリから解決してclone実行へ渡す', async () => {
    mocks.workflow.mockResolvedValue({ success: true });
    await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './custom-merge.yaml' }) });
    expect(mocks.workflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowIdentifier: join(project, 'custom-merge.yaml'), projectCwd: project,
    }));
    const request = mocks.workflow.mock.calls[0]?.[0] as WorkflowExecutionRequest;
    expect(existsSync(request.cwd)).toBe(false);
  });

  it('最終状態取得の期限切れでも失敗を集計してcloneを破棄しreportを保持する', async () => {
    mocks.status.mockRejectedValue(new PrStatusTimeoutError());
    expect(await run()).toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(mocks.status).toHaveBeenCalledWith(123, project, { signal: undefined });
    expect(existsSync(executedCwd!)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(baseHead);
  });

  it('最終状態取得中の外部abortを伝播してcloneを削除する', async () => {
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
    expect(existsSync(executedCwd!)).toBe(false);
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
    expect(existsSync(executedCwd!)).toBe(false);
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
    expect(existsSync(executedCwd!)).toBe(false);
  });

  it.each(['terminal', 'silent'] as const)('自動mergeの子workflowへ親の%s表示設定を引き継ぐ', async (outputMode) => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'merge:\n  auto_start: true\n  workflow: merge-review\n');
    const display = { outputMode, taskPrefix: 'parent-task', taskColorIndex: 2, taskDisplayLabel: 'parent-label' };

    await runLinkedMergeSafely(project, 'https://github.com/org/repo/pull/123', undefined, display);

    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.workflow.mock.calls[0]?.[0]).toMatchObject(display);
    expect(existsSync(executedCwd!)).toBe(false);
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

  it.each(['reject', 'error', 'safe'] as const)('脅威判定の%s時に中断したらコメント・本体・状態取得を開始せずcloneを削除する', async (outcome) => {
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
    expect(existsSync(paths[0]!)).toBe(false);
  });

  it.each(['reject', 'error'] as const)('未中断の脅威判定%sは確認コメントを投稿してcloneを削除する', async (outcome) => {
    const paths = observeClone();
    if (outcome === 'reject') mocks.agent.mockRejectedValue(new Error('provider failed'));
    else mocks.agent.mockResolvedValue({ status: 'error' });
    expect(await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: 'merge-review',
      settings: resolveMergeSettings(undefined), abortSignal: new AbortController().signal })).toEqual({ merged: false });
    expect(mocks.comment).toHaveBeenCalledOnce();
    expect(mocks.comment.mock.calls[0]?.[1]).toContain('人間による確認');
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(existsSync(paths[0]!)).toBe(false);
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
      expect(existsSync(paths[0]!)).toBe(false);
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
    expect(existsSync(paths[0]!)).toBe(false);
  });

  it('番号指定のforkで累積指示・CI変更をコメントし本体開始前に停止してcloneを破棄する', async () => {
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
    expect(paths).toHaveLength(1); expect(existsSync(paths[0]!)).toBe(false);
  });

  it('実cloneのcore.sshCommandキーを検出し二層目と本体を呼ばない', async () => {
    const paths = observeClone((cwd) => git(cwd, 'config', 'core.sshCommand', 'ssh'));
    await run();
    expect(mocks.comment.mock.calls[0]?.[1]).toMatch(/core\.sshcommand/iu);
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.workflow).not.toHaveBeenCalled();
    expect(existsSync(paths[0]!)).toBe(false);
  });

  it('同一repositoryはfork検査を省略してcloneで本体を実行する', async () => {
    mocks.details.mockReturnValue({ number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: prHead,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: true });
    await run();
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.comment).not.toHaveBeenCalled();
    expect(mocks.workflow).toHaveBeenCalledOnce(); expect(existsSync(executedCwd!)).toBe(false);
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
    expect(existsSync(paths[0]!)).toBe(false);
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
      listOpenPrs: () => [123, 456].map((number) => ({ number, author: 'author', labels: [], base_branch: 'main',
        head_branch: 'feature/pr', managed_by_takt: false, same_repository: number === 456, draft: false, updated_at: '' })),
      executePrWorkflow,
    });
    expect(result).toMatchObject({ processedCount: 2, mergedCount: 1, exitCode: 1 });
    expect(mocks.agent).toHaveBeenCalledOnce(); expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith('PR merge workflow failed', expect.objectContaining({ prNumber: 123, error: 'comment denied' }));
    expect(paths).toHaveLength(2); expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

});
