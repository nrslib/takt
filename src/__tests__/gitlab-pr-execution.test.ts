import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn(), kill: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, execFileSync: mocks.sync }));

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const origin = 'https://gitlab.example/org/repo.git';
function mr(overrides: Record<string, unknown> = {}) {
  return { iid: 123, project_id: 1, source_project_id: 1, target_project_id: 1,
    source_branch: 'feature/pr', target_branch: 'main', sha: head, state: 'opened',
    detailed_merge_status: 'mergeable', head_pipeline: { sha: head, status: 'success', project_id: 1, ref: 'feature/pr', source: 'push' },
    author: { username: 'alice' }, description: null, labels: ['ready'], draft: false, updated_at: '2026-10-16T00:00:00Z',
    ...overrides };
}

describe('GitLab PR execution adapter', () => {
  const provider = new GitLabProvider();
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      const output = command === 'git' ? origin : args[0] === 'config' ? '' : JSON.stringify(mr());
      queueMicrotask(() => callback(null, output));
      return { kill: mocks.kill };
    });
    mocks.sync.mockImplementation((command, args) => command === 'git' ? origin : args[0] === 'config' ? '' : JSON.stringify(mr()));
  });
  afterEach(() => vi.useRealTimers());

  it('SCN-CODE-NEW-src-features-merge-index-L68-P1: 現在headの成功を返す', async () => {
    expect(await provider.fetchPrStatus(123, '/project')).toMatchObject({ number: 123, headSha: head,
      ci: { finished: true, passed: true }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', merged: false });
    expect(mocks.exec.mock.calls[2]?.slice(0, 3)).toMatchObject(['glab', ['api', '--hostname', 'gitlab.example',
      'projects/org%2Frepo/merge_requests/123'], { cwd: '/project' }]);
  });

  it.each([
    ['running', false, false], ['pending', false, false], ['created', false, false],
    ['waiting_for_resource', false, false], ['preparing', false, false], ['waiting_for_callback', false, false],
    ['manual', false, false], ['scheduled', false, false], ['canceling', false, false],
    ['success', true, true], ['failed', true, false], ['canceled', true, false], ['skipped', true, false],
  ])('pipelineの%sを正規化する', async (status, finished, passed) => {
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      queueMicrotask(() => callback(null, command === 'git' ? origin
        : args[0] === 'config' ? '' : JSON.stringify(mr({ head_pipeline: { ...mr().head_pipeline, status } }))));
      return { kill: mocks.kill };
    });
    expect((await provider.fetchPrStatus(123, '/project')).ci).toEqual({ finished, passed });
  });

  it.each([null, { ...mr().head_pipeline, sha: old }, { ...mr().head_pipeline, project_id: 9 }])(
    'SCN-CODE-NEW-src-features-merge-index-L68-N1: 未作成・古いhead・別projectを成功にしない: %j', async (pipeline) => {
      mocks.exec.mockImplementation((command, args, _options, callback) => {
        queueMicrotask(() => callback(null, command === 'git' ? origin : args[0] === 'config' ? '' : JSON.stringify(mr({ head_pipeline: pipeline }))));
        return { kill: mocks.kill };
      });
      expect((await provider.fetchPrStatus(123, '/project')).ci).toEqual({ finished: false, passed: false });
    });

  it.each([head, old])('統合結果pipelineは第2親が現在source headである場合だけ採用する: %s', async (sourceHead) => {
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      const output = command === 'git' ? origin : args[0] === 'config' ? '' : args.at(-1).includes('/repository/commits/')
        ? JSON.stringify({ id: merge, parent_ids: ['d'.repeat(40), sourceHead] })
        : JSON.stringify(mr({ head_pipeline: { ...mr().head_pipeline, sha: merge,
          source: 'merge_request_event', ref: 'refs/merge-requests/123/merge' } }));
      queueMicrotask(() => callback(null, output));
      return { kill: mocks.kill };
    });
    expect(await provider.fetchPrStatus(123, '/project')).toMatchObject({ headSha: head,
      ci: { finished: sourceHead === head, passed: sourceHead === head } });
    expect(mocks.exec.mock.calls[3]?.[1]).toEqual(['api', '--hostname', 'gitlab.example', `projects/1/repository/commits/${merge}`]);
  });

  it.each([{ iid: 124 }, { sha: 'invalid' }, { source_project_id: undefined }, { head_pipeline: {} }])(
    '壊れた応答を拒否する: %j', async (changed) => {
      mocks.exec.mockImplementation((command, args, _options, callback) => {
        queueMicrotask(() => callback(null, command === 'git' ? origin : args[0] === 'config' ? '' : JSON.stringify(mr(changed))));
        return { kill: mocks.kill };
      });
      await expect(provider.fetchPrStatus(123, '/project')).rejects.toThrow();
    });

  it('認証・通信失敗を成功へ変換しない', async () => {
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      queueMicrotask(() => callback(command === 'git' || args[0] === 'config' ? null : new Error('authentication failed'), command === 'git' ? origin : ''));
      return { kill: mocks.kill };
    });
    await expect(provider.fetchPrStatus(123, '/project')).rejects.toThrow();
  });

  it.each((['timeout', 'abort'] as const).flatMap((mode) =>
    (['config', 'api'] as const).map((stage) => ({ mode, stage }))))(
    '$stageの$mode時はkill後の終了callbackまで取得を完了しない', async ({ mode, stage }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const callbacks: Array<(error: Error | null, output: string) => void> = [];
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback);
      return { kill: mocks.kill };
    });
    const settled = vi.fn();
    const request = provider.fetchPrStatus(123, '/project', { timeoutMs: 20, signal: controller.signal });
    void request.then(settled, settled);
    callbacks[0]!(null, origin);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.exec.mock.calls[1]?.[1]).toEqual(['config', 'get', 'subfolder', '--host', 'gitlab.example']);
    await vi.advanceTimersByTimeAsync(5);
    if (stage === 'api') {
      callbacks[1]!(null, '');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.exec.mock.calls[2]?.[1][0]).toBe('api');
    }
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(15);
    else controller.abort();
    const assertion = mode === 'timeout' ? expect(request).rejects.toBeInstanceOf(PrStatusTimeoutError)
      : expect(request).rejects.toBe(controller.signal.reason);
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(settled).not.toHaveBeenCalled();
    callbacks[stage === 'config' ? 1 : 2]!(null, stage === 'config' ? 'gitlab' : JSON.stringify(mr()));
    await assertion;
    expect(mocks.exec).toHaveBeenCalledTimes(stage === 'config' ? 2 : 3);
  });

  it('中断済みsignalでは子プロセスを開始しない', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.fetchPrStatus(123, '/project', { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  function detailResponses(remote: string, sourceProject: number | null = 2, subfolder = '',
    targetPath = 'org/repo', sourcePath = 'alice/nested/repo', pushUrls = remote) {
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      const endpoint: string = args.at(-1);
      const output = command === 'git' ? args.includes('--push') ? pushUrls : remote
        : args[0] === 'config' ? subfolder : endpoint.endsWith('/merge_requests/123')
        ? JSON.stringify(mr({ source_project_id: sourceProject }))
        : JSON.stringify(endpoint === 'projects/1' ? { id: 1, path_with_namespace: targetPath }
          : { id: 2, path_with_namespace: sourcePath });
      queueMicrotask(() => callback(null, output));
      return { kill: mocks.kill };
    });
  }
  it.each([
    [origin, 'https://gitlab.example/alice/nested/repo.git'],
    ['git@gitlab.example:org/repo.git', 'git@gitlab.example:alice/nested/repo.git'],
    ['ssh://git@gitlab.example:2222/org/repo.git', 'ssh://git@gitlab.example:2222/alice/nested/repo.git'],
    ['https://user@gitlab.example/org/repo.git', 'https://user@gitlab.example/alice/nested/repo.git'],
  ])('forkのsource projectとGit transportを保持する: %s', async (remote, expectedUrl) => {
    detailResponses(remote);
    expect(await provider.fetchPrDetails(123, '/project')).toEqual({ number: 123, headBranch: 'feature/pr', baseBranch: 'main',
      headSha: head, headRepositoryUrl: expectedUrl, headRepositoryPushUrls: [expectedUrl], sameRepository: false });
  });
  it('同一projectでは設定済みのoriginと複数push先を保持する', async () => {
    detailResponses(origin, 1);
    const implementation = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((command, args, options, callback) => {
      if (command === 'git' && args.includes('--push')) {
        queueMicrotask(() => callback(null, `${origin}\ngit@gitlab.example:org/repo.git`));
        return { kill: mocks.kill };
      }
      return implementation(command, args, options, callback);
    });
    expect(await provider.fetchPrDetails(123, '/project')).toMatchObject({ sameRepository: true, headRepositoryUrl: origin,
      headRepositoryPushUrls: [origin, 'git@gitlab.example:org/repo.git'] });
  });
  it('source projectが削除済みならbase repositoryで代用しない', async () => {
    detailResponses(origin, null);
    await expect(provider.fetchPrDetails(123, '/project')).rejects.toThrow();
    expect(mocks.exec).toHaveBeenCalledTimes(3);
  });

  it('open MRの全ページを作成順で取得する', () => {
    mocks.sync.mockImplementation((command, args) => command === 'git' ? origin
      : args[0] === 'config' ? '' : JSON.stringify(args.at(-1).endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => ({ iid: index + 1 })) : [{ iid: 123 }]));
    expect(provider.listOpenPrNumbers('/project')).toEqual([...Array.from({ length: 100 }, (_, index) => index + 1), 123]);
    expect(mocks.sync.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'gitlab.example',
      'projects/org%2Frepo/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100&page=1']);
    expect(mocks.sync.mock.calls[3]?.[1].at(-1)).toContain('page=2');
  });
  it.each(['opened', 'closed', 'merged'])('詳細取得時の%sを選定へ返す', (state) => {
    mocks.sync.mockImplementation((command, args) => command === 'git' ? origin : args[0] === 'config' ? '' : JSON.stringify(mr({ state })));
    expect(provider.fetchPrListItem(123, '/project')).toEqual(state === 'opened'
      ? { number: 123, author: 'alice', base_branch: 'main', head_branch: 'feature/pr', managed_by_takt: false,
        labels: ['ready'], same_repository: true, draft: false, updated_at: '2026-10-16T00:00:00Z' } : undefined);
  });

  it.each(['gitlab', ''])('同じHTTPS remoteの詳細取得は配置設定%jに従う', async (subfolder) => {
    const remote = 'https://gitlab.example/gitlab/group/project.git';
    const projectPath = subfolder === '' ? 'gitlab/group/project' : 'group/project';
    detailResponses(remote, 2, subfolder, projectPath, 'alice/project');
    expect(await provider.fetchPrDetails(123, '/project')).toMatchObject({ number: 123, headSha: head,
      headRepositoryUrl: `https://gitlab.example/${subfolder === '' ? '' : 'gitlab/'}alice/project.git`,
      headRepositoryPushUrls: [`https://gitlab.example/${subfolder === '' ? '' : 'gitlab/'}alice/project.git`],
      sameRepository: false });
    expect(mocks.exec).toHaveBeenCalledWith('glab', ['api', '--hostname', 'gitlab.example',
      `projects/${encodeURIComponent(projectPath)}/merge_requests/123`], expect.objectContaining({ cwd: '/project' }), expect.any(Function));
  });

  it.each([
    ['SCN-CODE-NEW-src-infra-gitlab-pr-execution-L93-P1', 'https://gitlab.example/apps/gitlab/group/project.git',
      '/apps/gitlab/', 'group/project', 'alice/project', 'https://gitlab.example/apps/gitlab/alice/project.git'],
    ['namespace内の同名パス', 'http://gitlab.example/gitlab/group/gitlab/project.git',
      'gitlab', 'group/gitlab/project', 'alice/gitlab/project', 'http://gitlab.example/gitlab/alice/gitlab/project.git'],
    ['完全なパス要素だけを除去', 'https://gitlab.example/gitlab-team/project.git',
      'gitlab', 'gitlab-team/project', 'alice/project', 'https://gitlab.example/alice/project.git'],
    ['SCN-CODE-NEW-src-infra-gitlab-pr-execution-L93-N1', 'git@gitlab.example:gitlab/group/project.git',
      'gitlab', 'gitlab/group/project', 'gitlab/alice/project', 'git@gitlab.example:gitlab/alice/project.git'],
    ['SSH URLのnamespace', 'ssh://git@gitlab.example:2222/gitlab/group/project.git',
      'gitlab', 'gitlab/group/project', 'gitlab/alice/project', 'ssh://git@gitlab.example:2222/gitlab/alice/project.git'],
  ])('%s: 配置とnamespaceを区別してfork URLを返す', async (_scenario, remote, subfolder, target, source, expected) => {
    detailResponses(remote, 2, subfolder, target, source);
    expect(await provider.fetchPrDetails(123, '/project')).toMatchObject({ headRepositoryUrl: expected,
      headRepositoryPushUrls: [expected], sameRepository: false });
    const apiCalls = mocks.exec.mock.calls.filter(([command, args]) => command === 'glab' && args[0] === 'api');
    expect(apiCalls[0]?.[1]).toEqual(['api', '--hostname', 'gitlab.example',
      `projects/${encodeURIComponent(target)}/merge_requests/123`]);
    if (remote.startsWith('git@') || remote.startsWith('ssh:')) {
      expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === 'config')).toEqual([]);
    }
  });

  it.each([false, true])('配置ありのHTTPS・SSH混在push先を保持する: 同一project=%s', async (sameProject) => {
    const remote = 'https://gitlab.example/apps/gitlab/group/project.git';
    const pushes = ['https://user@gitlab.example/apps/gitlab/group/project.git',
      'git@gitlab.example:group/project.git', 'ssh://git@gitlab.example:2222/group/project.git'];
    detailResponses(remote, sameProject ? 1 : 2, '/apps/gitlab/', 'group/project', 'alice/project', pushes.join('\n'));
    expect(await provider.fetchPrDetails(123, '/project')).toMatchObject({ sameRepository: sameProject,
      headRepositoryUrl: sameProject ? remote : 'https://gitlab.example/apps/gitlab/alice/project.git',
      headRepositoryPushUrls: sameProject ? pushes : ['https://user@gitlab.example/apps/gitlab/alice/project.git',
        'git@gitlab.example:alice/project.git', 'ssh://git@gitlab.example:2222/alice/project.git'] });
  });

  it('配置を除いたproject pathが応答と違えば詳細を返さない', async () => {
    detailResponses('https://gitlab.example/gitlab/group/project.git', 2, 'gitlab', 'other/project', 'alice/project');
    await expect(provider.fetchPrDetails(123, '/project')).rejects.toThrow();
    expect(mocks.exec.mock.calls.some(([command, args]) => command === 'git' && args.includes('--push'))).toBe(false);
  });

  it.each(['gitlab', ''])('同じHTTPS remoteの状態取得は配置設定%jに従う', async (subfolder) => {
    mocks.exec.mockImplementation((command, args, _options, callback) => {
      const output = command === 'git' ? 'https://gitlab.example/gitlab/group/project.git'
        : args[0] === 'config' ? subfolder : JSON.stringify(mr());
      queueMicrotask(() => callback(null, output));
      return { kill: mocks.kill };
    });
    expect(await provider.fetchPrStatus(123, '/project')).toMatchObject({ number: 123, headSha: head,
      ci: { finished: true, passed: true } });
    expect(mocks.exec.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'gitlab.example',
      `projects/${subfolder === '' ? 'gitlab%2F' : ''}group%2Fproject/merge_requests/123`]);
  });

  it.each(['gitlab', ''].flatMap((subfolder) => [99, 100].map((count) => ({ subfolder, count }))))(
    '一覧の全ページで配置設定$subfolderを分離し$count件のページ境界を守る', ({ subfolder, count }) => {
      const firstPage = Array.from({ length: count }, (_, index) => ({ iid: index + 1 }));
      mocks.sync.mockImplementation((command, args) => command === 'git' ? 'https://gitlab.example/gitlab/group/project.git'
        : args[0] === 'config' ? subfolder : JSON.stringify(args.at(-1).endsWith('page=1') ? firstPage : [{ iid: 123 }]));
      expect(provider.listOpenPrNumbers('/project')).toEqual([...firstPage.map(({ iid }) => iid), ...(count === 100 ? [123] : [])]);
      const apiCalls = mocks.sync.mock.calls.filter(([command, args]) => command === 'glab' && args[0] === 'api');
      expect(apiCalls.map(([, args]) => args)).toEqual(Array.from({ length: count === 100 ? 2 : 1 }, (_, index) =>
        ['api', '--hostname', 'gitlab.example', `projects/${subfolder === '' ? 'gitlab%2F' : ''}group%2Fproject/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100&page=${index + 1}`]));
      expect(mocks.sync.mock.calls.filter(([, args]) => args[0] === 'config').map(([, args]) => args))
        .toEqual([['config', 'get', 'subfolder', '--host', 'gitlab.example']]);
    });

  it.each(['gitlab', ''].flatMap((subfolder) => ['opened', 'closed'].map((state) => ({ subfolder, state }))))(
    '選定の詳細取得で配置設定$subfolderを分離し$stateを扱う', ({ subfolder, state }) => {
      mocks.sync.mockImplementation((command, args) => command === 'git' ? 'https://gitlab.example/gitlab/group/project.git'
        : args[0] === 'config' ? subfolder : JSON.stringify(mr({ state })));
      expect(provider.fetchPrListItem(123, '/project')).toEqual(state === 'opened'
        ? { number: 123, author: 'alice', base_branch: 'main', head_branch: 'feature/pr', managed_by_takt: false,
          labels: ['ready'], same_repository: true, draft: false, updated_at: '2026-10-16T00:00:00Z' } : undefined);
      expect(mocks.sync.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'gitlab.example',
        `projects/${subfolder === '' ? 'gitlab%2F' : ''}group%2Fproject/merge_requests/123`]);
    });

  it.each(['details', 'status', 'numbers', 'listItem'] as const)('%sでは設定取得失敗を伝播してAPIを開始しない', async (operation) => {
    const failure = new Error('config unavailable');
    mocks.exec.mockImplementation((command, _args, _options, callback) => {
      queueMicrotask(() => callback(command === 'glab' ? failure : null, command === 'git' ? origin : ''));
      return { kill: mocks.kill };
    });
    mocks.sync.mockImplementation((command) => {
      if (command === 'glab') throw failure;
      return origin;
    });
    if (operation === 'details') await expect(provider.fetchPrDetails(123, '/project')).rejects.toBe(failure);
    else if (operation === 'status') await expect(provider.fetchPrStatus(123, '/project')).rejects.toBe(failure);
    else if (operation === 'numbers') expect(() => provider.listOpenPrNumbers('/project')).toThrow(failure);
    else expect(() => provider.fetchPrListItem(123, '/project')).toThrow(failure);
    const calls = [...mocks.exec.mock.calls, ...mocks.sync.mock.calls];
    expect(calls.filter(([command]) => command === 'glab').map(([, args]) => args))
      .toEqual([['config', 'get', 'subfolder', '--host', 'gitlab.example']]);
  });
});
