import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogger } from '../shared/utils/debug.js';
import type { CacciaInput, CacciaResult } from '../features/caccia/index.js';
import type { SystemStepServicesOptions } from '../core/workflow/system/system-step-services.js';
import { PrHeadObservationMismatchError, type PrDetails } from '../core/workflow/system/pr-execution-context.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
const mocks = vi.hoisted(() => ({
  run: vi.fn<(input: CacciaInput) => Promise<CacciaResult>>(),
  config: vi.fn(), git: vi.fn(), details: vi.fn(), threat: vi.fn(), detect: vi.fn(), comment: vi.fn(), execFile: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), execFile: mocks.execFile,
}));
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<typeof import('../features/caccia/index.js')>(), runCaccia: mocks.run,
}));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: mocks.config }));
vi.mock('../infra/git/detect.js', () => ({ detectVcsProvider: mocks.detect }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: () => ({ fetchPrDetails: mocks.details, commentOnPr: mocks.comment }) }));
vi.mock('../infra/task/clone-exec.js', () => ({ runGitCommandAbortable: mocks.git }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../features/merge/threat-check.js', async (original) => ({
  ...await original<typeof import('../features/merge/threat-check.js')>(), checkForkThreats: mocks.threat,
}));
import { cacciaEffect } from '../features/caccia/system-effect.js';

