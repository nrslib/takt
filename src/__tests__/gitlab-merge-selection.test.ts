import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import { runMerge, resolveMergeSettings } from '../features/merge/index.js';
import { selectPullRequest } from '../features/merge/selection.js';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), agent: vi.fn(), provider: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()), execFileSync: mocks.sync,
}));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));

const cwd = '/project';
const origin = 'https://gitlab.example/org/repo.git';
const mrEndpoint = 'projects/org%2Frepo/merge_requests/10';
const selectionText = 'ドキュメントのみ';
const provider = new GitLabProvider();
const executePrWorkflow = vi.fn();
const responses = new Map<string, unknown>();

function mr(number: number, overrides: Record<string, unknown> = {}) {
  return { id: 999, iid: number, project_id: 1, target_project_id: 1, source_project_id: 1,
    title: 'ガイド更新', description: '利用手順の更新', changes_count: '1',
    state: 'opened', author: { username: 'alice' }, labels: ['documentation', 'ready'],
    source_branch: `docs/guide-${number}`, target_branch: 'main', draft: false,
    updated_at: '2026-10-19T00:00:00Z', ...overrides };
}

function setFiles(count: number): string[] {
  const files = Array.from({ length: count }, (_, index) => `docs/guide-${index}.md`);
  responses.set(mrEndpoint, mr(10, { changes_count: String(count) }));
  for (let offset = 0; offset <= count; offset += 100) {
    responses.set(`${mrEndpoint}/diffs?per_page=100&page=${offset / 100 + 1}`,
      files.slice(offset, offset + 100).map((new_path) => ({ new_path })));
  }
  return files;
}

function run(onSelectionResult = vi.fn()) {
  return runMerge({ projectCwd: cwd, settings: resolveMergeSettings(undefined),
    concurrency: 1, selectionText, onSelectionResult }, {
    listOpenPrNumbers: (projectCwd) => provider.listOpenPrNumbers(projectCwd),
    fetchPrListItem: (number, projectCwd) => provider.fetchPrListItem(number, projectCwd),
    executePrWorkflow,
  });
}

