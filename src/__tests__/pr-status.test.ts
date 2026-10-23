import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrStatus } from '../infra/github/pr.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import type { PrCiFailure } from '../core/workflow/system/pr-ci.js';
import { parseGitHubPullRequestTarget } from '../infra/github/pull-request-target.js';

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
        try { callback(null, response(_args), ''); }
        catch (error) { callback(error, '', ''); }
      });
      return { kill: vi.fn() };
    });
  });

  it.each(['github.com', 'ghe.example.test'])('keeps %s PR and Actions targets through investigation, rerun and polling', async (hostname) => {
    const target = parseGitHubPullRequestTarget(`https://${hostname}/acme/target/pull/123`);
    const runUrl = `https://${hostname}/acme/target/actions/runs/10`;
    const headSha = 'a'.repeat(40);
    let rerun = false;
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([
        { ...check('COMPLETED', rerun ? 'SUCCESS' : 'FAILURE'), detailsUrl: runUrl + '/job/20' },
      ], { url: target.url }));
      if (args[1] === 'rerun') { rerun = true; return ''; }
      if (args.includes('--log-failed')) return 'failed job log';
      return JSON.stringify({ databaseId: 10, url: runUrl, headSha, attempt: rerun ? 2 : 1,
        status: 'completed', conclusion: rerun ? 'success' : 'failure', jobs: [{ databaseId: 20,
          name: 'unit', url: runUrl + '/job/20', status: 'completed', conclusion: 'failure' }] });
    });
    const provider = new GitHubProvider(target);
    const evidence = await provider.fetchPrCiFailure(123, headSha, '/source');
    expect(evidence).toMatchObject({ complete: true, checks: [{ jobs: [{ log: 'failed job log' }] }] });
    const accepted = await provider.rerunPrCi(evidence, '/source');
    expect(accepted).toMatchObject({ success: true });
    expect(await provider.fetchPrStatus(123, '/source', { rerun: accepted })).toMatchObject({ ci: { finished: true, passed: true } });
    for (const [, args] of execFile.mock.calls) {
      if (args[0] === 'pr') expect(args[2]).toBe(target.url);
      else expect(args.slice(-2)).toEqual(['--repo', `${hostname}/acme/target`]);
    }
  });

  it('uses the published repository for superseded Actions run acquisition', async () => {
    const target = parseGitHubPullRequestTarget('https://ghe.example.test/acme/target/pull/123');
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([10, 11].map((id) => ({
        ...check('COMPLETED', id === 10 ? 'CANCELLED' : 'SUCCESS'), workflowName: 'CI',
        detailsUrl: `https://ghe.example.test/acme/target/actions/runs/${id}/job/${id + 10}`,
      })), { url: target.url }));
      const id = Number(args[2]);
      return JSON.stringify({ databaseId: id, url: `https://ghe.example.test/acme/target/actions/runs/${id}`,
        headSha: 'a'.repeat(40), workflowDatabaseId: 100,
        createdAt: id === 10 ? '2026-10-05T12:00:00Z' : '2026-10-05T12:01:00Z',
        status: 'completed', conclusion: id === 10 ? 'cancelled' : 'success' });
    });
    expect(await new GitHubProvider(target).fetchPrStatus(123, '/source')).toMatchObject({ ci: { passed: true } });
    for (const [, args] of execFile.mock.calls.filter(([, args]) => args[0] === 'run')) {
      expect(args.slice(-2)).toEqual(['--repo', 'ghe.example.test/acme/target']);
    }
  });

  it('keeps the published Actions repository and rejects another repository in a check reference', async () => {
    const target = parseGitHubPullRequestTarget('https://ghe.example.test/acme/target/pull/123');
    const headSha = 'a'.repeat(40);
    response.mockImplementation((args: string[]) => args[0] === 'pr'
      ? JSON.stringify(status([{ ...check('COMPLETED', 'FAILURE'),
        detailsUrl: 'https://other.example.test/acme/source/actions/runs/10/job/20' }], { url: target.url }))
      : JSON.stringify({ databaseId: 10, url: 'https://ghe.example.test/acme/target/actions/runs/10',
        headSha, attempt: 1, status: 'completed', conclusion: 'failure', jobs: [] }));
    const result = await new GitHubProvider(target).fetchPrCiFailure(123, headSha, '/source');
    expect(result).toMatchObject({ complete: false, checks: [], unavailable: [
      { reason: 'Actions run repository does not match the failed check' },
    ] });
    const runs = execFile.mock.calls.filter(([, args]) => args[0] === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.[1].slice(-2)).toEqual(['--repo', 'ghe.example.test/acme/target']);
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

  it.each([
    { oldConclusion: 'cancelled', latestConclusion: 'success', latestStatus: 'completed', latestHead: 'a'.repeat(40), workflowId: 100, passed: true, finished: true, superseded: true },
    { oldConclusion: 'cancelled', latestConclusion: 'failure', latestStatus: 'completed', latestHead: 'a'.repeat(40), workflowId: 100, passed: false, finished: true, superseded: true },
    { oldConclusion: 'success', latestConclusion: 'cancelled', latestStatus: 'completed', latestHead: 'a'.repeat(40), workflowId: 100, passed: false, finished: true, superseded: true },
    { oldConclusion: 'cancelled', latestConclusion: null, latestStatus: 'in_progress', latestHead: 'a'.repeat(40), workflowId: 100, passed: false, finished: false, superseded: true },
    { oldConclusion: 'cancelled', latestConclusion: 'success', latestStatus: 'completed', latestHead: 'b'.repeat(40), workflowId: 100, passed: false, finished: true, superseded: false },
    { oldConclusion: 'cancelled', latestConclusion: 'success', latestStatus: 'completed', latestHead: 'a'.repeat(40), workflowId: 200, passed: false, finished: true, superseded: false },
  ])('同名jobを保持しつつ同一workflow・HEADの後続runだけを採用する: $oldConclusion/$latestConclusion/$latestStatus/$workflowId', async ({
    oldConclusion, latestConclusion, latestStatus, latestHead, workflowId, passed, finished, superseded,
  }) => {
    const old = (job: number) => ({ ...check('COMPLETED', oldConclusion.toUpperCase()), workflowName: 'CI',
      detailsUrl: `https://github.com/org/repo/actions/runs/10/job/${job}` });
    const latest = (job: number) => ({ ...check(latestStatus === 'completed' ? 'COMPLETED' : 'IN_PROGRESS',
      latestConclusion?.toUpperCase() ?? ''),
    workflowName: 'CI', detailsUrl: `https://github.com/org/repo/actions/runs/11/job/${job}` });
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([old(20), old(21), latest(30), latest(31)]));
      const id = Number(args[2]);
      return JSON.stringify({ databaseId: id, url: `https://github.com/org/repo/actions/runs/${id}`,
        headSha: id === 10 ? 'a'.repeat(40) : latestHead,
        workflowDatabaseId: id === 10 ? 100 : workflowId,
        createdAt: id === 10 ? '2026-10-05T12:00:00Z' : '2026-10-05T12:01:00Z',
        status: id === 10 ? 'completed' : latestStatus, conclusion: id === 10 ? oldConclusion : latestConclusion });
    });

    const result = await fetchPrStatus(123, '/project');

    expect(result.ci).toMatchObject({ finished, passed });
    expect(result.ci.checks?.map((item) => item.url)).toEqual(superseded
      ? [30, 31].map((job) => `https://github.com/org/repo/actions/runs/11/job/${job}`)
      : [20, 21, 30, 31].map((job) => `https://github.com/org/repo/actions/runs/${job < 30 ? 10 : 11}/job/${job}`));
  });

  it('後続runの同定に失敗した場合は古い失敗を成功へ変換しない', async () => {
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([10, 11].map((id) => ({
        ...check('COMPLETED', id === 10 ? 'CANCELLED' : 'SUCCESS'), workflowName: 'CI',
        detailsUrl: `https://github.com/org/repo/actions/runs/${id}/job/${id + 10}`,
      }))));
      throw new Error('Actions run details unavailable');
    });

    await expect(fetchPrStatus(123, '/project')).rejects.toThrow('Actions run details unavailable');
  });

  it('checkとrunのリポジトリが異なる場合は古い失敗を成功へ変換しない', async () => {
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([10, 11].map((id) => ({
        ...check('COMPLETED', id === 10 ? 'CANCELLED' : 'SUCCESS'), workflowName: 'CI',
        detailsUrl: `https://github.com/org/repo/actions/runs/${id}/job/${id + 10}`,
      }))));
      const id = Number(args[2]);
      return JSON.stringify({ databaseId: id, url: `https://github.com/other/repo/actions/runs/${id}`,
        headSha: 'a'.repeat(40), workflowDatabaseId: 100,
        createdAt: id === 10 ? '2026-10-05T12:00:00Z' : '2026-10-05T12:01:00Z',
        status: 'completed', conclusion: id === 10 ? 'cancelled' : 'success' });
    });

    await expect(fetchPrStatus(123, '/project')).rejects.toThrow('Actions run does not match the check reference');
  });

  it('同名でも種別と参照先を失わず各チェックの成功・失敗・未完了を渡す', async () => {
    const failedUrl = 'https://github.com/org/repo/actions/runs/10/job/20';
    response.mockReturnValue(JSON.stringify(status([
      check('COMPLETED', 'SUCCESS'),
      { ...check('COMPLETED', 'FAILURE'), detailsUrl: failedUrl },
      { __typename: 'StatusContext', context: 'unit', state: 'FAILURE', targetUrl: 'https://ci.example.test/1' },
      { ...check('IN_PROGRESS', ''), name: 'lint', detailsUrl: null },
    ])));

    expect(await fetchPrStatus(123, '/project')).toMatchObject({
      ci: { finished: false, passed: false, checks: expect.arrayContaining([
        expect.objectContaining({ kind: 'CheckRun', name: 'unit', finished: true, passed: true }),
        expect.objectContaining({ kind: 'CheckRun', name: 'unit', url: failedUrl, finished: true, passed: false }),
        expect.objectContaining({ kind: 'StatusContext', name: 'unit', url: 'https://ci.example.test/1', finished: true, passed: false }),
        expect.objectContaining({ kind: 'CheckRun', name: 'lint', url: null, finished: false, passed: false }),
      ]) },
    });
    expect(execFile).toHaveBeenCalledOnce();
  });

  function failureEvidence(): Promise<unknown> {
    const provider = new GitHubProvider();
    return provider.fetchPrCiFailure(123, 'a'.repeat(40), '/project');
  }

  function installFailureResponses(checks: unknown[], runHead = 'a'.repeat(40), log = 'math.test.ts > adds\nAssertionError: expected 2 to equal 3') {
    response.mockImplementation(() => {
      const args = execFile.mock.calls.at(-1)?.[1] as string[];
      if (args[0] === 'pr') return JSON.stringify(status(checks));
      if (args.includes('--log-failed') || args.includes('--log')) return log;
      return JSON.stringify({ databaseId: 10, url: 'https://github.com/org/repo/actions/runs/10',
        headSha: runHead, attempt: 1, status: 'completed', conclusion: 'failure', jobs: [
          { databaseId: 20, name: 'unit', url: 'https://github.com/org/repo/actions/runs/10/job/20',
            status: 'completed', conclusion: 'failure', steps: [] },
        ] });
    });
  }

  it('対象HEADの失敗チェックからrun・attempt・jobとテスト名・アサーションを取得する', async () => {
    installFailureResponses([{ ...check('COMPLETED', 'FAILURE'),
      detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/20' }]);

    const evidence = await failureEvidence();
    expect(evidence).toMatchObject({ number: 123, headSha: 'a'.repeat(40), complete: true,
      checks: [{ name: 'unit', run: { id: 10, attempt: 1, url: 'https://github.com/org/repo/actions/runs/10' },
        jobs: [{ id: 20, url: 'https://github.com/org/repo/actions/runs/10/job/20',
          log: expect.stringMatching(/math\.test\.ts > adds[\s\S]*expected 2 to equal 3/) }] }], unavailable: [] });
  });

  it('同じrunを参照する失敗チェックが複数あってもrunを重複取得しない', async () => {
    installFailureResponses(['unit', 'lint'].map((name) => ({ ...check('COMPLETED', 'FAILURE'), name,
      detailsUrl: 'https://github.com/org/repo/actions/runs/10' })));
    expect(await failureEvidence()).toMatchObject({ complete: true });
    const runReads = execFile.mock.calls.filter(([, args]) => args[0] === 'run' && args.includes('--json'));
    expect(runReads).toHaveLength(1);
    expect(execFile.mock.calls.filter(([, args]) => args.includes('--log-failed'))).toHaveLength(1);
  });

  it('成功チェックを除外し別HEAD・非Actions・参照先欠落の失敗を取得不能として残す', async () => {
    installFailureResponses([
      check('COMPLETED', 'SUCCESS'),
      { ...check('COMPLETED', 'FAILURE'), name: 'lint', detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/20' },
      { __typename: 'StatusContext', context: 'unit', state: 'FAILURE', targetUrl: 'https://ci.example.test/1' },
      { ...check('COMPLETED', 'FAILURE'), name: 'missing-url', detailsUrl: null },
    ], 'b'.repeat(40), 'FOREIGN_HEAD_LOG: expected 2 to equal 3');
    const evidence = await failureEvidence();
    expect(evidence).toMatchObject({ complete: false, checks: [],
      unavailable: expect.arrayContaining([
        expect.objectContaining({ name: 'lint', reason: expect.any(String) }),
        expect.objectContaining({ name: 'unit', reason: expect.any(String) }),
        expect.objectContaining({ name: 'missing-url', reason: expect.any(String) }),
      ]) });
    expect(JSON.stringify(evidence)).not.toContain('FOREIGN_HEAD_LOG');
    expect(execFile.mock.calls.some(([, args]) => args.includes('--log') || args.includes('--log-failed'))).toBe(false);
  });

  it.each(['', 'HTTP 403: Resource not accessible by integration'])('ログ不足%jを完全な証拠や外部要因へ変換しない', async (log) => {
    installFailureResponses([{ ...check('COMPLETED', 'FAILURE'),
      detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/20' }], 'a'.repeat(40), log);
    if (log.startsWith('HTTP')) {
      const successfulResponse = response.getMockImplementation()!;
      response.mockImplementation(() => {
        const args = execFile.mock.calls.at(-1)?.[1] as string[];
        if (args.includes('--log-failed') || args.includes('--log')) throw new Error(log);
        return successfulResponse();
      });
    }
    expect(await failureEvidence()).toMatchObject({ complete: false,
      checks: [{ name: 'unit', run: { id: 10, attempt: 1 },
        jobs: [{ id: 20, url: 'https://github.com/org/repo/actions/runs/10/job/20' }] }],
      unavailable: expect.arrayContaining([expect.objectContaining({
        url: 'https://github.com/org/repo/actions/runs/10/job/20', reason: expect.any(String),
      })]) });
  });

  it('新attempt成功で旧失敗チェックを更新し再実行対象以外の未完了・失敗は保持する', async () => {
    const provider = new GitHubProvider();
    const headSha = 'a'.repeat(40);
    const url = 'https://github.com/org/repo/actions/runs/10';
    let otherState = 'PENDING';
    response.mockImplementation(() => {
      const args = execFile.mock.calls.at(-1)?.[1] as string[];
      if (args[0] === 'pr') return JSON.stringify(status([
        { ...check('COMPLETED', 'FAILURE'), detailsUrl: url + '/job/20' },
        { __typename: 'StatusContext', context: 'deploy', state: otherState, targetUrl: 'https://ci.example.test/2' },
      ]));
      return JSON.stringify({ databaseId: 10, url, headSha, attempt: 2, status: 'completed', conclusion: 'success', jobs: [] });
    });
    const options = { rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1, url }] } };
    const pending = await provider.fetchPrStatus(123, '/project', options);
    expect(pending.ci).toMatchObject({ finished: false, passed: false,
      checks: [expect.objectContaining({ name: 'unit', finished: true, passed: true }),
        expect.objectContaining({ name: 'deploy', finished: false, passed: false })] });
    otherState = 'FAILURE';
    expect((await provider.fetchPrStatus(123, '/project', options)).ci).toMatchObject({ finished: true, passed: false });
    otherState = 'SUCCESS';
    expect((await provider.fetchPrStatus(123, '/project', options)).ci).toMatchObject({ finished: true, passed: true });
  });

  it.each([
    { workflowId: 100, latestHead: 'a'.repeat(40), latestStatus: 'completed', latestConclusion: 'success', finished: true, passed: true, oldRerunRead: false },
    { workflowId: 100, latestHead: 'a'.repeat(40), latestStatus: 'in_progress', latestConclusion: null, finished: false, passed: false, oldRerunRead: false },
    { workflowId: 200, latestHead: 'a'.repeat(40), latestStatus: 'completed', latestConclusion: 'success', finished: true, passed: false, oldRerunRead: true },
    { workflowId: 100, latestHead: 'b'.repeat(40), latestStatus: 'completed', latestConclusion: 'success', finished: true, passed: false, oldRerunRead: true },
  ])('後継runで置換済みの再実行だけを無視する: $workflowId/$latestStatus', async ({
    workflowId, latestHead, latestStatus, latestConclusion, finished, passed, oldRerunRead,
  }) => {
    const headSha = 'a'.repeat(40);
    const oldUrl = 'https://github.com/org/repo/actions/runs/10';
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([10, 11].map((id) => ({
        ...check(id === 10 || latestStatus === 'completed' ? 'COMPLETED' : 'IN_PROGRESS',
          id === 10 ? 'CANCELLED' : latestConclusion === 'success' ? 'SUCCESS' : ''),
        workflowName: 'CI', detailsUrl: `https://github.com/org/repo/actions/runs/${id}/job/${id + 10}`,
      }))));
      const id = Number(args[2]);
      if (args[4]?.includes('attempt')) return JSON.stringify({ databaseId: id, url: oldUrl,
        headSha, attempt: 2, status: 'completed', conclusion: 'failure', jobs: [] });
      return JSON.stringify({ databaseId: id, url: `https://github.com/org/repo/actions/runs/${id}`,
        headSha: id === 10 ? headSha : latestHead, workflowDatabaseId: id === 10 ? 100 : workflowId,
        createdAt: id === 10 ? '2026-10-05T12:00:00Z' : '2026-10-05T12:01:00Z',
        status: id === 10 ? 'completed' : latestStatus,
        conclusion: id === 10 ? 'failure' : latestConclusion });
    });

    const result = await fetchPrStatus(123, '/project', {
      rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1, url: oldUrl }] },
    });

    expect(result.ci).toMatchObject({ finished, passed });
    expect(execFile.mock.calls.some(([, args]) => args[0] === 'run' && args[2] === '10'
      && args[4]?.includes('attempt'))).toBe(oldRerunRead);
  });

  it.each([
    { attempt: 1, status: 'completed', conclusion: 'failure' },
    { attempt: 2, status: 'in_progress', conclusion: null },
  ])('後継runのない再実行はattempt $attempt/$statusの間待機する', async ({ attempt, status: runStatus, conclusion }) => {
    const headSha = 'a'.repeat(40);
    const url = 'https://github.com/org/repo/actions/runs/10';
    response.mockImplementation((args: string[]) => args[0] === 'pr'
      ? JSON.stringify(status([{ ...check('COMPLETED', 'FAILURE'), detailsUrl: `${url}/job/20` }]))
      : JSON.stringify({ databaseId: 10, url, headSha, attempt, status: runStatus, conclusion, jobs: [] }));

    const result = await fetchPrStatus(123, '/project', {
      rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1, url }] },
    });

    expect(result.ci).toMatchObject({ finished: false, passed: false });
    expect(execFile.mock.calls.filter(([, args]) => args[0] === 'run')).toHaveLength(1);
  });

  it.each(['success', 'failure'])('複数の再実行では置換済みrunだけを除外し残りの%sを反映する', async (conclusion) => {
    const headSha = 'a'.repeat(40);
    const runUrl = (id: number) => `https://github.com/org/repo/actions/runs/${id}`;
    response.mockImplementation((args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(status([
        { ...check('COMPLETED', 'CANCELLED'), workflowName: 'CI', detailsUrl: `${runUrl(10)}/job/20` },
        { ...check('COMPLETED', 'SUCCESS'), workflowName: 'CI', detailsUrl: `${runUrl(12)}/job/22` },
        { ...check('COMPLETED', 'FAILURE'), workflowName: 'Nix', detailsUrl: `${runUrl(11)}/job/21` },
      ]));
      const id = Number(args[2]);
      if (args[4]?.includes('attempt')) return JSON.stringify({ databaseId: id, url: runUrl(id),
        headSha, attempt: 2, status: 'completed', conclusion, jobs: [] });
      return JSON.stringify({ databaseId: id, url: runUrl(id), headSha, workflowDatabaseId: 100,
        createdAt: id === 10 ? '2026-10-05T12:00:00Z' : '2026-10-05T12:01:00Z',
        status: 'completed', conclusion: id === 10 ? 'cancelled' : 'success' });
    });

    const result = await fetchPrStatus(123, '/project', { rerun: { number: 123, headSha,
      runs: [10, 11].map((id) => ({ id, attempt: 1, url: runUrl(id) })) } });

    expect(result.ci).toMatchObject({ finished: true, passed: conclusion === 'success' });
    expect(execFile.mock.calls.filter(([, args]) => args[0] === 'run' && args[4]?.includes('attempt'))
      .map(([, args]) => args[2])).toEqual(['11']);
  });

  it('調査対象runのattemptまたはHEADが変わっていれば再実行しない', async () => {
    installFailureResponses([{ ...check('COMPLETED', 'FAILURE'),
      detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/20' }]);
    const provider = new GitHubProvider();
    const evidence = await provider.fetchPrCiFailure(123, 'a'.repeat(40), '/project');
    const changed = { ...evidence, checks: evidence.checks.map((item) => ({ ...item, run: { ...item.run, attempt: 2 } })) };
    expect(await provider.rerunPrCi(changed, '/project')).toMatchObject({ success: false });
    expect(execFile.mock.calls.filter(([, args]) => args[1] === 'rerun')).toHaveLength(0);
  });

  it('受付後のPR HEAD変更は現在のHEADを保持した失敗状態として返す', async () => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS')], { headRefOid: 'b'.repeat(40) })));
    const result = await new GitHubProvider().fetchPrStatus(123, '/project', {
      rerun: { number: 123, headSha: 'a'.repeat(40), runs: [{ id: 10, attempt: 1 }] },
    });
    expect(result).toMatchObject({ number: 123, headSha: 'b'.repeat(40),
      ci: { finished: false, passed: false, rerunHeadChange: { reason: expect.any(String) } } });
    expect(execFile.mock.calls).toHaveLength(1);
  });

  it.each([1, 2])('各再実行直前に現在PRのHEADを照合する（比較%s回目）', async () => {
    const headSha = 'b'.repeat(40);
    const changedHead = 'f'.repeat(40);
    for (const timing of ['run-validation', 'between-runs'] as const) {
      for (const changeHead of [false, true]) {
        execFile.mockClear();
        let currentHead = headSha;
        const trace: string[] = [];
        const ids = timing === 'between-runs' ? [10, 11] : [10];
        const evidence: PrCiFailure = { number: 123, headSha, complete: true, unavailable: [],
          checks: ids.map((id) => ({ name: 'unit', run: { id, attempt: 1, headSha,
            url: `https://github.com/org/repo/actions/runs/${id}` },
          jobs: [{ id: id + 10, name: 'unit', url: `https://github.com/org/repo/actions/runs/${id}/job/${id + 10}`,
            log: 'runner outage' }] })) };
        response.mockImplementation(() => {
          const args = execFile.mock.calls.at(-1)?.[1] as string[];
          trace.push(args.slice(0, 3).join(' '));
          if (args[0] === 'pr') return JSON.stringify({ number: 123, headRefOid: currentHead });
          if (args[1] === 'rerun') {
            if (changeHead && timing === 'between-runs') currentHead = changedHead;
            return '';
          }
          if (changeHead && timing === 'run-validation') currentHead = changedHead;
          const id = Number(args[2]);
          return JSON.stringify({ databaseId: id, url: `https://github.com/org/repo/actions/runs/${id}`,
            headSha, attempt: 1, status: 'completed', conclusion: 'failure', jobs: [] });
        });
        const result = await new GitHubProvider().rerunPrCi(evidence, '/project');
        const reruns = trace.filter((call) => call.startsWith('run rerun'));
        expect.soft({ timing, changeHead, reruns }).toEqual({ timing, changeHead,
          reruns: (changeHead ? timing === 'between-runs' ? [10] : [] : ids).map((id) => `run rerun ${id}`) });
        expect.soft(result).toMatchObject(changeHead
          ? { success: false, failed: true, headChanged: true, error: expect.stringContaining(changedHead) }
          : { success: true, failed: false });
        const expectedTrace = ids.map((id) => `run view ${id}`);
        for (const id of ids) {
          expectedTrace.push('pr view 123');
          if (changeHead && (timing === 'run-validation' || id === 11)) break;
          expectedTrace.push(`run rerun ${id}`);
        }
        expect.soft({ timing, changeHead, trace }).toEqual({ timing, changeHead, trace: expectedTrace });
      }
    }
  });

  it('HEAD以外の再実行対象PR不一致は状態へ変換せず拒否する', async () => {
    response.mockReturnValue(JSON.stringify(status([check('COMPLETED', 'SUCCESS')])));
    await expect(new GitHubProvider().fetchPrStatus(123, '/project', {
      rerun: { number: 456, headSha: 'a'.repeat(40), runs: [{ id: 10, attempt: 1 }] },
    })).rejects.toThrow();
  });

  it.each(['denied', 'wrong-pr', 'invalid-head'])('再実行直前のPR取得が%sなら再実行しない', async (mode) => {
    installFailureResponses([{ ...check('COMPLETED', 'FAILURE'),
      detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/20' }]);
    const provider = new GitHubProvider();
    const evidence = await provider.fetchPrCiFailure(123, 'a'.repeat(40), '/project');
    const runResponse = response.getMockImplementation()!;
    response.mockImplementation(() => {
      const args = execFile.mock.calls.at(-1)?.[1] as string[];
      if (args[0] !== 'pr') return runResponse();
      if (mode === 'denied') throw new Error('HTTP 403: PR access denied');
      return JSON.stringify({ number: mode === 'wrong-pr' ? 456 : 123,
        headRefOid: mode === 'invalid-head' ? null : evidence.headSha });
    });
    expect(await provider.rerunPrCi(evidence, '/project')).toMatchObject({ success: false, failed: true, error: expect.any(String) });
    expect(execFile.mock.calls.filter(([, args]) => args[1] === 'rerun')).toHaveLength(0);
  });

  it('複数runの一部だけ再実行を受け付けても全対象と失敗を返して再実行を繰り返さない', async () => {
    const provider = new GitHubProvider();
    const headSha = 'a'.repeat(40);
    const evidence: PrCiFailure = { number: 123, headSha, complete: true, unavailable: [],
      checks: [10, 11].map((id) => ({ name: 'unit', run: { id, attempt: 1, headSha,
        url: `https://github.com/org/repo/actions/runs/${id}` },
        jobs: [{ id: id + 10, name: 'unit', url: `https://github.com/org/repo/actions/runs/${id}/job/${id + 10}`, log: 'runner outage' }] })) };
    response.mockImplementation(() => {
      const args = execFile.mock.calls.at(-1)?.[1] as string[];
      if (args[0] === 'pr') return JSON.stringify({ number: 123, headRefOid: headSha });
      if (args[1] === 'rerun') {
        if (args[2] === '11') throw new Error('HTTP 403: rerun denied');
        return '';
      }
      const id = Number(args[2]);
      return JSON.stringify({ databaseId: id, url: `https://github.com/org/repo/actions/runs/${id}`,
        headSha, attempt: 1, status: 'completed', conclusion: 'failure', jobs: [] });
    });
    expect(await provider.rerunPrCi(evidence, '/project')).toMatchObject({ success: false,
      runs: [{ id: 10, attempt: 1 }, { id: 11, attempt: 1 }], error: expect.any(String) });
    expect(execFile.mock.calls.filter(([, args]) => args[1] === 'rerun').map(([, args]) => args))
      .toEqual([['run', 'rerun', '10', '--failed'], ['run', 'rerun', '11', '--failed']]);
  });
});
