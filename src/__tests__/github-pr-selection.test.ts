import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrSelectionData } from '../infra/github/pr.js';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()), execFileSync: mocks.execFileSync,
}));

function serve(options: { repository?: string; details?: Record<string, unknown>; pages?: unknown[]; failPage?: number } = {}) {
  const repository = options.repository ?? 'org/repo';
  const details = { number: 10, title: 'Guide update', body: 'Usage instructions', changed_files: 2, ...options.details };
  const pages = options.pages ?? [[{ filename: 'docs/first.md', patch: '+DIFF_NOT_FOR_SELECTION' }], [{ filename: 'docs/last.md' }]];
  const fetchedPages: number[] = [];
  mocks.execFileSync.mockImplementation((command: string, args: string[], commandOptions: { cwd: string }) => {
    expect(command).toBe('gh');
    expect(commandOptions.cwd).toBe('/project');
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: repository });
    expect(args[0]).toBe('api');
    const endpoint = args[args.length - 1];
    if (!endpoint) throw new Error(`Unexpected endpoint: ${JSON.stringify(args)}`);
    const url = new URL(endpoint, 'https://api.github.com');
    if (url.pathname === `/repos/${repository}/pulls/10`) return JSON.stringify(details);
    expect(url.pathname).toBe(`/repos/${repository}/pulls/10/files`);
    const page = Number(url.searchParams.get('page'));
    fetchedPages.push(page);
    if (options.failPage === page) throw new Error('files page failed');
    if (page < 1 || page > pages.length) throw new Error(`Unexpected page ${page}`);
    const body = JSON.stringify(pages[page - 1]);
    const link = page < pages.length
      ? `Link: <https://api.github.com/repos/${repository}/pulls/10/files?per_page=100&page=${page + 1}>; rel="next"\r\n` : '';
    return `HTTP/2.0 200 OK\r\n${link}\r\n${body}`;
  });
  return fetchedPages;
}

describe('GitHub PR selection data', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // 取得処理の欠落を異常応答の拒否成功として扱わない。
    expect(fetchPrSelectionData).toBeTypeOf('function');
  });

  it.each(['org/repo', 'team/docs'])('%sから全ページの変更パスとタイトル・本文を取得し差分本文を返さない', async (repository) => {
    const pages = serve({ repository });
    expect(await fetchPrSelectionData(10, '/project')).toEqual({
      number: 10, title: 'Guide update', body: 'Usage instructions', files: ['docs/first.md', 'docs/last.md'],
    });
    expect(pages).toEqual([1, 2]);
    const requests = mocks.execFileSync.mock.calls
      .filter(([, args]) => args[0] === 'api')
      .map(([, args]) => {
        const url = new URL(args[args.length - 1], 'https://api.github.com');
        return { pathname: url.pathname, page: url.searchParams.get('page') };
      });
    expect(requests).toEqual([
      { pathname: `/repos/${repository}/pulls/10`, page: null },
      { pathname: `/repos/${repository}/pulls/10/files`, page: '1' },
      { pathname: `/repos/${repository}/pulls/10/files`, page: '2' },
    ]);
  });

  it('本文nullを空文字へ正規化する', async () => {
    serve({ details: { body: null, changed_files: 0 }, pages: [[]] });
    expect(await fetchPrSelectionData(10, '/project')).toEqual({ number: 10, title: 'Guide update', body: '', files: [] });
  });

  it('100件を超える変更ファイルも末尾まで取得する', async () => {
    const files = Array.from({ length: 101 }, (_, index) => `docs/guide-${index}.md`);
    const pages = serve({ details: { changed_files: files.length }, pages: [
      files.slice(0, 100).map((filename) => ({ filename })),
      files.slice(100).map((filename) => ({ filename })),
    ] });
    expect(await fetchPrSelectionData(10, '/project')).toEqual({
      number: 10, title: 'Guide update', body: 'Usage instructions', files,
    });
    expect(pages).toEqual([1, 2]);
  });

  it('後続ページの失敗で部分的なファイル一覧を返さない', async () => {
    serve({ failPage: 2 });
    await expect(async () => fetchPrSelectionData(10, '/project')).rejects.toThrow();
  });

  it('ページをまたいで重複した変更パスを含む一覧を判定材料にしない', async () => {
    serve({ pages: [[{ filename: 'docs/first.md' }], [{ filename: 'docs/first.md' }]] });
    await expect(async () => fetchPrSelectionData(10, '/project')).rejects.toThrow();
  });

  it.each([null, {}, [{ filename: 12 }], [{ patch: '+missing filename' }]])('不正なファイルページ%jを空一覧として扱わない', async (page) => {
    serve({ pages: [page] });
    await expect(async () => fetchPrSelectionData(10, '/project')).rejects.toThrow();
  });

  it.each([{ number: 11 }, { title: null }, { body: 12 }, { changed_files: -1 }])('不正なPR詳細%jを選別材料にしない', async (details) => {
    serve({ details });
    await expect(async () => fetchPrSelectionData(10, '/project')).rejects.toThrow();
  });

  it('取得パス数が変更ファイル数に満たない場合は判定材料を返さない', async () => {
    serve({ details: { changed_files: 3 } });
    await expect(async () => fetchPrSelectionData(10, '/project')).rejects.toThrow();
  });
});
