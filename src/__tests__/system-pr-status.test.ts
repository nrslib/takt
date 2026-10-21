import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import type { WorkflowEffect, WorkflowSystemInput } from '../core/models/types.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';

describe('PR status system input target ownership', () => {
  const fetchPrStatus = vi.fn();
  const findExistingPr = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    findExistingPr.mockReturnValue({ number: 999, url: 'https://github.com/org/repo/pull/999' });
    fetchPrStatus.mockResolvedValue({ number: 123, headSha: 'a'.repeat(40), ci: { finished: false, passed: false },
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', merged: false });
  });

  function services(withContext: boolean) {
    const gitProvider = {
      checkCliStatus: () => ({ available: true as const }),
      fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(), fetchPrReviewComments: vi.fn(),
      listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr, commentOnPr: vi.fn(), closePr: vi.fn(), mergePr: vi.fn(),
      fetchPrStatus,
    };
    return createDefaultSystemStepServices({ cwd: '/clone', projectCwd: '/project', task: 'Review PR 123', gitProvider,
      ...(withContext ? { prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
        headSha: 'a'.repeat(40), headRepositoryUrl: 'https://github.com/author/repo.git',
        headRepositoryPushUrls: ['https://github.com/author/repo.git'] } } : {}),
    });
  }

  function resolve(service: ReturnType<typeof services>) {
    return Reflect.apply(service.resolveSystemInput, service, [{ type: 'pr_status', source: 'current_pr', as: 'status' }]);
  }

  it('実行contextのPR番号を元リポジトリで取得しbranchの別PRへ置き換えない', async () => {
    expect(await resolve(services(true))).toMatchObject({ number: 123, ci: { finished: false, passed: false } });
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
    expect(findExistingPr).not.toHaveBeenCalled();
  });

  it('同じサービスで新headのCI実行中から成功まで最新状態を返す', async () => {
    const service = services(true);
    const headSha = 'b'.repeat(40);
    fetchPrStatus.mockResolvedValueOnce({ number: 123, headSha, ci: { finished: false, passed: false } })
      .mockResolvedValueOnce({ number: 123, headSha, ci: { finished: true, passed: true } });
    expect(await resolve(service)).toMatchObject({ headSha, ci: { finished: false, passed: false } });
    expect(await resolve(service)).toMatchObject({ headSha, ci: { finished: true, passed: true } });
    expect(fetchPrStatus).toHaveBeenCalledTimes(2);
  });

  it('PR実行contextがなければ暗黙のPR検索や成功値で補完しない', () => {
    expect(() => resolve(services(false))).toThrow();
    expect(fetchPrStatus).not.toHaveBeenCalled();
    expect(findExistingPr).not.toHaveBeenCalled();
  });

  it('取得例外をCI成功に変換しない', async () => {
    fetchPrStatus.mockRejectedValue(new Error('status unavailable'));
    await expect(resolve(services(true))).rejects.toThrow();
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
  });

  it('取得期限とsignalをProviderへ渡す', async () => {
    const service = services(true);
    const prStatusFetchOptions = { timeoutMs: 100, signal: new AbortController().signal };
    await service.resolveSystemInput({ type: 'pr_status', source: 'current_pr', as: 'status' }, undefined, 'wait', {
      cache: new Map(), resolvedBindings: new Map(), prStatusFetchOptions,
    });
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', prStatusFetchOptions);
  });
});

