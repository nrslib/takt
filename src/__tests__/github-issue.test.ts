import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listOpenIssues } from '../infra/github/issue.js';

const execFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  getErrorMessage: (error: unknown) => String(error),
}));

function apiResponse(body: unknown, next?: string): string {
  const link = next ? `\nlink: <https://api.github.com${next}>; rel="next"` : '';
  return `HTTP/2 200 OK\ncontent-type: application/json${link}\n\n${JSON.stringify(body)}`;
}

describe('listOpenIssues GitHub boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockReset();
  });

  it('paginates open issues, excludes pull requests, and maps labels', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(apiResponse([
        { number: 1, title: 'first', labels: [{ name: 'bug' }], updated_at: '2026-04-20T00:00:00Z' },
        {
          number: 2,
          title: 'pull request',
          labels: [{ name: 'bug' }],
          updated_at: '2026-04-20T00:01:00Z',
          pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/2' },
        },
      ], '/repos/org/repo/issues?state=open&per_page=100&page=2'))
      .mockReturnValueOnce(apiResponse([
        { number: 3, title: 'second', labels: [], updated_at: '2026-04-21T00:00:00Z' },
      ]));

    expect(listOpenIssues('/project')).toEqual([
      { number: 1, title: 'first', labels: ['bug'], updated_at: '2026-04-20T00:00:00Z' },
      { number: 3, title: 'second', labels: [], updated_at: '2026-04-21T00:00:00Z' },
    ]);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('rejects an unbounded pagination chain', () => {
    let page = 1;
    execFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockImplementation(() => apiResponse([
        { number: page, title: `issue-${page}`, labels: [], updated_at: '2026-04-20T00:00:00Z' },
      ], `/repos/org/repo/issues?state=open&per_page=100&page=${++page}`));

    expect(() => listOpenIssues('/project')).toThrow();
    expect(execFileSync.mock.calls.length).toBeGreaterThan(100);
  });
});
