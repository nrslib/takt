import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePr,
  createPullRequest,
  fetchPrReviewComments,
  fetchCodeRabbitReviewStatus,
  fetchCodeRabbitReviewThreads,
  fetchCacciaPullRequestDetails,
  fetchPrDetails,
  fetchCacciaPullRequestHeadSha,
  findExistingPr,
  listOpenPrs,
  mergePr,
  resolveReviewThread,
} from '../infra/github/pr.js';

const execFileSync = vi.hoisted(() => vi.fn());
const execFile = vi.hoisted(() => vi.fn());
const asyncCommandResponses = vi.hoisted(() => [] as Array<string | Error>);
const checkGhCli = vi.hoisted(() => vi.fn(() => ({ available: true })));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFile(...args),
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock('../infra/github/issue.js', () => ({ checkGhCli }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getErrorMessage: (error: unknown) => String(error),
}));

function queueAsyncGhResponses(...responses: Array<unknown | Error>): void {
  asyncCommandResponses.push(...responses.map((response) => (
    response instanceof Error ? response : JSON.stringify(response)
  )));
}

function queueCacciaPullRequestDetails(
  headRepositorySshUrl: string,
  originUrl: string | Error,
  pushUrlOutput: string | Error,
): void {
  queueAsyncGhResponses(
    { url: 'https://github.com/org/repo/pull/7', headRefOid: 'head-7' },
    {
      data: {
        repository: {
          pullRequest: {
            number: 7,
            headRefName: 'fix/review-thread',
            headRefOid: 'head-7',
            headRepository: { sshUrl: headRepositorySshUrl },
          },
        },
      },
    },
  );
  asyncCommandResponses.push(originUrl, pushUrlOutput);
}

