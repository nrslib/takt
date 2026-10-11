import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrStatus } from '../infra/github/pr.js';

const { response, execFile, checkGhCli } = vi.hoisted(() => ({ response: vi.fn(), execFile: vi.fn(), checkGhCli: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), execFile }));
vi.mock('../infra/github/issue.js', () => ({ checkGhCli }));

function status(checks: unknown, overrides: Record<string, unknown> = {}) {
  return { number: 123, headRefOid: 'a'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: checks, ...overrides };
}

function check(statusValue: string, conclusion: string) {
  return { __typename: 'CheckRun', name: 'unit', status: statusValue, conclusion,
    detailsUrl: 'https://github.com/org/repo/actions/runs/1', startedAt: '2026-10-05T12:00:00Z',
    completedAt: statusValue === 'COMPLETED' ? '2026-10-05T12:01:00Z' : null };
}

describe('PR status acquisition', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    checkGhCli.mockReturnValue({ available: true });
    execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => {
        try { callback(null, response(), ''); }
        catch (error) { callback(error, '', ''); }
      });
      return { kill: vi.fn() };
    });
  });

  it('指定PRの現在head・CI結果・マージ可否・承認状況を取得する', async () => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS')])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ headSha: 'a'.repeat(40),
      ci: { finished: true, passed: true }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED', merged: false });
    expect(execFile.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['pr', 'view', '123']));
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({ cwd: '/project' });
    expect(checkGhCli).not.toHaveBeenCalled();
  });

  it.each(['QUEUED', 'IN_PROGRESS'])('CIが%sなら決着・成功扱いにしない', async (running) => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS'), check(running, '')])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ ci: { finished: false, passed: false } });
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'])('CIの結論%sを成功扱いしない', async (conclusion) => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', conclusion)])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ ci: { finished: true, passed: false } });
  });

  it('従来のStatusContextが未決着ならCheckRun成功だけでマージ可能にしない', async () => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS'),
      { __typename: 'StatusContext', context: 'external-ci', state: 'PENDING', targetUrl: 'https://ci.example.test/1' }])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ ci: { finished: false, passed: false } });
  });

  it('従来のStatusContext失敗を成功扱いしない', async () => {
    response.mockReturnValue(JSON.stringify(status([
      { __typename: 'StatusContext', context: 'external-ci', state: 'FAILURE', targetUrl: 'https://ci.example.test/1' }])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ ci: { finished: true, passed: false } });
  });

  it('同じ取得APIでhead変更後のCIを再取得し古いheadの成功を保持しない', async () => {
    response.mockReturnValueOnce(JSON.stringify(status([check('COMPLETED', 'SUCCESS')])))
      .mockReturnValueOnce(JSON.stringify(status([check('IN_PROGRESS', '')], { headRefOid: 'b'.repeat(40) })))
      .mockReturnValueOnce(JSON.stringify(status([check('COMPLETED', 'SUCCESS')], { headRefOid: 'b'.repeat(40) })));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ headSha: 'a'.repeat(40), ci: { passed: true } });
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ headSha: 'b'.repeat(40), ci: { finished: false, passed: false } });
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ headSha: 'b'.repeat(40), ci: { finished: true, passed: true } });
    expect(response).toHaveBeenCalledTimes(3);
  });

  it('マージ未確定とレビュー未承認の値を保持する', async () => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS')],
      { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'CHANGES_REQUESTED' })));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN', reviewDecision: 'CHANGES_REQUESTED' });
  });

  it('外部取得失敗をCI成功へ変換しない', async () => {
    response.mockImplementationOnce(() => { throw new Error('gh failed'); });
    await expect(fetchPrStatus(123, '/project')).rejects.toThrow();
    expect(response).toHaveBeenCalled();
  });

  it('CI状態が欠損している応答を成功扱いしない', async () => {
    const raw = status(undefined);
    response.mockReturnValue(JSON.stringify(raw));
    await expect(fetchPrStatus(123, '/project')).rejects.toThrow();
    expect(response).toHaveBeenCalled();
  });

  it('空のCI一覧は未決着として保持し成功扱いしない', async () => {
    response.mockReturnValue(JSON.stringify(status([])));
    expect(await fetchPrStatus(123, '/project')).toMatchObject({ ci: { finished: false, passed: false } });
  });
});