const initial = 'a'.repeat(40);
const updated = 'b'.repeat(40);
function options(): Omit<SystemStepServicesOptions, 'gitProvider'> {
  return { cwd: '/clone', projectCwd: '/project', task: 'Review',
    prExecutionContext: { prNumber: 123, headBranch: 'feature', baseBranch: 'main',
      headSha: initial, headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] },
    prGitOperations: { fetch: vi.fn(async () => {}), push: vi.fn(async () => {}) } };
}
function details(overrides: Partial<PrDetails>): PrDetails {
  return { ...options().prExecutionContext!, number: 123, sameRepository: true, ...overrides };
}
describe('Caccia effect result', () => {
  it('passes the parent warning sink to linked Caccia without changing its result', async () => {
    const eventSink = vi.fn();
    mocks.run.mockImplementationOnce(async (input) => {
      await input.eventSink?.({ type: 'progress', level: 'warn', message: 'Caccia trace failed' });
      return { outcome: 'success', headSha: initial, unresolvedCount: 0 };
    });
    expect(await cacciaEffect({ ...options(), outputMode: 'silent', eventSink }, 123))
      .toMatchObject({ success: true, outcome: 'success', unresolvedCount: 0 });
    expect(eventSink).toHaveBeenCalledExactlyOnceWith({ type: 'progress', level: 'warn', message: 'Caccia trace failed' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ now: 0 });
    mocks.detect.mockReturnValue('github');
    mocks.config.mockImplementation((_cwd, key) => key === 'caccia'
      ? { enabled: true, waitTimeoutMs: 17, maxIterations: 2, workflow: 'custom' } : undefined);
    mocks.git.mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'symbolic-ref' ? 'feature' : initial, stderr: '',
    }));
    mocks.details.mockResolvedValue({ ...options().prExecutionContext, number: 123, sameRepository: true });
    mocks.run.mockResolvedValue({ outcome: 'success', headSha: initial, unresolvedCount: 0 });
  });
  it.each([undefined, { enabled: false }])('does not wait with configuration %j', async (settings) => {
    mocks.config.mockReturnValue(settings);
    expect(await cacciaEffect(options(), 123)).toMatchObject({
      success: true, failed: false, outcome: 'skipped', headSha: initial,
      skipReason: 'config_disabled', unresolvedCount: 0,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it.each(['success', 'limit', 'skipped'] as const)('returns machine readable %s fields', async (outcome) => {
    mocks.run.mockResolvedValue({ outcome, headSha: initial, unresolvedCount: 3,
      ...(outcome === 'skipped' ? { skipReason: 'review_rate_limited', reason: 'rate limit' } : {}) });
    expect(await cacciaEffect(options(), 123)).toEqual({
      success: true, failed: false, outcome, headSha: initial, unresolvedCount: 3,
      skipReason: outcome === 'skipped' ? 'review_rate_limited' : null,
      reason: outcome === 'skipped' ? 'rate limit' : null,
    });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      expectedInitialHeadSha: initial,
      settings: { enabled: true, waitTimeoutMs: 17, maxIterations: 2, workflow: 'custom' },
    }));
  });
  it('returns a non-GitHub skip without requiring unsupported PR details', async () => {
    mocks.detect.mockReturnValue('gitlab');
    mocks.details.mockRejectedValue(new Error('Unsupported PR metadata API'));
    expect(await cacciaEffect(options(), 123)).toMatchObject({
      success: true, outcome: 'skipped', headSha: initial, skipReason: 'github_unavailable',
    });
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('skips a non-GitHub PR task with its existing diff context and no merge metadata API', async () => {
    mocks.detect.mockReturnValue('gitlab');
    expect(await cacciaEffect({ ...options(), prExecutionContext: undefined,
      prContext: { source: 'pr_review', prNumber: 123, headBranch: 'feature',
        baseBranch: 'main', baseBranchSource: 'pull_request' } }, 123)).toMatchObject({
      success: true, failed: false, outcome: 'skipped', skipReason: 'github_unavailable',
      headSha: initial, unresolvedCount: 0, reason: expect.any(String),
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it.each(['config_disabled', 'provider_unavailable', 'github_unavailable'] as const)(
    'validates and records the current head before an early skip: %s', async (source) => {
      const record = vi.fn();
      if (source === 'config_disabled') {
        mocks.config.mockImplementation((_cwd, key) => key === 'caccia' ? { enabled: false } : undefined);
      }
      else if (source === 'provider_unavailable') mocks.detect.mockReturnValue('gitlab');
      else mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0, skipReason: source });
      mocks.git.mockImplementation(async (_cwd, args) => ({
        stdout: args[0] === 'symbolic-ref' ? 'feature' : updated, stderr: '',
      }));
      mocks.details.mockResolvedValue({ ...options().prExecutionContext, number: 123, headSha: updated });
      expect(await cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123)).toMatchObject({
        success: true, failed: false, outcome: 'skipped', headSha: updated,
        skipReason: source === 'config_disabled' ? source : 'github_unavailable',
      });
      expect(record).toHaveBeenCalledExactlyOnceWith(updated, updated, options().prExecutionContext);
      expect(mocks.details.mock.calls[0]?.slice(0, 2)).toEqual([123, '/project']);
      expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);
    });
  it.each([
    ['config_disabled', 'head'], ['config_disabled', 'identity'], ['config_disabled', 'record'],
    ['provider_unavailable', 'fetch'], ['github_unavailable', 'head'],
  ] as const)('fails an early skip on validation or storage failure: %s %s', async (source, failure) => {
    const record = vi.fn(() => { if (failure === 'record') throw new Error('Storage failed'); });
    if (source === 'config_disabled') {
      mocks.config.mockImplementation((_cwd, key) => key === 'caccia' ? { enabled: false } : undefined);
    }
    else if (source === 'provider_unavailable') mocks.detect.mockReturnValue('gitlab');
    else mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0, skipReason: source });
    const changed = { ...options().prExecutionContext,
      number: failure === 'identity' ? 456 : 123, headSha: failure === 'head' ? updated : initial };
    if (source === 'github_unavailable') {
      mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 }).mockResolvedValue(changed);
    } else mocks.details.mockResolvedValue(changed);
    if (failure === 'fetch') mocks.details.mockRejectedValue(new Error('Metadata unavailable'));
    const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await running)
      .toMatchObject({ success: false, failed: true });
    expect(record).toHaveBeenCalledTimes(failure === 'record' ? 1 : 0);
    expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);
  });
  it('初回のheadが一致したら待機せずCacciaを実行する', async () => {
    const completed = vi.fn();
    const running = cacciaEffect(options(), 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toHaveBeenCalledOnce();
    expect(await running).toMatchObject({ success: true, failed: false, headSha: initial });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedInitialHeadSha: initial }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Provider内部のhead観測が食い違っても安定した期待SHAを取得してから続行する', async () => {
    const remote = 'https://github.com/org/repo.git';
    const locator = (headSha: string) => ({ url: 'https://github.com/org/repo/pull/123', headRefOid: headSha });
    const graphql = { data: { repository: { pullRequest: {
      number: 123, headRefName: 'feature', headRefOid: updated,
      headRepository: { sshUrl: 'git@github.com:org/repo.git' },
    } } } };
    const stable = [locator(updated), graphql, remote, remote, { baseRefName: 'main', isCrossRepository: false }];
    const responses = [locator(initial), graphql, ...stable, ...stable];
    mocks.execFile.mockImplementation((_command: string, _args: string[], _options: unknown,
      callback: (error: Error | null, stdout: string) => void) => {
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected metadata request');
      callback(null, typeof response === 'string' ? response : JSON.stringify(response));
    });
    mocks.git.mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'symbolic-ref' ? 'feature' : updated, stderr: '',
    }));
    mocks.run.mockResolvedValue({ outcome: 'success', headSha: updated, unresolvedCount: 0 });
    const input = options();
    const record = vi.fn();
    const completed = vi.fn();
    const running = cacciaEffect({ ...input, gitProvider: new GitHubProvider(), prMergePushRecorder: { record },
      prExecutionContext: { ...input.prExecutionContext!, headRepositoryUrl: remote, headRepositoryPushUrls: [remote] } }, 123)
      .then((result) => {
        completed(result);
        return result;
      });

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(await running).toMatchObject({ success: true, failed: false, headSha: updated });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedInitialHeadSha: updated }));
    expect(record).toHaveBeenCalledExactlyOnceWith(updated, updated, expect.any(Object));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('取得中の不整合が続いても期限を延長せず最後の観測を返す: priorConsistent=%s', async (priorConsistent) => {
    const record = vi.fn();
    const completed = vi.fn();
    const lastHead = 'c'.repeat(40);
    if (priorConsistent) mocks.details.mockResolvedValueOnce(details({ headSha: updated }));
    mocks.details.mockRejectedValue(new PrHeadObservationMismatchError(123, updated, lastHead));
    const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const result = await running;
    expect(result).toMatchObject({ success: false, failed: true });
    expect(result.error).toContain(`expected ${initial}`);
    expect(result.error).toContain(`last observed ${lastHead} (inconsistent with ${updated})`);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'Authentication failed', 'Metadata unavailable',
    'Pull request #123 head changed while reading its metadata',
  ])('型で識別した不整合以外の取得エラーは直ちに失敗する: %s', async (message) => {
    const record = vi.fn();
    const completed = vi.fn();
    mocks.details.mockRejectedValueOnce(new Error(message)).mockResolvedValue(details({}));
    const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toHaveBeenCalledOnce();
    expect(await running).toMatchObject({ success: false, failed: true, error: message });
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['enabled', 'config_disabled', 'github_unavailable'] as const)(
    '古いheadを複数回取得しても一致するまで処理や記録を進めない: %s', async (source) => {
      const record = vi.fn();
      const completed = vi.fn();
      if (source === 'config_disabled') {
        mocks.config.mockImplementation((_cwd, key) => key === 'caccia' ? { enabled: false } : undefined);
      }
      if (source === 'github_unavailable') {
        mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0, skipReason: source });
        mocks.details.mockResolvedValueOnce(details({}));
      }
      mocks.details
        .mockResolvedValueOnce(details({ headSha: updated }))
        .mockResolvedValueOnce(details({ headSha: updated }))
        .mockResolvedValue(details({}));
      const input = { ...options(), prMergePushRecorder: { record } };
      const running = cacciaEffect(input, 123).then((result) => {
        completed(result);
        return result;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(completed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(completed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(completed).toHaveBeenCalledOnce();
      expect(await running).toMatchObject({ success: true, failed: false, headSha: initial,
        outcome: source === 'enabled' ? 'success' : 'skipped' });
      expect(record).toHaveBeenCalledExactlyOnceWith(initial, initial, input.prExecutionContext);
      expect(mocks.run).toHaveBeenCalledTimes(source === 'config_disabled' ? 0 : 1);
      if (source !== 'config_disabled') {
        expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ expectedInitialHeadSha: initial }));
      }
    });

  it('GitHub明示設定でCacciaが無効でもhead一致後にスキップ結果を記録する', async () => {
    const record = vi.fn();
    const completed = vi.fn();
    mocks.detect.mockReturnValue(undefined);
    mocks.config.mockImplementation((_cwd, key) => key === 'vcsProvider' ? 'github'
      : key === 'caccia' ? { enabled: false } : undefined);
    mocks.details
      .mockResolvedValueOnce(details({ headSha: updated }))
      .mockResolvedValueOnce(details({ headSha: updated }))
      .mockResolvedValue(details({}));
    const input = { ...options(), prMergePushRecorder: { record } };
    const running = cacciaEffect(input, 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(completed).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(completed).toHaveBeenCalledOnce();
    expect(await running).toMatchObject({
      success: true, failed: false, outcome: 'skipped', skipReason: 'config_disabled',
      headSha: initial, unresolvedCount: 0,
    });
    expect(record).toHaveBeenCalledExactlyOnceWith(initial, initial, input.prExecutionContext);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'enabled', lastHead: updated },
    { source: 'enabled', lastHead: 'c'.repeat(40) },
    { source: 'config_disabled', lastHead: 'c'.repeat(40) },
    { source: 'github_unavailable', lastHead: 'c'.repeat(40) },
  ] as const)('不一致が続けば固定の期限で失敗し期待SHAと最後のSHAを返す: $source $lastHead', async ({ source, lastHead }) => {
    const record = vi.fn();
    const completed = vi.fn();
    if (source === 'config_disabled') {
      mocks.config.mockImplementation((_cwd, key) => key === 'caccia' ? { enabled: false } : undefined);
    }
    if (source === 'github_unavailable') {
      mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0, skipReason: source });
      mocks.details.mockResolvedValueOnce(details({}));
    }
    let observedHead = updated;
    mocks.details.mockImplementation(async () => details({ headSha: observedHead }));
    const input = { ...options(), prMergePushRecorder: { record } };
    const running = cacciaEffect(input, 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect.soft(completed).not.toHaveBeenCalled();
    observedHead = lastHead;
    await vi.advanceTimersByTimeAsync(29_999);
    expect.soft(completed).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);

    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledOnce();
    const result = await running;
    expect(result).toMatchObject({ success: false, failed: true });
    expect.soft(result.error).toEqual(expect.stringContaining(initial));
    expect.soft(result.error).toEqual(expect.stringContaining(lastHead));
    expect(record).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(source === 'github_unavailable' ? 1 : 0);
    expect(input.prGitOperations!.fetch).not.toHaveBeenCalled();
    expect(input.prGitOperations!.push).not.toHaveBeenCalled();
  });

  it.each([
    { number: 456 }, { headBranch: 'another' }, { baseBranch: 'another' },
    { headRepositoryUrl: '/other' }, { headRepositoryPushUrls: ['/other'] },
  ] satisfies Partial<PrDetails>[])(
    '再取得でPR識別情報が変わったらheadが一致しても実行しない: %j', async (identity) => {
      const record = vi.fn();
      const completed = vi.fn();
      mocks.details.mockResolvedValueOnce(details({ headSha: updated }))
        .mockResolvedValue(details(identity));
      const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123).then((result) => {
        completed(result);
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(completed).toHaveBeenCalledOnce();
      expect(await running).toMatchObject({ success: false, failed: true });
      expect(mocks.run).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

  it('再取得の例外を再試行や成功へ変換しない', async () => {
    const record = vi.fn();
    const failure = new Error('Metadata unavailable');
    mocks.details.mockResolvedValueOnce(details({ headSha: updated })).mockRejectedValueOnce(failure)
      .mockResolvedValue(details({}));
    const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(await running).toMatchObject({ success: false, failed: true, error: failure.message });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([true, false])('headの反映待ち中に中断されたら処理も記録も行わない: enabled=%s', async (enabled) => {
    const controller = new AbortController();
    const record = vi.fn();
    const completed = vi.fn();
    mocks.config.mockImplementation((_cwd, key) => key === 'caccia' ? { enabled } : undefined);
    mocks.details.mockResolvedValue(details({ headSha: updated }));
    const running = cacciaEffect({ ...options(), abortSignal: controller.signal, prMergePushRecorder: { record } }, 123)
      .then((result) => {
        completed(result);
        return result;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();

    controller.abort(new Error('Caller interrupted'));
    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toHaveBeenCalledOnce();
    expect(await running).toMatchObject({ success: false, failed: true });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    const fetchCount = mocks.details.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.details).toHaveBeenCalledTimes(fetchCount);
  });

  it.each(['caller', 'deadline'] as const)('再取得中にも中断と固定の期限が効く: %s', async (source) => {
    const controller = new AbortController();
    const record = vi.fn();
    const completed = vi.fn();
    let fetchSignal: AbortSignal | undefined;
    mocks.details.mockResolvedValueOnce(details({ headSha: updated }))
      .mockImplementation((_number: number, _cwd: string, signal?: AbortSignal) => {
        fetchSignal = signal;
        return new Promise<PrDetails>((_resolve, reject) => {
          if (signal?.aborted) reject(new DOMException('The operation was aborted', 'AbortError'));
          else signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
        });
      });
    const running = cacciaEffect({ ...options(), abortSignal: controller.signal, prMergePushRecorder: { record } }, 123)
      .then((result) => {
        completed(result);
        return result;
      });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(completed).not.toHaveBeenCalled();
    expect(fetchSignal).toBeInstanceOf(AbortSignal);

    if (source === 'caller') controller.abort(new Error('Caller interrupted'));
    else {
      await vi.advanceTimersByTimeAsync(57_999);
      expect(completed).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(source === 'caller' ? 0 : 1);

    expect(completed).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ success: false, failed: true });
    if (source === 'deadline') {
      expect(result.error).toEqual(expect.stringContaining(initial));
      expect(result.error).toEqual(expect.stringContaining(updated));
    } else {
      expect(result.error).toBe('Caller interrupted');
    }
    expect(mocks.run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('非GitHubのスキップ照合にはheadの反映待ちを追加しない', async () => {
    const record = vi.fn();
    const completed = vi.fn();
    mocks.detect.mockReturnValue('gitlab');
    mocks.details.mockResolvedValue(details({ headSha: updated }));
    const running = cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123).then((result) => {
      completed(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toHaveBeenCalledOnce();
    expect(await running).toMatchObject({ success: false, failed: true });
    expect(record).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('uses the explicit VCS setting before remote detection', async () => {
    mocks.detect.mockReturnValue(undefined);
    mocks.config.mockImplementation((_cwd, key) => key === 'vcsProvider' ? 'github'
      : key === 'caccia' ? { enabled: true } : undefined);
    expect(await cacciaEffect(options(), 123)).toMatchObject({ success: true, outcome: 'success' });
    expect(mocks.run).toHaveBeenCalledOnce();
  });
  it('rejects missing GitHub execution metadata before running Caccia', async () => {
    expect(await cacciaEffect({ ...options(), prExecutionContext: undefined,
      prContext: { source: 'pr_review', prNumber: 123, headBranch: 'feature',
        baseBranch: 'main', baseBranchSource: 'pull_request' } }, 123)).toMatchObject({ failed: true });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('fills the head only for an initial review timeout with an unchanged PR', async () => {
    mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      skipReason: 'initial_review_unavailable', reason: 'timeout' });
    expect(await cacciaEffect(options(), 123)).toMatchObject({ success: true, headSha: initial });
  });
  it('rejects a missing head in a successful result', async () => {
    mocks.run.mockResolvedValue({ outcome: 'success', unresolvedCount: 0 });
    expect(await cacciaEffect(options(), 123)).toMatchObject({ success: false, failed: true, error: expect.any(String) });
  });
  it.each([undefined, { ...options().prExecutionContext!, prNumber: 456 }])(
    'rejects a missing or different PR context before running Caccia', async (context) => {
      expect(await cacciaEffect({ ...options(), prExecutionContext: context }, 123)).toMatchObject({ failed: true });
      expect(mocks.run).not.toHaveBeenCalled();
    });
  it('rejects execution in the project root', async () => {
    expect(await cacciaEffect({ ...options(), cwd: '/project' }, 123)).toMatchObject({ failed: true });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects a changed PR identity before side effects', async () => {
    mocks.details.mockResolvedValue({ ...options().prExecutionContext, number: 456 });
    expect(await cacciaEffect(options(), 123)).toMatchObject({ failed: true });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('turns a Caccia exception into an effect error', async () => {
    mocks.run.mockRejectedValue(new Error('external head changed'));
    expect(await cacciaEffect(options(), 123)).toEqual({
      success: false, failed: true, error: 'external head changed',
    });
  });
  it('keeps useful public diagnostics without ASCII mentions', async () => {
    const diagnostic = "fatal: couldn't find remote ref @org/team; contact @reviewer";
    const logging = vi.spyOn(DebugLogger.prototype, 'writeLog');
    mocks.run.mockRejectedValue(new Error(diagnostic));
    const result = await cacciaEffect(options(), 123);
    expect(result).toMatchObject({ success: false, failed: true, error: expect.stringContaining('remote ref') });
    expect(result.error).not.toContain('@');
    expect(result.error).toContain('＠org/team');
    expect(logging).toHaveBeenCalledWith('ERROR', 'caccia-effect', expect.any(String),
      { prNumber: 123, error: diagnostic });
  });
  it('records every pushed head and its previous head before a later failure', async () => {
    const record = vi.fn();
    const latest = 'c'.repeat(40);
    mocks.run.mockImplementation(async (input) => {
      if (input.entry !== 'linked') throw new Error('Expected linked execution');
      input.onPushedHead?.(updated);
      input.onPushedHead?.(latest);
      throw new Error('review failed after push');
    });
    expect(await cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123))
      .toMatchObject({ success: false, failed: true });
    expect(record.mock.calls).toEqual([[updated, initial, options().prExecutionContext],
      [latest, updated, options().prExecutionContext]]);
  });
  it.each([
    { outcome: 'success', headSha: updated, unresolvedCount: 0 },
    { outcome: 'skipped', unresolvedCount: 0, skipReason: 'initial_review_unavailable' },
    { outcome: 'skipped', headSha: updated, unresolvedCount: 0, skipReason: 'review_rate_limited' },
    { outcome: 'skipped', headSha: updated, unresolvedCount: 0, skipReason: 'review_skipped' },
    { outcome: 'limit', headSha: updated, unresolvedCount: 1 },
  ] satisfies CacciaResult[])('records a verified no-push head: $outcome $skipReason', async (result) => {
    const record = vi.fn();
    const input = { ...options(), prMergePushRecorder: { record } };
    mocks.git.mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'symbolic-ref' ? 'feature' : updated, stderr: '',
    }));
    mocks.details.mockResolvedValue({ ...input.prExecutionContext, number: 123, headSha: updated });
    mocks.run.mockResolvedValue(result);
    expect(await cacciaEffect(input, 123)).toMatchObject({ success: true, failed: false,
      outcome: result.outcome, headSha: updated, unresolvedCount: result.unresolvedCount });
    expect(record).toHaveBeenCalledExactlyOnceWith(updated, updated, input.prExecutionContext);
  });
  it.each([
    ['success', 'head'], ['success', 'identity'], ['skipped', 'identity'], ['limit', 'head'],
  ] as const)('does not record a no-push %s when the latest PR %s changes', async (outcome, changed) => {
    const record = vi.fn();
    mocks.run.mockResolvedValue({ outcome, headSha: initial, unresolvedCount: outcome === 'limit' ? 1 : 0,
      ...(outcome === 'skipped' ? { skipReason: 'review_skipped' } : {}) });
    mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 })
      .mockResolvedValue({ ...options().prExecutionContext,
        number: changed === 'identity' ? 456 : 123, headSha: changed === 'head' ? updated : initial });
    expect(await cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123))
      .toMatchObject({ success: false, failed: true });
    expect(record).not.toHaveBeenCalled();
  });
  it.each(['success', 'skipped', 'limit'] as const)('fails the effect when recording a no-push %s fails', async (outcome) => {
    const record = vi.fn(() => { throw new Error('Storage failed'); });
    mocks.run.mockResolvedValue({ outcome, headSha: initial, unresolvedCount: outcome === 'limit' ? 1 : 0,
      ...(outcome === 'skipped' ? { skipReason: 'review_skipped' } : {}) });
    expect(await cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123))
      .toMatchObject({ success: false, failed: true });
    expect(record).toHaveBeenCalledExactlyOnceWith(initial, initial, options().prExecutionContext);
  });
  it('keeps the previous remote head recorded at push after a successful review', async () => {
    const record = vi.fn();
    mocks.run.mockImplementation(async (input) => {
      if (input.entry === 'linked') input.onPushedHead?.(updated);
      return { outcome: 'success', headSha: updated, unresolvedCount: 0 };
    });
    mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 })
      .mockResolvedValue({ ...options().prExecutionContext, number: 123, headSha: updated, sameRepository: true });
    let merged = false;
    mocks.git.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'merge') merged = true;
      return { stdout: args[0] === 'symbolic-ref' ? 'feature'
        : args[1] === 'FETCH_HEAD' || merged ? updated : initial, stderr: '' };
    });
    expect(await cacciaEffect({ ...options(), prMergePushRecorder: { record } }, 123))
      .toMatchObject({ success: true, headSha: updated });
    expect(record).toHaveBeenCalledExactlyOnceWith(updated, initial, options().prExecutionContext);
  });
  it('stops when persisting a successful push fails', async () => {
    const record = vi.fn(() => { throw new Error('Storage failed'); });
    const reviewed = vi.fn();
    mocks.run.mockImplementation(async (input) => {
      if (input.entry === 'linked') input.onPushedHead?.(updated);
      reviewed();
      return { outcome: 'success', headSha: updated, unresolvedCount: 0 };
    });
    const input = { ...options(), prMergePushRecorder: { record } };
    expect(await cacciaEffect(input, 123)).toMatchObject({ success: false, failed: true });
    expect(record).toHaveBeenCalledOnce();
    expect(reviewed).not.toHaveBeenCalled();
    expect(input.prGitOperations!.fetch).not.toHaveBeenCalled();
  });
  it('rejects a rate-limit result reporting a head that Caccia did not push', async () => {
    mocks.run.mockResolvedValue({ outcome: 'skipped', unresolvedCount: 0,
      headSha: updated, skipReason: 'review_rate_limited', reason: 'rate limit' });
    mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 })
      .mockResolvedValue({ ...options().prExecutionContext, number: 123, headSha: updated });
    const input = options();
    expect(await cacciaEffect(input, 123)).toMatchObject({ failed: true });
    expect(input.prGitOperations!.fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])('preserves fork inspection and sanitizes rejection after Caccia pushes: %s', async (passed) => {
    mocks.run.mockImplementation(async (input) => {
      if (input.entry === 'linked') input.onPushedHead?.(updated);
      return { outcome: 'success', unresolvedCount: 0, headSha: updated };
    });
    mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 })
      .mockResolvedValue({ ...options().prExecutionContext, number: 123, headSha: updated, sameRepository: false });
    let merged = false;
    mocks.git.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'merge') merged = true;
      return { stdout: args[0] === 'symbolic-ref' ? 'feature'
        : args[1] === 'FETCH_HEAD' || merged ? updated : initial, stderr: '' };
    });
    mocks.threat.mockResolvedValue(passed ? { passed: true }
      : { passed: false, comment: '危険な定義: .github/workflows/@org/team' });
    mocks.comment.mockReturnValue({ success: true });
    const input = options();
    expect(await cacciaEffect({ ...input,
      prExecutionContext: { ...input.prExecutionContext!, threatCheckMaxDiffBytes: 1234 } }, 123))
      .toMatchObject(passed ? { success: true, headSha: updated } : { success: false, failed: true });
    expect(mocks.threat).toHaveBeenCalledWith(expect.objectContaining({ maxDiffBytes: 1234 }));
    if (!passed) {
      expect(mocks.comment).toHaveBeenCalledWith(123,
        '危険な定義: .github/workflows/＠org/team', '/project');
      expect(mocks.comment.mock.calls[0]![1]).not.toContain('@');
    }
  });
  it('rejects a changed fetch head before updating the surviving clone', async () => {
    mocks.run.mockImplementation(async (input) => {
      if (input.entry === 'linked') input.onPushedHead?.(updated);
      return { outcome: 'success', unresolvedCount: 0, headSha: updated };
    });
    mocks.details.mockResolvedValueOnce({ ...options().prExecutionContext, number: 123 })
      .mockResolvedValue({ ...options().prExecutionContext, number: 123, headSha: updated });
    const input = options();
    expect(await cacciaEffect(input, 123)).toMatchObject({ failed: true });
    expect(input.prGitOperations!.fetch).toHaveBeenCalledWith('origin', 'refs/heads/feature');
    expect(mocks.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
  });
});