describe('GitLab merge selection data', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    responses.clear();
    responses.set(mrEndpoint, mr(10));
    responses.set(`${mrEndpoint}/diffs?per_page=100&page=1`, [{ new_path: 'docs/guide.md', diff: '+PRIVATE_DIFF' }]);
    responses.set('projects/org%2Frepo/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100&page=1', [{ iid: 10 }]);
    mocks.sync.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') return origin;
      if (args[0] === 'config') return '';
      const endpoint = args.at(-1)!;
      if (!responses.has(endpoint)) throw new Error(`Unexpected API request: ${endpoint}`);
      const response = responses.get(endpoint);
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    });
    mocks.provider.mockReturnValue(provider);
    mocks.agent.mockResolvedValue({ status: 'done', structuredOutput: { selected: true, reason: '文書のみの変更' } });
    executePrWorkflow.mockResolvedValue({ merged: true });
  });

  it.each([
    ['SCN-CODE-NEW-src-features-merge-selection-L34-P1', 'docs/guide.md', '利用手順の更新'],
    ['SCN-CODE-NEW-src-features-merge-selection-L34-N1', 'src/main.ts', '利用手順の更新'],
    ['SCN-CODE-NEW-src-features-merge-selection-L34-P2', 'docs/guide.md', null],
  ])('%s: iidと明示されたフィールドだけを判断材料へ変換する', async (_scenario, path, description) => {
    responses.set(mrEndpoint, mr(10, { description }));
    responses.set(`${mrEndpoint}/diffs?per_page=100&page=1`, [{ new_path: path, diff: '+docs/guide.md' }]);
    expect(provider.fetchPrSelectionData(10, cwd)).toEqual({ number: 10, title: 'ガイド更新', body: description ?? '', files: [path] });
    const candidate = provider.fetchPrListItem(10, cwd)!;
    expect(await selectPullRequest(candidate, selectionText, cwd, provider))
      .toEqual({ number: 10, selected: true, reason: '文書のみの変更' });
    const prompt: string = mocks.agent.mock.calls[0]![1];
    expect(JSON.parse(prompt.slice(prompt.indexOf('{')))).toEqual({
      selectionText, title: 'ガイド更新', body: description ?? '', labels: ['documentation', 'ready'],
      headBranch: 'docs/guide-10', baseBranch: 'main', files: [path],
    });
  });

  it.each([0, 99, 100, 101])('%s件のパスをページ終端まで取得する', (count) => {
    const files = setFiles(count);
    expect(provider.fetchPrSelectionData(10, cwd).files).toEqual(files);
    const apiCalls = mocks.sync.mock.calls.filter(([command, args]) => command === 'glab' && args[0] === 'api');
    expect(apiCalls.map(([, args]) => args)).toEqual([
      ['api', '--hostname', 'gitlab.example', mrEndpoint],
      ...Array.from({ length: Math.floor(count / 100) + 1 }, (_, index) =>
        ['api', '--hostname', 'gitlab.example', `${mrEndpoint}/diffs?per_page=100&page=${index + 1}`]),
    ]);
    for (const [, , options] of apiCalls) {
      expect(options).toMatchObject({ cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    }
  });

  it.each(['', '1000+'])('正確な件数が分からないchanges_count=%jを拒否する', async (changes_count) => {
    responses.set(mrEndpoint, mr(10, { changes_count }));
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('SCN-CODE-NEW-src-features-merge-selection-L34-N2: 別MRの応答を選別へ渡さない', async () => {
    const candidate = provider.fetchPrListItem(10, cwd)!;
    responses.set(mrEndpoint, mr(10, { iid: 11 }));
    expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow();
    await expect(selectPullRequest(candidate, selectionText, cwd, provider)).rejects.toThrow();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it.each([{ target_project_id: 2 }, { title: undefined }, { description: 42 }])(
    '不正なMR詳細%jを拒否する', (overrides) => {
      responses.set(mrEndpoint, mr(10, overrides));
      expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow();
    });

  it.each([{}, [{ diff: '+docs/guide.md' }], [{ new_path: '' }], [{ new_path: 42 }]].map((diffs) => ({ diffs })))(
    '不正なdiffs応答$diffsを正常なファイル一覧に変換しない', ({ diffs }) => {
      responses.set(`${mrEndpoint}/diffs?per_page=100&page=1`, diffs);
      expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow();
    });

  it('101件のうち2ページ目が空なら部分的な一覧を使わない', async () => {
    setFiles(101);
    responses.set(`${mrEndpoint}/diffs?per_page=100&page=2`, []);
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('重複パスで変更件数を満たしたことにしない', () => {
    setFiles(101);
    responses.set(`${mrEndpoint}/diffs?per_page=100&page=2`, [{ new_path: 'docs/guide-0.md' }]);
    expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow();
  });

  it('変更件数を超えるファイル一覧を拒否する', () => {
    responses.set(mrEndpoint, mr(10, { changes_count: '0' }));
    expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow();
  });

  it.each([mrEndpoint, `${mrEndpoint}/diffs?per_page=100&page=1`, `${mrEndpoint}/diffs?per_page=100&page=2`])(
    '%sの取得エラーを伝播する', (endpoint) => {
      setFiles(101);
      const failure = new Error('API unavailable');
      responses.set(endpoint, failure);
      expect(() => provider.fetchPrSelectionData(10, cwd)).toThrow(failure);
    });

  it.each([true, false])('GitLabの候補を全件判定し選択=%sを通知と実行対象へ反映する', async (selected) => {
    responses.set('projects/org%2Frepo/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100&page=1', [{ iid: 10 }, { iid: 11 }]);
    responses.set('projects/org%2Frepo/merge_requests/11', mr(11, { title: '実装更新' }));
    responses.set('projects/org%2Frepo/merge_requests/11/diffs?per_page=100&page=1', [{ new_path: 'src/main.ts' }]);
    mocks.agent.mockResolvedValueOnce({ status: 'done', structuredOutput: { selected, reason: '文書の判定' } })
      .mockResolvedValueOnce({ status: 'done', structuredOutput: { selected: false, reason: '実装を含む' } });
    const onSelectionResult = vi.fn();
    expect(await run(onSelectionResult)).toEqual({ processedCount: selected ? 1 : 0, mergedCount: selected ? 1 : 0, exitCode: 0 });
    expect(mocks.agent).toHaveBeenCalledTimes(2);
    expect(onSelectionResult).toHaveBeenCalledExactlyOnceWith([
      { number: 10, selected, reason: '文書の判定' }, { number: 11, selected: false, reason: '実装を含む' },
    ]);
    expect(executePrWorkflow.mock.calls.map(([request]) => request.prNumber)).toEqual(selected ? [10] : []);
    if (selected) {
      expect(executePrWorkflow.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.agent.mock.invocationCallOrder[1]!);
      expect(executePrWorkflow.mock.invocationCallOrder[0]).toBeGreaterThan(onSelectionResult.mock.invocationCallOrder[0]!);
    }
  });
});
