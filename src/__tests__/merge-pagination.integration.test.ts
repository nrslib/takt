import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { resolveMergeSettings, runMerge } from '../features/merge/index.js';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: mocks.execFileSync,
}));

function rawPr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number, state: 'open', user: { login: 'alice' }, body: null, labels: [], draft: false,
    base: { ref: 'main', repo: { full_name: 'org/repo' } },
    head: { ref: `feature/${number}`, repo: { full_name: 'org/repo' } },
    updated_at: '2026-10-08T00:00:00Z', ...overrides,
  };
}

function httpPage(items: ReturnType<typeof rawPr>[], next?: URL): string {
  const link = next === undefined ? '' : `\nLink: <${next}>; rel="next"`;
  return `HTTP/2 200 OK${link}\n\n${JSON.stringify(items)}`;
}

function nextPage(url: URL, page: number): URL {
  const next = new URL(url);
  next.searchParams.set('page', String(page));
  return next;
}

function servePages(response: (url: URL) => string): void {
  mocks.execFileSync.mockImplementation((command: string, args: string[], options: { cwd: string }) => {
    expect(command).toBe('gh');
    expect(options.cwd).toBe('/project');
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo' });
    expect(args.slice(0, 2)).toEqual(['api', '--include']);
    const url = new URL(args[2]!, 'https://api.github.com/');
    expect(url.pathname).toBe('/repos/org/repo/pulls');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      state: 'all', sort: 'created', direction: 'asc', per_page: '100',
    });
    return response(url);
  });
}

function run(executePrWorkflow: (request: { prNumber: number }) => Promise<{ merged: boolean }>,
  where?: { author: string }) {
  const provider = new GitHubProvider();
  return runMerge({ projectCwd: '/project', concurrency: 2,
    settings: resolveMergeSettings(undefined), where }, {
    listOpenPrs: provider.listOpenPrs.bind(provider), executePrWorkflow,
  });
}

