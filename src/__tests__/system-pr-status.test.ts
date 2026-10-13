import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

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
