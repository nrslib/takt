import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commentOnIssue, listOpenIssues } from '../infra/github/issue.js';

const execFileSync = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: mockLogError }),
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

describe('commentOnIssue GitHub boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockReset();
  });

  it('gh issue comment にIssue番号・全文・cwdを渡して新規コメントを投稿する', () => {
    const body = 'Confirmed task instructions\nwith the complete content';
    execFileSync.mockReturnValue('');

    const firstResult = commentOnIssue(999, body, '/project');
    const secondResult = commentOnIssue(999, body, '/project');

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: true });
    const commentCalls = execFileSync.mock.calls.filter(([command, args]) =>
      command === 'gh' && Array.isArray(args) && args[0] === 'issue' && args[1] === 'comment');
    expect(commentCalls).toHaveLength(2);
    for (const call of commentCalls) {
      expect(call[1]).toEqual(['issue', 'comment', '999', '--body-file', '-']);
      expect(call[2]).toEqual(expect.objectContaining({ cwd: '/project', input: body }));
      expect(JSON.stringify(call[1])).not.toContain(body);
    }
  });

  it('コメント投稿コマンドの失敗理由を返し、再試行しない', () => {
    const body = 'secret task instructions';
    const error = Object.assign(new Error(`Command failed: ${body}`), {
      stderr: `permission denied: ${body}`,
    });
    execFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => { throw error; });

    const result = commentOnIssue(999, body, '/project');

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('permission denied'),
    });
    if (result.success !== false) {
      throw new Error('Expected commentOnIssue to return a failure result');
    }
    expect(result.error).not.toContain(body);
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(body);
    const commentCalls = execFileSync.mock.calls.filter(([command, args]) =>
      command === 'gh' && Array.isArray(args) && args[0] === 'issue' && args[1] === 'comment');
    expect(commentCalls).toHaveLength(1);
    expect(JSON.stringify(commentCalls[0]?.[1])).not.toContain(body);
  });

  it.each([
    new Error('missing stderr'),
    Object.assign(new Error('non-string stderr'), { stderr: 123 }),
    Object.assign(new Error('blank stderr'), { stderr: '  \n  ' }),
  ])('stderrが利用できない場合は固定の失敗理由を返す', (error) => {
    execFileSync.mockImplementation((command: unknown, args: unknown[]) => {
      if (command === 'gh' && args[0] === 'issue') {
        throw error;
      }
      return '';
    });

    expect(commentOnIssue(999, 'comment', '/project')).toEqual({
      success: false,
      error: 'Issue comment command failed',
    });
  });

  it('本文が空の場合はstderrをそのままtrimして返す', () => {
    const error = Object.assign(new Error('command failed'), { stderr: ' permission denied \n' });
    execFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => { throw error; });

    expect(commentOnIssue(999, '', '/project')).toEqual({
      success: false,
      error: 'permission denied',
    });
  });

  it('gh CLIが利用できない場合はコメントを投稿しない', () => {
    execFileSync
      .mockImplementationOnce(() => { throw new Error('not authenticated'); })
      .mockReturnValueOnce('gh version 2');

    const result = commentOnIssue(999, 'comment', '/project');

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not authenticated') });
    const commentCalls = execFileSync.mock.calls.filter(([command, args]) =>
      command === 'gh' && Array.isArray(args) && args[0] === 'issue' && args[1] === 'comment');
    expect(commentCalls).toHaveLength(0);
  });
});
