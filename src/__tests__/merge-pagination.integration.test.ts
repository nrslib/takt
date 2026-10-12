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

function run(executePrWorkflow: (request: { prNumber: number }) => Promise<{ merged: boolean }>,
  where?: { author: string }) {
  const provider = new GitHubProvider();
  return runMerge({ projectCwd: '/project', concurrency: 2,
    settings: resolveMergeSettings(undefined), where }, {
    listOpenPrNumbers: provider.listOpenPrNumbers.bind(provider),
    fetchPrListItem: provider.fetchPrListItem.bind(provider), executePrWorkflow,
  });
}

function serveOpenPrs(prs: ReturnType<typeof rawPr>[], options: { failPage?: number } = {}) {
  const events: string[] = [];
  mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe('gh');
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo' });
    expect(args[0]).toBe('api');
    if (args[1] === 'graphql') {
      const cursor = args.find((argument) => argument.startsWith('endCursor='));
      const offset = cursor === undefined ? 0 : Number(cursor.slice('endCursor='.length));
      const page = offset / 100 + 1;
      events.push(`list:${page}`);
      if (options.failPage === page) throw new Error('pagination failed');
      const query = args.find((argument) => argument.startsWith('query='));
      expect(query).toContain('states:OPEN');
      expect(query).toContain('field:CREATED_AT, direction:ASC');
      expect(query).toContain('nodes { number }');
      expect(query).not.toContain('body');
      const nodes = prs.slice(offset, offset + 100).map(({ number }) => ({ number }));
      const hasNextPage = offset + 100 < prs.length;
      return JSON.stringify({ data: { repository: { pullRequests: {
        nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(offset + 100) : null },
      } } } });
    }
    const number = Number(args[1]?.match(/\/pulls\/(\d+)$/u)?.[1]);
    events.push(`detail:${number}`);
    const pr = prs.find((item) => item.number === number);
    if (!pr) throw new Error('PR not found');
    return JSON.stringify(pr);
  });
  return events;
}

describe('Merge bulk GitHub pagination', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it.each([100, 101, 201])('%s件のopen PR番号を全ページ確定してから作成順に処理する', async (count) => {
    const prs = Array.from({ length: count }, (_, index) => rawPr(index + 1));
    const events = serveOpenPrs(prs);
    const executed: number[] = [];
    const result = await run(async ({ prNumber }) => { executed.push(prNumber); return { merged: true }; });
    expect(executed).toEqual(prs.map((pr) => pr.number));
    expect(events.slice(0, Math.ceil(count / 100))).toEqual(
      Array.from({ length: Math.ceil(count / 100) }, (_, index) => `list:${index + 1}`));
    expect(events.filter((event) => event.startsWith('detail:'))).toHaveLength(count);
    expect(result).toEqual({ processedCount: count, mergedCount: count, exitCode: 0 });
  });

  it('詳細取得時にclosedとなったPRを除外し残りの条件を判定する', async () => {
    const events = serveOpenPrs([rawPr(1), rawPr(2, { state: 'closed' }), rawPr(3, { user: { login: 'bob' } })]);
    const executePrWorkflow = vi.fn(async (_request: { prNumber: number }) => ({ merged: true }));
    expect(await run(executePrWorkflow, { author: 'alice' }))
      .toEqual({ processedCount: 1, mergedCount: 1, exitCode: 0 });
    expect(executePrWorkflow.mock.calls.map(([request]) => request.prNumber)).toEqual([1]);
    expect(events.slice(0, 1)).toEqual(['list:1']);
  });

  it('後続ページの取得失敗では詳細取得もworkflowも開始しない', async () => {
    const prs = Array.from({ length: 101 }, (_, index) => rawPr(index + 1));
    const events = serveOpenPrs(prs, { failPage: 2 });
    const executePrWorkflow = vi.fn(async () => ({ merged: true }));
    await expect(run(executePrWorkflow)).rejects.toThrow('pagination failed');
    expect(events).toEqual(['list:1', 'list:2']);
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });
});