describe('CI failure system input and rerun effect', () => {
  const headSha = 'b'.repeat(40);
  const failure = () => ({ number: 123, headSha, complete: true, checks: [
    { name: 'unit', run: { id: 10, attempt: 1, headSha, url: 'https://github.com/org/repo/actions/runs/10' },
      jobs: [{ id: 20, name: 'unit', url: 'https://github.com/org/repo/actions/runs/10/job/20',
        log: 'math.test.ts > adds\nexpected 2 to equal 3' }] },
  ], unavailable: [] });
  const input: WorkflowSystemInput = { type: 'pr_ci_failure', source: 'current_pr', as: 'failure',
    head_sha: '{context:wait_ci.status.headSha}' };
  const effect: WorkflowEffect = { type: 'rerun_ci', pr: 123,
    failure: '{context:collect_ci_failure.failure}' };

  function fixture(supported = true) {
    const fetchPrStatus = vi.fn(async () => ({ number: 123, headSha, ci: { finished: true, passed: false },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false }));
    const fetchPrCiFailure = vi.fn(async () => failure());
    const rerunPrCi = vi.fn(async () => ({ success: true, failed: false, number: 123, headSha,
      runs: [{ id: 10, attempt: 1 }] }));
    const gitProvider = { checkCliStatus: vi.fn(), fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
      fetchPrReviewComments: vi.fn(), listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr: vi.fn(),
      commentOnPr: vi.fn(), closePr: vi.fn(), mergePr: vi.fn(),
      fetchPrStatus, ...(supported ? { fetchPrCiFailure, rerunPrCi } : {}),
    };
    const service = createDefaultSystemStepServices({ cwd: '/clone', projectCwd: '/project', task: 'Review PR', gitProvider,
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
        headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] },
    });
    const config = normalizeWorkflowConfig({ name: 'ci-recovery', initial_step: 'wait_ci', steps: [
      { name: 'wait_ci', mode: 'system', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
    ] }, '/project');
    const state = createInitialState(config, { provider: 'mock', projectCwd: '/project' });
    state.systemContexts.set('wait_ci', { status: { number: 123, headSha, ci: { finished: true, passed: false } } });
    state.systemContexts.set('collect_ci_failure', { failure: failure() });
    state.structuredOutputs.set('investigate_ci', { verdict: 'external', summary: 'Runner outage confirmed' });
    return { service, state, fetchPrStatus, fetchPrCiFailure, rerunPrCi };
  }

  it('再実行前は通常pollingを保ち実行後は保存したPR・HEAD・旧attemptを状態取得へ渡す', async () => {
    const h = fixture();
    const statusInput: WorkflowSystemInput = { type: 'pr_status', source: 'current_pr', as: 'status',
      rerun_from: '{effect:rerun_ci.rerun_ci.rerun}' };
    expect(await h.service.resolveSystemInput(statusInput, h.state)).toMatchObject({ rerunHeadChanged: false, rerunHeadChangeReason: '' });
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined });
    const rerun = { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] };
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: true, rerun } });
    await h.service.resolveSystemInput(statusInput, h.state);
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined, rerun });
  });

  it('停止コメント用の参照情報にログ全文を複製せず再実行エラーは調査へ渡す', async () => {
    const h = fixture();
    h.state.stepIterations.set('rerun_ci', 1);
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: false, error: 'HTTP 403: rerun denied' } });
    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ checks: failure().checks, rerunCount: 1, recoveryError: 'HTTP 403: rerun denied' });
    const details = JSON.parse((result as { details: string }).details);
    expect(details).toMatchObject({ checks: [{ name: 'unit', jobs: [{ id: 20, url: expect.any(String) }] }],
      recoveryError: 'HTTP 403: rerun denied' });
    expect(Object.hasOwn(details.checks[0].jobs[0], 'log')).toBe(false);
  });

  it('再実行後の失敗調査にも旧attemptの識別情報を渡して最新の失敗を取得する', async () => {
    const h = fixture();
    const rerun = { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] };
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: true, rerun } });
    await h.service.resolveSystemInput(input, h.state);
    expect(h.fetchPrCiFailure).toHaveBeenCalledWith(123, headSha, '/project', { signal: undefined, rerun });
  });

  it('別名ステップの再実行結果も回数とエラーに反映する', async () => {
    const h = fixture();
    h.state.effectResults.set('retry_ci', { rerun_ci: { success: false, error: 'HTTP 403: rerun denied' } });
    expect(await h.service.resolveSystemInput(input, h.state)).toMatchObject({
      rerunCount: 1, recoveryError: 'HTTP 403: rerun denied',
    });
  });

  it('初期contextのHEADを使わず失敗した最新HEADと対象PRをProviderへ渡す', async () => {
    const h = fixture();
    const result = await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure');
    expect(result).toMatchObject(failure());
    expect(h.fetchPrCiFailure).toHaveBeenCalledWith(123, headSha, '/project', expect.anything());
  });

  it('初回pushとCacciaを修正予算に数えずHEAD更新後も回復pushの2周を保持する', async () => {
    const h = fixture();
    h.state.stepIterations.set('push', 1);
    h.state.stepIterations.set('caccia', 3);
    h.state.stepIterations.set('push_ci_fix', 2);
    expect(await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure'))
      .toMatchObject({ fixRounds: 2, rerunCount: 0 });
  });

  it('未対応Providerを具体的な証拠不足として返す', async () => {
    const h = fixture(false);
    expect(await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure'))
      .toMatchObject({ complete: false, unavailable: expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]) });
  });

  it('外部要因判断なら修正2周後も失敗runの再実行を受け付ける', async () => {
    const h = fixture();
    h.state.stepIterations.set('push_ci_fix', 2);
    h.state.stepIterations.set('rerun_ci', 1);
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: true, rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } });
    expect(h.rerunPrCi).toHaveBeenCalledOnce();
  });

  it('別名ステップで再実行済みなら新しいattemptの証拠でも二度目を拒否する', async () => {
    const h = fixture();
    h.state.currentStep = 'retry_ci_again';
    h.state.stepIterations.set('retry_ci_again', 1);
    h.state.effectResults.set('retry_ci', { rerun_ci: { success: true,
      rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } } });
    const latestFailure = failure();
    latestFailure.checks[0]!.run.attempt = 2;
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: latestFailure }, h.state))
      .toMatchObject({ success: false, error: 'CI rerun budget is exhausted' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
    expect(h.fetchPrStatus).not.toHaveBeenCalled();
  });

  it('別名ステップの二周目は保存結果がなくても再実行しない', async () => {
    const h = fixture();
    h.state.currentStep = 'retry_ci';
    h.state.stepIterations.set('retry_ci', 2);
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, error: 'CI rerun budget is exhausted' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it('現在HEADが変わっていれば再実行前に拒否する', async () => {
    const h = fixture();
    h.fetchPrStatus.mockResolvedValueOnce({ number: 123, headSha: 'c'.repeat(40), ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, headChanged: true });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
    expect(h.fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
  });

  it('現在HEADの取得失敗を一致扱いにせず再実行を拒否する', async () => {
    const h = fixture();
    h.fetchPrStatus.mockRejectedValueOnce(new Error('HTTP 403'));
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, error: 'HTTP 403' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it.each(['defect', 'insufficient_evidence'])('判断が%sなら再実行を拒否する', async (verdict) => {
    const h = fixture();
    h.state.structuredOutputs.set('investigate_ci', { verdict, summary: 'Not an external outage' });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it.each(['wrong-pr', 'incomplete-evidence', 'already-rerun', 'partial-rerun'])('%sではCI再実行を開始しない', async (condition) => {
    const h = fixture();
    const evidence = failure();
    if (condition === 'incomplete-evidence') evidence.complete = false;
    if (condition === 'already-rerun' || condition === 'partial-rerun') {
      h.state.stepIterations.set('rerun_ci', 2);
      h.state.effectResults.set('rerun_ci', { rerun_ci: { success: condition === 'already-rerun',
        rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } } });
    }
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: condition === 'wrong-pr' ? 999 : 123,
      failure: evidence }, h.state)).toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });
});
