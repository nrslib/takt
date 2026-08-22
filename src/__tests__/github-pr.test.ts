import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePr,
  createPullRequest,
  fetchPrReviewComments,
  findExistingPr,
  mergePr,
} from '../infra/github/pr.js';

const execFileSync = vi.hoisted(() => vi.fn());
const checkGhCli = vi.hoisted(() => vi.fn(() => ({ available: true })));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock('../infra/github/issue.js', () => ({ checkGhCli }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getErrorMessage: (error: unknown) => String(error),
}));

describe('GitHub PR command boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockReset();
    checkGhCli.mockReturnValue({ available: true });
  });

  it('finds an open PR and treats CLI failure as no match', () => {
    execFileSync.mockReturnValueOnce(JSON.stringify([{ number: 42, url: 'https://example.test/pr/42' }]));
    expect(findExistingPr('feature/branch', '/project')).toEqual({
      number: 42,
      url: 'https://example.test/pr/42',
    });

    execFileSync.mockImplementationOnce(() => { throw new Error('lookup failed'); });
    expect(findExistingPr('feature/branch', '/project')).toBeUndefined();
  });

  it('passes PR options and returns the created URL', () => {
    const title = 'dynamic title';
    const body = 'dynamic body';
    const branch = 'feature/dynamic';
    execFileSync.mockReturnValue('https://example.test/pr/7\n');

    const result = createPullRequest({
      title,
      body,
      branch,
      base: 'main',
      repo: 'org/repo',
      draft: true,
      labels: ['automation'],
    }, '/project');

    expect(result).toEqual({ success: true, url: 'https://example.test/pr/7' });
    const args = execFileSync.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--title', title,
      '--body', body,
      '--head', branch,
      '--base', 'main',
      '--repo', 'org/repo',
      '--draft',
      '--label', 'automation',
    ]));
  });

  it('returns a failure result when merge or close cannot be executed', () => {
    execFileSync.mockImplementation(() => { throw new Error('remote operation failed'); });

    expect(mergePr(7, '/project')).toMatchObject({
      success: false,
      error: expect.stringContaining('remote operation failed'),
    });
    expect(closePr(7, '/project')).toMatchObject({
      success: false,
      error: expect.stringContaining('remote operation failed'),
    });
  });

  it('maps PR review metadata and thread comments across the provider boundary', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        number: 7,
        title: 'review target',
        body: 'description',
        url: 'https://github.com/org/repo/pull/7',
        headRefName: 'feature/review',
        baseRefName: 'main',
        comments: [{ author: { login: 'commenter' }, body: 'general comment' }],
        reviews: [{ author: { login: 'reviewer' }, body: 'review body' }],
        files: [{ path: 'src/changed.ts' }],
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'thread-1',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      path: 'src/changed.ts',
                      line: null,
                      originalLine: 11,
                      body: 'thread comment',
                      url: 'https://example.test/comment/1',
                      author: null,
                    }],
                  },
                }],
              },
            },
          },
        },
      }));

    const result = fetchPrReviewComments(7, '/project');
    expect(result).toMatchObject({
      number: 7,
      headRefName: 'feature/review',
      baseRefName: 'main',
      files: ['src/changed.ts'],
    });
    expect(result.comments).toEqual([{ author: 'commenter', body: 'general comment' }]);
    expect(result.reviews).toEqual(expect.arrayContaining([
      { author: 'reviewer', body: 'review body' },
      expect.objectContaining({
        author: expect.any(String),
        body: 'thread comment',
        path: 'src/changed.ts',
        line: 11,
        threadState: 'active',
      }),
    ]));
  });
});