describe('GitHub open PR pagination', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  function endpoint(page: number) {
    return `/repos/org/repo/pulls?state=open&per_page=100&page=${page}`;
  }

  function pages(count: number, nextPage: (page: number) => number | undefined = (page) => page < count ? page + 1 : undefined) {
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo' });
      const page = Number(new URL(args[2]!, 'https://api.github.com/').searchParams.get('page'));
      const next = nextPage(page);
      const link = next === undefined ? '' : `\r\nLink: <https://api.github.com${endpoint(next)}>; rel="next"`;
      return `HTTP/2 200 OK${link}\r\n\r\n${JSON.stringify([{
        number: page, state: 'open', user: { login: 'alice' }, body: null, labels: [{ name: 'ready' }], draft: false,
        base: { ref: 'main', repo: { full_name: 'org/repo' } },
        head: { ref: `feature/${page}`, repo: { full_name: 'org/repo' } }, updated_at: '2026-10-08T00:00:00Z',
      }])}`;
    });
  }

  it.each([100, 101, 102])('全ページ指定なら%sページの終端まで取得しPR項目を返す', (count) => {
    pages(count);
    const result = Array.from(listOpenPrs('/project', { allPages: true }));
    expect(result.map((pr) => pr.number)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(result.at(-1)).toMatchObject({ number: count, author: 'alice', labels: ['ready'],
      base_branch: 'main', head_branch: `feature/${count}`, same_repository: true, draft: false, managed_by_takt: false });
    expect(execFileSync).toHaveBeenCalledTimes(count + 1);
  });

  it('通常一覧は100ページ目が終端なら成功する', () => {
    pages(100);
    expect(listOpenPrs('/project')).toHaveLength(100);
    expect(execFileSync).toHaveBeenCalledTimes(101);
  });

  it.each([undefined, { allPages: false }])('全ページ指定%jなら100ページ目のnextで既存上限エラーになる', (options) => {
    pages(101);
    expect(() => listOpenPrs('/project', options)).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(101);
  });

  it.each([1, 2, 102])('%sページの循環を再取得前に拒否する', (count) => {
    pages(count, (page) => page < count ? page + 1 : 1);
    expect(() => Array.from(listOpenPrs('/project', { allPages: true }))).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(count + 1);
  });

  it('一括一覧は消費されるまでページを取得せず次ページも先読みしない', () => {
    pages(3);
    const iterator = listOpenPrs('/project', { allPages: true })[Symbol.iterator]();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(iterator.next().value).toMatchObject({ number: 1 });
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(iterator.next().value).toMatchObject({ number: 2 });
    expect(execFileSync).toHaveBeenCalledTimes(3);
    iterator.return?.();
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('空一覧は一括でも通常でも空の結果として終端になる', () => {
    execFileSync.mockImplementation((_command: string, args: string[]) => args[0] === 'repo'
      ? JSON.stringify({ nameWithOwner: 'org/repo' }) : 'HTTP/2 200 OK\n\n[]');
    expect(Array.from(listOpenPrs('/project', { allPages: true }))).toEqual([]);
    expect(listOpenPrs('/project')).toEqual([]);
  });

  it('一括取得のnextに数値ページがなければ再取得前に拒否する', () => {
    pages(1, () => 2);
    const response = execFileSync.getMockImplementation()!;
    execFileSync.mockImplementation((command: string, args: string[]) => {
      const raw = response(command, args) as string;
      return raw.replace('page=2', 'page=invalid');
    });
    expect(() => Array.from(listOpenPrs('/project', { allPages: true }))).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('GitHub PR command boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncCommandResponses.splice(0);
    execFile.mockReset();
    execFileSync.mockReset();
    execFile.mockImplementation((
      _command: string,
      _args: string[],
      rawOptions: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const response = asyncCommandResponses.shift();
      const options = rawOptions as { maxBuffer?: number };
      queueMicrotask(() => {
        if (response instanceof Error) {
          callback(response, '', '');
        } else {
          const stdout = response ?? '';
          const maxBuffer = options.maxBuffer ?? 1024 * 1024;
          if (Buffer.byteLength(stdout, 'utf8') > maxBuffer) {
            callback(Object.assign(new Error('stdout maxBuffer length exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }), '', '');
          } else {
            callback(null, stdout, '');
          }
        }
      });
      return {};
    });
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

  it('returns only unresolved CodeRabbit threads, using the first comment and all thread pages asynchronously', async () => {
    const abortController = new AbortController();
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                nodes: [
                  {
                    id: 'human-thread',
                    isResolved: false,
                    isOutdated: false,
                    resolvedBy: null,
                    comments: {
                      pageInfo: { hasNextPage: true, endCursor: 'reply-cursor' },
                      nodes: [{
                        path: 'src/a.ts',
                        line: 4,
                        originalLine: 4,
                        body: 'human started this thread',
                        url: 'https://example.test/comment/1',
                        author: { login: 'reviewer' },
                      }],
                    },
                  },
                  {
                    id: 'resolved-bot-thread',
                    isResolved: true,
                    isOutdated: false,
                    resolvedBy: { login: 'maintainer' },
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{
                        path: 'src/a.ts',
                        line: 8,
                        originalLine: 8,
                        body: 'already resolved',
                        url: 'https://example.test/comment/3',
                        author: { login: 'coderabbitai' },
                      }],
                    },
                  },
                  {
                    id: 'deleted-author-thread',
                    isResolved: false,
                    isOutdated: false,
                    resolvedBy: null,
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{
                        path: 'src/a.ts',
                        line: 10,
                        originalLine: 10,
                        body: 'comment from a deleted author',
                        url: 'https://example.test/comment/5',
                        author: null,
                      }],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'outdated-bot-thread',
                  isResolved: false,
                  isOutdated: true,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      path: 'src/b.ts',
                      line: null,
                      originalLine: 12,
                      body: 'unresolved outdated CodeRabbit finding',
                      url: 'https://example.test/comment/4',
                      author: { login: 'coderabbitai' },
                    }],
                  },
                }],
              },
            },
          },
        },
      },
    );

    const result = await fetchCodeRabbitReviewThreads(7, '/project', 'head-7', abortController.signal);

    expect(result.map((thread) => thread.id)).toEqual(['outdated-bot-thread']);
    expect(result[0]?.replies).toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFileSync).not.toHaveBeenCalled();
    for (const [, args, options] of execFile.mock.calls) {
      expect(options).toMatchObject({ signal: abortController.signal });
      const query = (args as string[]).find((arg) => arg.startsWith('query='));
      if (query?.includes('reviewThreads')) {
        expect(query).toContain('comments(first:1)');
        expect(options).toMatchObject({ maxBuffer: 64 * 1024 * 1024 });
      }
    }
  });

  it('fetches every CodeRabbit thread reply asynchronously and includes reply authors and bodies', async () => {
    const abortController = new AbortController();
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'bot-thread',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'starter-cursor' },
                    nodes: [{
                      path: 'src/a.ts',
                      line: 4,
                      originalLine: 4,
                      body: 'finding',
                      url: 'https://example.test/comment/1',
                      author: { login: 'coderabbitai' },
                    }],
                  },
                }],
              },
            },
          },
        },
      },
      {
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: true, endCursor: 'reply-cursor-1' },
              nodes: [{ body: 'Please retain compatibility with v1.', author: { login: 'maintainer' } }],
            },
          },
        },
      },
      {
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ body: 'Thanks, I will update the finding.', author: { login: 'coderabbitai' } }],
            },
          },
        },
      },
    );

    const result = await fetchCodeRabbitReviewThreads(7, '/project', 'head-7', abortController.signal);

    expect(result).toEqual([expect.objectContaining({
      id: 'bot-thread',
      replies: [
        { author: 'maintainer', body: 'Please retain compatibility with v1.' },
        { author: 'coderabbitai', body: 'Thanks, I will update the finding.' },
      ],
    })]);
    expect(execFile).toHaveBeenCalledTimes(4);
    expect(execFileSync).not.toHaveBeenCalled();
    for (const [, args, options] of execFile.mock.calls.slice(2)) {
      expect(options).toMatchObject({ signal: abortController.signal, maxBuffer: 64 * 1024 * 1024 });
      const query = (args as string[]).find((arg) => arg.startsWith('query='));
      expect(query).toContain('comments(first:100, after:$commentsEndCursor)');
      expect(query).toContain('body');
      expect(query).toContain('author { login }');
    }
    expect(execFile.mock.calls[2]?.[1]).toContain('threadId=bot-thread');
    expect(execFile.mock.calls[2]?.[1]).toContain('commentsEndCursor=starter-cursor');
    expect(execFile.mock.calls[3]?.[1]).toContain('commentsEndCursor=reply-cursor-1');
  });

  it('aborts while asynchronously fetching CodeRabbit thread replies', async () => {
    const abortController = new AbortController();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'bot-thread',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'starter-cursor' },
                    nodes: [{
                      path: 'src/a.ts',
                      line: 4,
                      originalLine: 4,
                      body: 'finding',
                      url: 'https://example.test/comment/1',
                      author: { login: 'coderabbitai' },
                    }],
                  },
                }],
              },
            },
          },
        },
      },
    );
    execFile.mockImplementation((
      _command: string,
      args: string[],
      rawOptions: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const options = rawOptions as { signal?: AbortSignal };
      if (args.includes('commentsEndCursor=starter-cursor')) {
        options.signal?.addEventListener('abort', () => callback(abortError, '', ''), { once: true });
        queueMicrotask(() => abortController.abort());
      } else {
        const response = asyncCommandResponses.shift();
        queueMicrotask(() => {
          if (response instanceof Error) {
            callback(response, '', '');
          } else {
            callback(null, response ?? '', '');
          }
        });
      }
      return {};
    });

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7', abortController.signal))
      .rejects.toBe(abortError);

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls[2]?.[2]).toMatchObject({ signal: abortController.signal });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('fails instead of silently truncating replies beyond the pagination cap', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'bot-thread',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'starter-cursor' },
                    nodes: [{
                      path: 'src/a.ts',
                      line: 4,
                      originalLine: 4,
                      body: 'finding',
                      url: 'https://example.test/comment/1',
                      author: { login: 'coderabbitai' },
                    }],
                  },
                }],
              },
            },
          },
        },
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: true, endCursor: `reply-cursor-${index + 1}` },
              nodes: [],
            },
          },
        },
      })),
    );

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7'))
      .rejects.toThrow('Pagination limit exceeded while fetching replies for review thread bot-thread in pull request #7');
    expect(execFile).toHaveBeenCalledTimes(102);
  });

  it('aborts CodeRabbit thread retrieval while its asynchronous GitHub query is pending', async () => {
    const abortController = new AbortController();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    queueAsyncGhResponses({
      url: 'https://github.com/org/repo/pull/7',
      headRefOid: 'head-7',
    });
    let callCount = 0;
    execFile.mockImplementation((
      _command: string,
      _args: string[],
      rawOptions: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callCount += 1;
      const options = rawOptions as { signal?: AbortSignal };
      if (callCount === 1) {
        const response = asyncCommandResponses.shift();
        queueMicrotask(() => {
          if (response instanceof Error) {
            callback(response, '', '');
          } else {
            callback(null, response ?? '', '');
          }
        });
      } else {
        options.signal?.addEventListener('abort', () => callback(abortError, '', ''), { once: true });
        queueMicrotask(() => abortController.abort());
      }
      return {};
    });

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7', abortController.signal)).rejects.toBe(abortError);

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[2]).toMatchObject({ signal: abortController.signal });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('surfaces GitHub GraphQL errors while fetching CodeRabbit threads', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      { errors: [{ message: 'review thread access denied' }] },
    );

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7'))
      .rejects.toThrow(/review thread access denied/u);
  });

  it('rejects thread retrieval when the locator head differs from the reviewed head', async () => {
    queueAsyncGhResponses({
      url: 'https://github.com/org/repo/pull/7',
      headRefOid: 'head-8',
    });

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7'))
      .rejects.toThrow('Pull request #7 head changed before reading review threads');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('rejects thread data when the PR head changes after locator retrieval', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-8',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
    );

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7'))
      .rejects.toThrow('Pull request #7 head changed while reading review threads');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('fails instead of treating an unresolved thread without a starter comment as resolved', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'head-7',
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'empty-thread',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                }],
              },
            },
          },
        },
      },
    );

    await expect(fetchCodeRabbitReviewThreads(7, '/project', 'head-7'))
      .rejects.toThrow('Missing starter comment for review thread empty-thread in pull request #7');
  });

  it('resolves the requested review thread asynchronously without posting a PR comment', async () => {
    const abortController = new AbortController();
    queueAsyncGhResponses({
      data: { resolveReviewThread: { thread: { id: 'thread-42', isResolved: true } } },
    });

    await resolveReviewThread('thread-42', '/project', abortController.signal);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
    const [binary, args, options] = execFile.mock.calls[0] as [string, string[], { signal?: AbortSignal }];
    expect(binary).toBe('gh');
    expect(options.signal).toBe(abortController.signal);
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('threadId=thread-42');
    const mutation = args.find((arg) => arg.startsWith('query='));
    expect(mutation).toContain('resolveReviewThread');
    expect(mutation).not.toContain('addPullRequestReviewComment');
  });

  it('surfaces errors from the review thread Resolve mutation', async () => {
    queueAsyncGhResponses({ errors: [{ message: 'thread resolve denied' }] });

    await expect(resolveReviewThread('thread-42', '/project')).rejects.toThrow(/thread resolve denied/u);
  });

  it('reports CodeRabbit review completion only for the exact reviewed commit SHA', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'COMMENTED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ comments: { nodes: [{ author: { login: 'coderabbitai' } }] } }],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
    );

    await expect(fetchCodeRabbitReviewStatus(7, '/project')).resolves.toEqual({
      headSha: 'head-7',
      hasCodeRabbitPost: true,
      reviewedHeadShas: ['head-7'],
    });
    for (const [, , options] of execFile.mock.calls) {
      expect(options).not.toHaveProperty('timeout');
      expect(options).not.toHaveProperty('killSignal');
      expect(options).not.toHaveProperty('signal');
    }
  });

  it('uses the remaining absolute deadline for every status page and kills timed out gh processes', async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timeSpentByCall = [100, 200, 100, 250, 100, 0];
    let callNumber = 0;
    execFile.mockImplementation((
      _command: string,
      rawArgs: unknown,
      rawOptions: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const args = rawArgs as string[];
      const options = rawOptions as { timeout?: number; killSignal?: string };
      const callIndex = callNumber;
      callNumber += 1;
      const query = args.find((arg) => arg.startsWith('query='));
      const cursor = args.find((arg) => arg.startsWith('endCursor='));
      let response: unknown;

      if (callIndex === 0) {
        response = { url: 'https://github.com/org/repo/pull/7', headRefOid: 'head-7' };
      } else if (query?.includes('reviewThreads')) {
        response = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: cursor === undefined
                    ? { hasNextPage: true, endCursor: 'thread-cursor' }
                    : { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        };
      } else if (query?.includes('comments(first:100')) {
        response = {
          data: {
            repository: {
              pullRequest: {
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        };
      } else {
        response = {
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  pageInfo: cursor === undefined
                    ? { hasNextPage: true, endCursor: 'review-cursor' }
                    : { hasNextPage: false, endCursor: null },
                  nodes: cursor === undefined
                    ? [{
                        author: { login: 'coderabbitai' },
                        state: 'COMMENTED',
                        submittedAt: '2026-09-25T18:00:00Z',
                        commit: { oid: 'head-7' },
                      }]
                    : [],
                },
              },
            },
          },
        };
      }

      now += timeSpentByCall[callIndex] ?? 0;
      callback(null, JSON.stringify(response), '');
      return {};
    });

    try {
      await expect(fetchCodeRabbitReviewStatus(7, '/project', 11_000)).resolves.toEqual({
        headSha: 'head-7',
        hasCodeRabbitPost: true,
        reviewedHeadShas: ['head-7'],
      });
      const options = execFile.mock.calls.map(([, , rawOptions]) =>
        rawOptions as { timeout?: number; killSignal?: string },
      );
      expect(options.map(({ timeout }) => timeout)).toEqual([1_000, 900, 700, 600, 350, 250]);
      expect(options.map(({ killSignal }) => killSignal)).toEqual(Array(6).fill('SIGKILL'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns no partial status when a later page reaches the deadline', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'COMMENTED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      },
      Object.assign(new Error('spawn gh process timed out'), { killed: true, signal: 'SIGKILL' }),
    );

    await expect(fetchCodeRabbitReviewStatus(7, '/project', Date.now() + 1_000)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls[2]?.[2]).toMatchObject({
      killSignal: 'SIGKILL',
      timeout: expect.any(Number),
    });
  });

  it('does not convert GraphQL failures into a missing review status', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      { errors: [{ message: 'GraphQL authentication failed' }] },
    );

    await expect(fetchCodeRabbitReviewStatus(7, '/project', Date.now() + 1_000))
      .rejects.toThrow('GraphQL authentication failed');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('uses CodeRabbit issue-comment coverage when a review event is absent and the comment page exceeds the default output limit', async () => {
    const coverageMarker = '<!-- final_review_risk_coverage:{"sourceCommitId":"head-7","coveredCommitId":"head-7","kind":"reviewed"} -->';
    const comments = Array.from({ length: 100 }, (_, index) => ({
      author: { login: index === 99 ? 'coderabbitai' : 'reviewer' },
      body: `${'x'.repeat(11_847 - (index === 99 ? coverageMarker.length : 0))}${index === 99 ? coverageMarker : ''}`,
    }));
    const commentsResponse = {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: comments,
            },
          },
        },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(commentsResponse), 'utf8')).toBeGreaterThan(1024 * 1024);

    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
      commentsResponse,
    );

    await expect(fetchCodeRabbitReviewStatus(7, '/project')).resolves.toEqual({
      headSha: 'head-7',
      hasCodeRabbitPost: true,
      reviewedHeadShas: ['head-7'],
    });
    const commentsCall = execFile.mock.calls.find(([, args]) =>
      (args as string[]).some((arg) => arg.includes('comments(first:100')),
    );
    expect(commentsCall?.[2]).toMatchObject({ maxBuffer: 64 * 1024 * 1024 });
  });

  it('passes an abort signal to each asynchronous gh request', async () => {
    const abortController = new AbortController();
    queueAsyncGhResponses(
      { url: 'https://github.com/org/repo/pull/7', headRefOid: 'head-7' },
      { data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } },
      { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } },
    );

    await fetchCodeRabbitReviewStatus(7, '/project', Date.now() + 1_000, abortController.signal);

    expect(execFile.mock.calls).toHaveLength(4);
    for (const [, , options] of execFile.mock.calls) {
      expect(options).toMatchObject({ signal: abortController.signal });
    }
  });

  it('does not start status retrieval after the absolute deadline', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(11_000);
    try {
      await expect(fetchCodeRabbitReviewStatus(7, '/project', 11_000)).resolves.toBeUndefined();
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns the fork branch and exact PR head used to create an isolated clone asynchronously', async () => {
    const abortController = new AbortController();
    queueCacciaPullRequestDetails(
      'git@github.com:contributor/repo.git', 'https://github.com/org/repo.git\n', 'git@github.com:org/repo.git\n',
    );

    await expect(fetchCacciaPullRequestDetails(7, '/project', abortController.signal)).resolves.toEqual({
      number: 7,
      headBranch: 'fix/review-thread',
      headSha: 'head-7',
      headRepositoryUrl: 'https://github.com/contributor/repo.git',
      headRepositoryPushUrls: ['git@github.com:contributor/repo.git'],
    });
    expect(execFile).toHaveBeenCalledTimes(4);
    expect(execFile.mock.calls[2]).toMatchObject([
      'git', ['remote', 'get-url', 'origin'], { cwd: '/project', signal: abortController.signal }, expect.any(Function),
    ]);
    expect(execFile.mock.calls[3]).toMatchObject([
      'git', ['remote', 'get-url', '--push', '--all', 'origin'],
      { cwd: '/project', signal: abortController.signal }, expect.any(Function),
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
    for (const [, , options] of execFile.mock.calls) {
      expect(options).toMatchObject({ signal: abortController.signal });
    }
  });

  it('取得したforkのhead metadataとbase branchをmerge実行へ返す', async () => {
    queueCacciaPullRequestDetails('git@github.com:contributor/repo.git', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git');
    queueAsyncGhResponses({ baseRefName: 'release', isCrossRepository: true });
    await expect(fetchPrDetails(7, '/project')).resolves.toMatchObject({
      number: 7, baseBranch: 'release', headBranch: 'fix/review-thread', headSha: 'head-7',
      sameRepository: false,
      headRepositoryUrl: 'https://github.com/contributor/repo.git',
      headRepositoryPushUrls: ['git@github.com:contributor/repo.git'],
    });
  });

  it('base branchが欠損するmerge metadataを拒否する', async () => {
    queueCacciaPullRequestDetails('git@github.com:contributor/repo.git', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git');
    queueAsyncGhResponses({});
    await expect(fetchPrDetails(7, '/project')).rejects.toThrow('Missing PR base branch');
  });

  it('同一repositoryのPRを検査省略のmetadataとして返す', async () => {
    queueCacciaPullRequestDetails('git@github.com:org/repo.git', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git');
    queueAsyncGhResponses({ baseRefName: 'main', isCrossRepository: false });
    await expect(fetchPrDetails(7, '/project')).resolves.toMatchObject({ sameRepository: true });
  });

  it('repositoryの判定値が欠損したmetadataを拒否する', async () => {
    queueCacciaPullRequestDetails('git@github.com:org/repo.git', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git');
    queueAsyncGhResponses({ baseRefName: 'main' });
    await expect(fetchPrDetails(7, '/project')).rejects.toThrow();
  });

  it.each([
    ['https://github.com/org/repo.git', 'org/repo', 'https://github.com/org/repo.git'],
    ['https://github.com/org/repo', 'org/repo', 'https://github.com/org/repo'],
    ['https://github.com/ORG/REPO.git/', 'org/repo', 'https://github.com/ORG/REPO.git/'],
    ['git@github.com:org/repo.git', 'org/repo', 'git@github.com:org/repo.git'],
    ['ssh://git@github.com:443/org/repo.git', 'org/repo', 'ssh://git@github.com:443/org/repo.git'],
    ['https://github.com/org/repo.git', 'contributor/fork', 'https://github.com/contributor/fork.git'],
    ['https://account@github.com/org/repo.git', 'contributor/fork', 'https://account@github.com/contributor/fork.git'],
    ['git@github.com:org/repo.git', 'contributor/fork', 'git@github.com:contributor/fork.git'],
    ['ssh://git@github.com:443/org/repo.git', 'contributor/fork', 'ssh://git@github.com:443/contributor/fork.git'],
    ['https://github.com/contributor/fork.git', 'contributor/fork', 'https://github.com/contributor/fork.git'],
  ])('preserves the origin transport %s for PR head %s', async (originUrl, headRepository, expectedUrl) => {
    queueCacciaPullRequestDetails(`git@github.com:${headRepository}.git`, originUrl, originUrl);

    const details = await fetchCacciaPullRequestDetails(7, '/project');

    expect(details).toMatchObject({
      headRepositoryUrl: expectedUrl,
      headRepositoryPushUrls: [expectedUrl],
      headBranch: 'fix/review-thread',
      headSha: 'head-7',
    });
    expect(execFile.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['gh', 'pr'], ['gh', 'api'], ['git', 'remote'], ['git', 'remote'],
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ['org/repo', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git',
      'https://github.com/org/repo.git', ['git@github.com:org/repo.git']],
    ['contributor/fork', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git',
      'https://github.com/contributor/fork.git', ['git@github.com:contributor/fork.git']],
    ['contributor/fork', 'git@github.com:org/repo.git', 'https://github.com/org/repo.git',
      'git@github.com:contributor/fork.git', ['https://github.com/contributor/fork.git']],
    ['contributor/fork', 'https://github.com/org/repo.git',
      'git@github.com:org/repo.git\nssh://git@github.com:443/org/repo.git\n',
      'https://github.com/contributor/fork.git',
      ['git@github.com:contributor/fork.git', 'ssh://git@github.com:443/contributor/fork.git']],
    ['contributor/fork', 'https://github.com/org/repo.git',
      'https://github.com/contributor/fork.git\r\ngit@github.com:org/repo.git\r\n',
      'https://github.com/contributor/fork.git',
      ['https://github.com/contributor/fork.git', 'git@github.com:contributor/fork.git']],
  ] as const)('resolves fetch and every configured push URL independently for %s with %s and %s', async (
    headRepository, originUrl, pushUrlOutput, expectedFetchUrl, expectedPushUrls,
  ) => {
    queueCacciaPullRequestDetails(`git@github.com:${headRepository}.git`, originUrl, pushUrlOutput);

    await expect(fetchCacciaPullRequestDetails(7, '/project')).resolves.toMatchObject({
      headRepositoryUrl: expectedFetchUrl,
      headRepositoryPushUrls: expectedPushUrls,
    });
    expect(execFile.mock.calls[3]?.[1]).toEqual(['remote', 'get-url', '--push', '--all', 'origin']);
  });

  it.each([
    '',
    'https://github.com/other/unrelated.git',
    'git@example.test:org/repo.git',
    'file:///tmp/org/repo.git',
    'https://github.com/org/repo.git?target=other',
    'git@github.com:org/repo.git\nhttps://github.com/other/unrelated.git',
    'git@github.com:org/repo.git\n\nhttps://github.com/org/repo.git',
  ])('rejects invalid or unrelated push targets %s without returning clone metadata', async (pushUrlOutput) => {
    queueCacciaPullRequestDetails('git@github.com:contributor/fork.git', 'https://github.com/org/repo.git', pushUrlOutput);

    await expect(fetchCacciaPullRequestDetails(7, '/project')).rejects.toThrow();
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it('propagates failure to read push URLs without using the fetch URL for push', async () => {
    const failure = new Error('push URLs unavailable');
    queueCacciaPullRequestDetails('git@github.com:contributor/fork.git', 'https://github.com/org/repo.git', failure);

    await expect(fetchCacciaPullRequestDetails(7, '/project')).rejects.toBe(failure);
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it.each([
    'https://github.com/other/unrelated.git',
    'https://gitlab.com/org/repo.git',
    'https://github.com.example.test/org/repo.git',
    'git@example.test:org/repo.git',
    'file:///tmp/org/repo.git',
    '/tmp/org/repo.git',
    'http://github.com/org/repo.git',
    'https://github.com/org/repo.git?target=other',
    'https://github.com/org/repo.git#other',
    'https://github.com/org/nested/repo.git',
    'https://github.com/org/repo.git\nhttps://github.com/other/repo.git',
    '',
  ])('rejects an unrelated or invalid origin %s before returning a push target', async (originUrl) => {
    queueCacciaPullRequestDetails('git@github.com:contributor/fork.git', originUrl, originUrl);

    await expect(fetchCacciaPullRequestDetails(7, '/project')).rejects.toThrow();

    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    'https://github.com/contributor/fork.git',
    'git@example.test:contributor/fork.git',
    'git@github.com:contributor/nested/fork.git',
    'git@github.com:contributor/..git',
    'git@github.com:contributor/../fork.git',
  ])('rejects invalid head metadata %s before returning a push target', async (headRepositorySshUrl) => {
    queueCacciaPullRequestDetails(headRepositorySshUrl, 'https://github.com/org/repo.git', 'https://github.com/org/repo.git');

    await expect(fetchCacciaPullRequestDetails(7, '/project')).rejects.toThrow();
  });

  it('propagates failure to read the configured origin without selecting another transport', async () => {
    const failure = new Error('origin unavailable');
    queueCacciaPullRequestDetails('git@github.com:contributor/fork.git', failure, 'https://github.com/org/repo.git');

    await expect(fetchCacciaPullRequestDetails(7, '/project')).rejects.toBe(failure);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('reads the current Caccia PR head with an abortable, bounded locator request', async () => {
    const abortController = new AbortController();
    const deadlineAt = Date.now() + 30_000;
    queueAsyncGhResponses({
      url: 'https://github.com/org/repo/pull/7',
      headRefOid: 'head-7',
    });

    await expect(fetchCacciaPullRequestHeadSha(7, '/project', abortController.signal, deadlineAt))
      .resolves.toBe('head-7');

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toEqual(['pr', 'view', '7', '--json', 'url,headRefOid']);
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({
      signal: abortController.signal,
      killSignal: 'SIGKILL',
      timeout: expect.any(Number),
    });
    expect(execFile.mock.calls[0]?.[2].timeout).toBeGreaterThan(0);
    expect(execFile.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(30_000);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('does not treat a dismissed CodeRabbit review as a completed review', async () => {
    queueAsyncGhResponses(
      {
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'DISMISSED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
    );

    await expect(fetchCodeRabbitReviewStatus(7, '/project')).resolves.toEqual({
      headSha: 'head-7',
      hasCodeRabbitPost: false,
      reviewedHeadShas: [],
    });
  });
});