describe('Merge bulk GitHub pagination', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it.each(['alice', 'bob'])('102ページ目のauthor=%sを条件に照合し実行番号と集計へ反映する', async (lastAuthor) => {
    const pageCount = 102;
    const fetchedPages: number[] = [];
    servePages((url) => {
      const page = Number(url.searchParams.get('page'));
      fetchedPages.push(page);
      return httpPage([rawPr(page, { user: { login: page === pageCount ? lastAuthor : 'alice' } })],
        page < pageCount ? nextPage(url, page + 1) : undefined);
    });
    const executePrWorkflow = vi.fn(async (_request: { prNumber: number }) => {
      if (executePrWorkflow.mock.calls.length === 1) expect(fetchedPages).toEqual([1]);
      return { merged: true };
    });
    const result = await run(executePrWorkflow, { author: 'alice' });
    const count = lastAuthor === 'alice' ? 102 : 101;
    expect(fetchedPages).toEqual(Array.from({ length: pageCount }, (_, index) => index + 1));
    expect(executePrWorkflow.mock.calls.map(([request]) => request.prNumber))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(result).toEqual({ processedCount: count, mergedCount: count, exitCode: 0 });
  });

  it('並列度2に達すると取得と投入が止まり1件の完了で次ページへ進む', async () => {
    const fetchedPages: number[] = [];
    servePages((url) => {
      const page = Number(url.searchParams.get('page'));
      fetchedPages.push(page);
      return httpPage([rawPr(page)], page < 4 ? nextPage(url, page + 1) : undefined);
    });
    const releases = new Map<number, () => void>();
    let active = 0;
    let maxActive = 0;
    const executePrWorkflow = vi.fn(({ prNumber }: { prNumber: number }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<{ merged: boolean }>((resolve) => releases.set(prNumber, () => {
        active -= 1;
        resolve({ merged: true });
      }));
    });
    const running = run(executePrWorkflow);
    await vi.waitFor(() => expect(releases.size).toBe(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchedPages).toEqual([1, 2]);
    expect(executePrWorkflow).toHaveBeenCalledTimes(2);
    releases.get(1)!();
    await vi.waitFor(() => expect(releases.size).toBe(3));
    expect(fetchedPages).toEqual([1, 2, 3]);
    expect(active).toBe(2);
    releases.get(2)!();
    await vi.waitFor(() => expect(releases.size).toBe(4));
    releases.get(3)!();
    releases.get(4)!();
    expect(await running).toEqual({ processedCount: 4, mergedCount: 4, exitCode: 0 });
    expect(maxActive).toBe(2);
  });

  it.each(['all', 'open'])('取得中にマージしてもstate=%sのページ境界を比較できる', async (state) => {
    const prs = Array.from({ length: 201 }, (_, index) => rawPr(index + 1));
    const fetchedPages: number[] = [];
    servePages((url) => {
      // 比較する条件はstateだけ。open集合の縮小を外部APIの応答で再現する。
      const responseUrl = new URL(url);
      responseUrl.searchParams.set('state', state);
      const page = Number(url.searchParams.get('page'));
      fetchedPages.push(page);
      const candidates = responseUrl.searchParams.get('state') === 'all' ? prs : prs.filter((pr) => pr.state === 'open');
      return httpPage(candidates.slice((page - 1) * 100, page * 100),
        page * 100 < candidates.length ? nextPage(url, page + 1) : undefined);
    });
    const releases: Array<() => void> = [];
    const executed: number[] = [];
    const executePrWorkflow = vi.fn(({ prNumber }: { prNumber: number }) => {
      executed.push(prNumber);
      return new Promise<{ merged: boolean }>((resolve) => releases.push(() => {
        prs[prNumber - 1]!.state = 'closed';
        resolve({ merged: true });
      }));
    });
    let finished = false;
    const running = run(executePrWorkflow).then((result) => { finished = true; return result; });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(fetchedPages).toEqual([1]);
    for (let tick = 0; tick < 5000 && !finished; tick += 1) {
      releases.shift()?.();
      await Promise.resolve();
    }
    expect(finished).toBe(true);
    const expected = state === 'all' ? 201 : 101;
    expect(executed).toHaveLength(expected);
    expect(new Set(executed).size).toBe(expected);
    expect(await running).toEqual({ processedCount: expected, mergedCount: expected, exitCode: 0 });
    if (state === 'all') expect(executed).toEqual(prs.map((pr) => pr.number));
    else expect(executed).toEqual([...Array.from({ length: 100 }, (_, index) => index + 1), 201]);
  });

  it.each(['open', 'closed'])('応答state=%sを分類し本文openには依存しない', async (state) => {
    servePages(() => httpPage([rawPr(123, { state, body: 'open' })]));
    const executePrWorkflow = vi.fn(async (_request: { prNumber: number }) => ({ merged: true }));
    const count = state === 'open' ? 1 : 0;
    expect(await run(executePrWorkflow)).toEqual({ processedCount: count, mergedCount: count, exitCode: 0 });
    expect(executePrWorkflow.mock.calls.map(([request]) => request.prNumber)).toEqual(count === 1 ? [123] : []);
  });

  it.each(['fetch', 'JSON', 'Link', 'cycle'])('次ページの%s失敗時も開始済み処理を待って例外を伝播する', async (failure) => {
    const fetchedPages: number[] = [];
    const fetchError = new Error('page request failed');
    servePages((url) => {
      const page = Number(url.searchParams.get('page'));
      fetchedPages.push(page);
      if (page === 1) return httpPage([rawPr(123), rawPr(456)], nextPage(url, 2));
      if (failure === 'fetch') throw fetchError;
      if (failure === 'JSON') return 'HTTP/2 200 OK\n\ninvalid JSON';
      if (failure === 'Link') return 'HTTP/2 200 OK\nLink: <invalid>; rel="next"\n\n[]';
      return httpPage([], nextPage(url, 1));
    });
    let release!: () => void;
    const executePrWorkflow = vi.fn(({ prNumber }: { prNumber: number }) => prNumber === 123
      ? new Promise<{ merged: boolean }>((resolve) => { release = () => resolve({ merged: true }); })
      : Promise.resolve({ merged: true }));
    let settled = false;
    const running = run(executePrWorkflow).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.waitFor(() => expect(fetchedPages).toEqual([1, 2]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(executePrWorkflow.mock.calls.map(([request]) => request.prNumber)).toEqual([123, 456]);
    release();
    const error = await running;
    expect(error).toBeInstanceOf(Error);
    if (failure === 'fetch') expect(error).toBe(fetchError);
    expect(fetchedPages).toEqual([1, 2]);
  });
});
