import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as githubPrModule from '../infra/github/pr.js';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/github/issue.js', () => ({
  checkGhCli: vi.fn().mockReturnValue({ available: true }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

import { findExistingPr, listOpenPrs, createPullRequest, fetchPrReviewComments, mergePr } from '../infra/github/pr.js';
import { checkGhCli } from '../infra/github/issue.js';
import {
  buildPrBody,
  formatPrReviewAsTask,
  TAKT_MANAGED_PR_MARKER,
} from '../infra/git/format.js';
import type { Issue, PrReviewData } from '../infra/git/types.js';

const automationLabel = 'automation';

function withGhApiResponse(body: unknown, nextPath?: string): string {
  const headers = [
    'HTTP/2 200 OK',
    'content-type: application/json',
    ...(nextPath ? [`link: <https://api.github.com${nextPath}>; rel="next"`] : []),
  ];
  return `${headers.join('\n')}\n\n${JSON.stringify(body)}`;
}

function withReviewThreadsResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo,
            nodes,
          },
        },
      },
    },
  });
}

function withReviewThreadCommentsResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): string {
  return JSON.stringify({
    data: {
      node: {
        comments: {
          pageInfo,
          nodes,
        },
      },
    },
  });
}

function createReviewThread(overrides: {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: { login: string } | null;
  comments: unknown[];
  commentsPageInfo?: { hasNextPage: boolean; endCursor: string | null };
}): unknown {
  return {
    id: overrides.id,
    isResolved: overrides.isResolved,
    isOutdated: overrides.isOutdated,
    resolvedBy: overrides.resolvedBy ?? null,
    comments: {
      pageInfo: overrides.commentsPageInfo ?? { hasNextPage: false, endCursor: null },
      nodes: overrides.comments,
    },
  };
}

function expectGraphqlField(args: unknown, flag: '-f' | '-F', value: string): void {
  expect(args).toEqual(expect.any(Array));
  const commandArgs = args as string[];
  const valueIndex = commandArgs.indexOf(value);
  expect(valueIndex).toBeGreaterThan(0);
  expect(commandArgs[valueIndex - 1]).toBe(flag);
}

describe('findExistingPr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    vi.mocked(checkGhCli).mockReset();
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
  });

  it('オープンな PR がある場合はその PR を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ number: 42, url: 'https://github.com/org/repo/pull/42' }]));

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toEqual({ number: 42, url: 'https://github.com/org/repo/pull/42' });
  });

  it('PR がない場合は undefined を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toBeUndefined();
  });

  it('gh CLI が失敗した場合は undefined を返す', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: command not found'); });

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toBeUndefined();
  });
});

describe('listOpenPrs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    vi.mocked(checkGhCli).mockReset();
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
  });

  it('open PR list を取得して workflow 用の項目へマッピングする', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 42,
          user: { login: 'nrslib' },
          base: { ref: 'improve', repo: { full_name: 'org/repo' } },
          head: { ref: 'task/42', repo: { full_name: 'org/repo' } },
          body: `## Summary\n\nTask summary\n\n## Execution Report\n\nWorkflow \`default\` completed successfully.\n\n${TAKT_MANAGED_PR_MARKER}`,
          labels: [{ name: automationLabel }],
          draft: false,
          updated_at: '2026-04-20T12:00:00Z',
        },
      ]));

    const result = listOpenPrs('/project');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '--include', 'repos/org/repo/pulls?state=open&per_page=100&page=1'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(result).toEqual([
      {
        number: 42,
        author: 'nrslib',
        base_branch: 'improve',
        head_branch: 'task/42',
        managed_by_takt: true,
        labels: [automationLabel],
        same_repository: true,
        draft: false,
        updated_at: '2026-04-20T12:00:00Z',
      },
    ]);
  });

  it('100件を超える open PR を後続ページまで取得する', () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      user: { login: `user-${index + 1}` },
      base: { ref: 'improve', repo: { full_name: 'org/repo' } },
      head: { ref: `task/${index + 1}`, repo: { full_name: 'org/repo' } },
      body: 'Human-managed body',
      labels: [],
      draft: false,
      updated_at: `2026-04-20T12:${String(index % 60).padStart(2, '0')}:00Z`,
    }));

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse(
        firstPage,
        '/repos/org/repo/pulls?state=open&per_page=100&page=2',
      ))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 101,
          user: { login: 'nrslib' },
          base: { ref: 'improve', repo: { full_name: 'org/repo' } },
          head: { ref: 'task/101', repo: { full_name: 'org/repo' } },
          body: `## Summary\n\nTask summary\n\n## Execution Report\n\nTask completed successfully.\n\n${TAKT_MANAGED_PR_MARKER}`,
          labels: [{ name: automationLabel }],
          draft: false,
          updated_at: '2026-04-21T00:00:00Z',
        },
      ]));

    const result = listOpenPrs('/project');

    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', '--include', 'repos/org/repo/pulls?state=open&per_page=100&page=1'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      'gh',
      ['api', '--include', '/repos/org/repo/pulls?state=open&per_page=100&page=2'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({
      number: 101,
      author: 'nrslib',
      base_branch: 'improve',
      head_branch: 'task/101',
      managed_by_takt: true,
      labels: [automationLabel],
      same_repository: true,
      draft: false,
      updated_at: '2026-04-21T00:00:00Z',
    });
  });

  it('fork PR は same_repository: false にマッピングする', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 52,
          user: { login: 'fork-user' },
          base: { ref: 'improve', repo: { full_name: 'org/repo' } },
          head: { ref: 'takt/52/forked-branch', repo: { full_name: 'fork/repo' } },
          body: 'Human-managed body',
          labels: [{ name: automationLabel }],
          draft: false,
          updated_at: '2026-04-21T01:00:00Z',
        },
      ]));

    const result = listOpenPrs('/project');

    expect(result).toEqual([
      {
        number: 52,
        author: 'fork-user',
        base_branch: 'improve',
        head_branch: 'takt/52/forked-branch',
        managed_by_takt: false,
        labels: [automationLabel],
        same_repository: false,
        draft: false,
        updated_at: '2026-04-21T01:00:00Z',
      },
    ]);
  });

  it('gh CLI 利用不可時の判定を持たず、呼び出し失敗をそのまま伝播する', async () => {
    const { checkGhCli } = await import('../infra/github/issue.js');
    vi.mocked(checkGhCli).mockReturnValueOnce({ available: false, error: 'gh unavailable' });
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('gh unavailable');
    });

    expect(() => listOpenPrs('/project')).toThrow('gh unavailable');
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('pagination link が上限を超えて続く場合は明示エラーにする', () => {
    let page = 1;
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockImplementation(() => {
        const response = withGhApiResponse(
          [{
            number: page,
            user: { login: 'nrslib' },
            base: { ref: 'improve', repo: { full_name: 'org/repo' } },
            head: { ref: `task/${page}`, repo: { full_name: 'org/repo' } },
            body: 'Human-managed body',
            labels: [],
            draft: false,
            updated_at: '2026-04-21T00:00:00Z',
          }],
          `/repos/org/repo/pulls?state=open&per_page=100&page=${page + 1}`,
        );
        page += 1;
        return response;
      });

    expect(() => listOpenPrs('/project')).toThrow(
      'Pagination limit exceeded while fetching open pull request list (>100 pages)',
    );
  });

  it('marker 付き same-repo takt PR は label がなくても managed_by_takt: true にマッピングする', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 78,
          user: { login: 'nrslib' },
          base: { ref: 'improve', repo: { full_name: 'org/repo' } },
          head: { ref: 'takt/78/managed-without-label', repo: { full_name: 'org/repo' } },
          body: `## Summary\n\nTask summary\n\n## Execution Report\n\nTask completed successfully.\n\n${TAKT_MANAGED_PR_MARKER}`,
          labels: [],
          draft: false,
          updated_at: '2026-04-21T02:30:00Z',
        },
      ]));

    expect(listOpenPrs('/project')).toEqual([
      expect.objectContaining({
        number: 78,
        managed_by_takt: true,
        labels: [],
        same_repository: true,
      }),
    ]);
  });

  it('legacy な TAKT PR 本文だけでは managed_by_takt: false にマッピングする', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 77,
          user: { login: 'nrslib' },
          base: { ref: 'improve', repo: { full_name: 'org/repo' } },
          head: { ref: 'takt/77/legacy-task', repo: { full_name: 'org/repo' } },
          body: '## Summary\n\nTask summary\n\n## Execution Report\n\nWorkflow `default` completed successfully.',
          labels: [],
          draft: false,
          updated_at: '2026-04-21T02:00:00Z',
        },
      ]));

    expect(listOpenPrs('/project')).toEqual([
      expect.objectContaining({
        number: 77,
        managed_by_takt: false,
      }),
    ]);
  });
});

describe('createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    vi.mocked(checkGhCli).mockReset();
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
  });

  it('draft: true の場合、args に --draft が含まれる', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/1\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: true,
    }, '/project');

    const call = mockExecFileSync.mock.calls.find((args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create');
    expect(call[1]).toContain('--draft');
  });

  it('draft: false の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/2\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: false,
    }, '/project');

    const call = mockExecFileSync.mock.calls.find((args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create');
    expect(call[1]).not.toContain('--draft');
  });

  it('draft が未指定の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/3\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
    }, '/project');

    const call = mockExecFileSync.mock.calls.find((args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create');
    expect(call[1]).not.toContain('--draft');
  });

  it('labels が指定された場合だけ --label をそのまま渡す', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/4\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      labels: ['release-blocker', 'automation'],
    }, '/project');

    const createCall = mockExecFileSync.mock.calls.find(
      (args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create',
    );
    expect(createCall?.[1]).toEqual(expect.arrayContaining([
      '--label',
      'release-blocker',
      '--label',
      'automation',
    ]));
  });

  it('labels 未指定時は label 関連の副作用を追加しない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/4\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
    }, '/project');

    const createCall = mockExecFileSync.mock.calls.find(
      (args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create',
    );
    expect(createCall?.[1]).not.toContain('--label');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('repo 指定時は PR 作成に同じ repo を使う', () => {
    mockExecFileSync.mockReturnValue('https://github.com/target/repo/pull/4\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      repo: 'target/repo',
    }, '/project');

    const createCall = mockExecFileSync.mock.calls.find(
      (args) => (args[1] as string[])[0] === 'pr' && (args[1] as string[])[1] === 'create',
    );
    expect(createCall?.[1]).toContain('--repo');
    expect(createCall?.[1]).toContain('target/repo');
  });
});

describe('mergePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    vi.mocked(checkGhCli).mockReset();
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
  });

  it('gh pr merge を --merge --delete-branch 付きで呼び出す', () => {
    mockExecFileSync.mockReturnValue('');

    const result = mergePr(42, '/project');

    expect(result).toEqual({ success: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '42', '--merge', '--delete-branch'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
  });

  it('gh CLI が利用不可なら失敗結果を返す', async () => {
    const { checkGhCli } = await import('../infra/github/issue.js');
    vi.mocked(checkGhCli).mockReturnValueOnce({ available: false, error: 'gh unavailable' });

    const result = mergePr(42, '/project');

    expect(result).toEqual({ success: false, error: 'gh unavailable' });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('gh pr merge が失敗した場合は success: false を返す', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('merge failed'); });

    const result = mergePr(42, '/project');

    expect(result.success).toBe(false);
    expect(result.error).toContain('merge failed');
  });
});

describe('closePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    vi.mocked(checkGhCli).mockReset();
    vi.mocked(checkGhCli).mockReturnValue({ available: true });
  });

  it('gh pr close を branch 削除なしで呼び出す', () => {
    const closePr = (githubPrModule as Record<string, unknown>).closePr as
      | ((prNumber: number, cwd: string) => { success: boolean; error?: string })
      | undefined;

    expect(closePr).toBeTypeOf('function');
    mockExecFileSync.mockReturnValue('');

    const result = closePr!(42, '/project');

    expect(result).toEqual({ success: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'close', '42'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    const args = mockExecFileSync.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--delete-branch');
    expect(args).not.toContain('--comment');
    expect(args).not.toContain('--body');
  });

  it('gh CLI が利用不可なら失敗結果を返す', async () => {
    const closePr = (githubPrModule as Record<string, unknown>).closePr as
      | ((prNumber: number, cwd: string) => { success: boolean; error?: string })
      | undefined;

    expect(closePr).toBeTypeOf('function');
    const { checkGhCli } = await import('../infra/github/issue.js');
    vi.mocked(checkGhCli).mockReturnValueOnce({ available: false, error: 'gh unavailable' });

    const result = closePr!(42, '/project');

    expect(result).toEqual({ success: false, error: 'gh unavailable' });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('gh pr close が失敗した場合は success: false を返す', () => {
    const closePr = (githubPrModule as Record<string, unknown>).closePr as
      | ((prNumber: number, cwd: string) => { success: boolean; error?: string })
      | undefined;

    expect(closePr).toBeTypeOf('function');
    mockExecFileSync.mockImplementation(() => { throw new Error('close failed'); });

    const result = closePr!(42, '/project');

    expect(result.success).toBe(false);
    expect(result.error).toContain('close failed');
  });
});

describe('buildPrBody', () => {
  it('should build body with single issue and report', () => {
    const issue: Issue = {
      number: 99,
      title: 'Add login feature',
      body: 'Implement username/password authentication.',
      labels: [],
      comments: [],
    };

    const result = buildPrBody([issue], 'Workflow `default` completed.');

    expect(result).toContain('## Summary');
    expect(result).toContain('Implement username/password authentication.');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Workflow `default` completed.');
    expect(result).toContain('Closes #99');
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });

  it('should use title when body is empty', () => {
    const issue: Issue = {
      number: 10,
      title: 'Fix bug',
      body: '',
      labels: [],
      comments: [],
    };

    const result = buildPrBody([issue], 'Done.');

    expect(result).toContain('Fix bug');
    expect(result).toContain('Closes #10');
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });

  it('should build body without issue', () => {
    const result = buildPrBody(undefined, 'Task completed.');

    expect(result).toContain('## Summary');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Task completed.');
    expect(result).not.toContain('Closes');
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });

  it('should support multiple issues', () => {
    const issues: Issue[] = [
      {
        number: 1,
        title: 'First issue',
        body: 'First issue body.',
        labels: [],
        comments: [],
      },
      {
        number: 2,
        title: 'Second issue',
        body: 'Second issue body.',
        labels: [],
        comments: [],
      },
    ];

    const result = buildPrBody(issues, 'Done.');

    expect(result).toContain('## Summary');
    expect(result).toContain('First issue body.');
    expect(result).toContain('Closes #1');
    expect(result).toContain('Closes #2');
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });

});

describe('fetchPrReviewComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
  });

  it('should return PrReviewData when gh pr view JSON is valid', () => {
    const ghResponse = {
      number: 456,
      title: 'Fix auth bug',
      body: 'PR description',
      url: 'https://github.com/org/repo/pull/456',
      baseRefName: 'release/main',
      headRefName: 'fix/auth-bug',
      comments: [
        { author: { login: 'commenter1' }, body: 'Please update tests' },
      ],
      reviews: [
        {
          author: { login: 'reviewer1' },
          body: 'Looks mostly good',
        },
        {
          author: { login: 'reviewer2' },
          body: '',
        },
      ],
      files: [
        { path: 'src/auth.ts' },
        { path: 'src/auth.test.ts' },
      ],
    };
    const activeThread = createReviewThread({
      id: 'thread-active-456',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Fix null check here',
          path: 'src/auth.ts',
          line: 42,
          originalLine: 40,
          url: 'https://github.com/org/repo/pull/456#discussion_r1',
          author: { login: 'reviewer1' },
        },
      ],
    });
    const resolvedThread = createReviewThread({
      id: 'thread-resolved-456',
      isResolved: true,
      isOutdated: true,
      resolvedBy: { login: 'coderabbitai[bot]' },
      comments: [
        {
          body: 'Already addressed in a later commit',
          path: 'src/auth.ts',
          line: null,
          originalLine: 12,
          url: 'https://github.com/org/repo/pull/456#discussion_r2',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([activeThread, resolvedThread]));
    const result = fetchPrReviewComments(456, '/project');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '456', '--json', 'number,title,body,url,headRefName,baseRefName,comments,reviews,files'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecFileSync.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      'owner=org',
      'repo=repo',
      'number=456',
    ]));
    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-f', 'owner=org');
    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-f', 'repo=repo');
    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-F', 'number=456');
    expect(result.number).toBe(456);
    expect(result.title).toBe('Fix auth bug');
    expect((result as { baseRefName?: string }).baseRefName).toBe('release/main');
    expect(result.headRefName).toBe('fix/auth-bug');
    expect(result.comments).toEqual([{ author: 'commenter1', body: 'Please update tests' }]);
    expect(result.reviews).toEqual([
      { author: 'reviewer1', body: 'Looks mostly good' },
      {
        author: 'reviewer1',
        body: 'Fix null check here',
        path: 'src/auth.ts',
        line: 42,
        url: 'https://github.com/org/repo/pull/456#discussion_r1',
        threadState: 'active',
        isOutdated: false,
      },
      {
        author: 'coderabbitai[bot]',
        body: 'Already addressed in a later commit',
        path: 'src/auth.ts',
        line: 12,
        url: 'https://github.com/org/repo/pull/456#discussion_r2',
        threadState: 'resolved',
        resolvedBy: 'coderabbitai[bot]',
        isOutdated: true,
      },
    ]);
    expect(result.files).toEqual(['src/auth.ts', 'src/auth.test.ts']);
  });

  it('should skip reviews with empty body', () => {
    const ghResponse = {
      number: 10,
      title: 'Approved PR',
      body: '',
      url: 'https://github.com/org/repo/pull/10',
      headRefName: 'feat/approved',
      comments: [],
      reviews: [
        { author: { login: 'approver' }, body: '' },
      ],
      files: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([]));
    const result = fetchPrReviewComments(10, '/project');
    expect(result.reviews).toEqual([]);
  });

  it('should include review thread comments even when review bodies are empty', () => {
    const ghResponse = {
      number: 11,
      title: 'Inline only',
      body: '',
      url: 'https://github.com/org/repo/pull/11',
      headRefName: 'fix/inline-only',
      comments: [],
      reviews: [
        { author: { login: 'approver' }, body: '' },
      ],
      files: [],
    };
    const thread = createReviewThread({
      id: 'thread-11',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Address this edge case',
          path: 'src/index.ts',
          line: 7,
          originalLine: 7,
          url: 'https://github.com/org/repo/pull/11#discussion_r1',
          author: { login: 'reviewer3' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([thread]));
    const result = fetchPrReviewComments(11, '/project');
    expect(result.reviews).toEqual([
      {
        author: 'reviewer3',
        body: 'Address this edge case',
        path: 'src/index.ts',
        line: 7,
        url: 'https://github.com/org/repo/pull/11#discussion_r1',
        threadState: 'active',
        isOutdated: false,
      },
    ]);
  });

  it('should classify unresolved outdated review threads separately from active threads', () => {
    const ghResponse = {
      number: 12,
      title: 'Outdated unresolved thread',
      body: '',
      url: 'https://github.com/org/repo/pull/12',
      headRefName: 'fix/outdated-thread',
      comments: [],
      reviews: [],
      files: [],
    };
    const thread = createReviewThread({
      id: 'thread-12',
      isResolved: false,
      isOutdated: true,
      comments: [
        {
          body: 'Confirm whether this stale diff still applies',
          path: 'src/index.ts',
          line: null,
          originalLine: 31,
          url: 'https://github.com/org/repo/pull/12#discussion_r1',
          author: { login: 'reviewer-outdated' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([thread]));
    const result = fetchPrReviewComments(12, '/project');
    expect(result.reviews).toEqual([
      {
        author: 'reviewer-outdated',
        body: 'Confirm whether this stale diff still applies',
        path: 'src/index.ts',
        line: 31,
        url: 'https://github.com/org/repo/pull/12#discussion_r1',
        threadState: 'outdated-unresolved',
        isOutdated: true,
      },
    ]);
  });

  it('should request additional GraphQL pages when reviewThreads has a next page', () => {
    const ghResponse = {
      number: 13,
      title: 'Paginated review threads',
      body: '',
      url: 'https://github.com/org/repo/pull/13',
      headRefName: 'fix/paginated-review-threads',
      comments: [],
      reviews: [],
      files: [],
    };
    const firstThread = createReviewThread({
      id: 'thread-13-first',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'First page comment',
          path: 'src/index.ts',
          line: 1,
          originalLine: 1,
          url: 'https://github.com/org/repo/pull/13#discussion_r1',
          author: { login: 'reviewer-pagination' },
        },
      ],
    });
    const secondThread = createReviewThread({
      id: 'thread-13-second',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Second page comment',
          path: 'src/index.ts',
          line: 101,
          originalLine: 101,
          url: 'https://github.com/org/repo/pull/13#discussion_r2',
          author: { login: 'reviewer-pagination' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse(
        [firstThread],
        { hasNextPage: true, endCursor: 'cursor-1' },
      ))
      .mockReturnValueOnce(withReviewThreadsResponse([secondThread]));
    const result = fetchPrReviewComments(13, '/project');
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    expect(mockExecFileSync.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      'number=13',
    ]));
    expect(mockExecFileSync.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      'endCursor=cursor-1',
    ]));
    expectGraphqlField(mockExecFileSync.mock.calls[2]?.[1], '-f', 'endCursor=cursor-1');
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]).toEqual({
      author: 'reviewer-pagination',
      body: 'First page comment',
      path: 'src/index.ts',
      line: 1,
      url: 'https://github.com/org/repo/pull/13#discussion_r1',
      threadState: 'active',
      isOutdated: false,
    });
    expect(result.reviews[1]).toEqual({
      author: 'reviewer-pagination',
      body: 'Second page comment',
      path: 'src/index.ts',
      line: 101,
      url: 'https://github.com/org/repo/pull/13#discussion_r2',
      threadState: 'active',
      isOutdated: false,
    });
  });

  it('should fallback to originalLine when line is null', () => {
    const ghResponse = {
      number: 14,
      title: 'Keep original line',
      body: '',
      url: 'https://github.com/org/repo/pull/14',
      headRefName: 'fix/original-line',
      comments: [],
      reviews: [],
      files: [],
    };
    const thread = createReviewThread({
      id: 'thread-14',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Line moved after suggestion',
          path: 'src/index.ts',
          line: null,
          originalLine: 27,
          url: 'https://github.com/org/repo/pull/14#discussion_r1',
          author: { login: 'reviewer-original-line' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([thread]));
    const result = fetchPrReviewComments(14, '/project');
    expect(result.reviews).toEqual([
      {
        author: 'reviewer-original-line',
        body: 'Line moved after suggestion',
        path: 'src/index.ts',
        line: 27,
        url: 'https://github.com/org/repo/pull/14#discussion_r1',
        threadState: 'active',
        isOutdated: false,
      },
    ]);
  });

  it('should preserve review thread comments from deleted GitHub users', () => {
    const ghResponse = {
      number: 16,
      title: 'Deleted author',
      body: '',
      url: 'https://github.com/org/repo/pull/16',
      headRefName: 'fix/deleted-author',
      comments: [],
      reviews: [],
      files: [],
    };
    const thread = createReviewThread({
      id: 'thread-16',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Comment from an unavailable account',
          path: 'src/index.ts',
          line: 19,
          originalLine: 19,
          url: 'https://github.com/org/repo/pull/16#discussion_r1',
          author: null,
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([thread]));
    const result = fetchPrReviewComments(16, '/project');
    expect(result.reviews).toEqual([
      {
        author: 'deleted GitHub user',
        body: 'Comment from an unavailable account',
        path: 'src/index.ts',
        line: 19,
        url: 'https://github.com/org/repo/pull/16#discussion_r1',
        threadState: 'active',
        isOutdated: false,
      },
    ]);
  });

  it('should fetch additional GraphQL pages when a review thread has more comments', () => {
    const ghResponse = {
      number: 15,
      title: 'Large review thread',
      body: '',
      url: 'https://github.com/org/repo/pull/15',
      headRefName: 'fix/large-thread',
      comments: [],
      reviews: [],
      files: [],
    };
    const thread = {
      id: 'thread-15-large',
      isResolved: false,
      isOutdated: false,
      resolvedBy: null,
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
        nodes: [
          {
            body: 'First fetched thread comment',
            path: 'src/index.ts',
            line: 1,
            originalLine: 1,
            url: 'https://github.com/org/repo/pull/15#discussion_r1',
            author: { login: 'reviewer-large-thread' },
          },
        ],
      },
    };
    const secondPageComment = {
      body: 'Second fetched thread comment',
      path: 'src/index.ts',
      line: 2,
      originalLine: 2,
      url: 'https://github.com/org/repo/pull/15#discussion_r2',
      author: { login: 'reviewer-large-thread' },
    };

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([thread]))
      .mockReturnValueOnce(withReviewThreadCommentsResponse([secondPageComment]));

    const result = fetchPrReviewComments(15, '/project');

    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    expect(mockExecFileSync.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      'api',
      'graphql',
      'threadId=thread-15-large',
      'commentsEndCursor=comment-cursor-1',
    ]));
    expectGraphqlField(mockExecFileSync.mock.calls[2]?.[1], '-f', 'threadId=thread-15-large');
    expectGraphqlField(mockExecFileSync.mock.calls[2]?.[1], '-f', 'commentsEndCursor=comment-cursor-1');
    expect(result.reviews).toEqual([
      {
        author: 'reviewer-large-thread',
        body: 'First fetched thread comment',
        path: 'src/index.ts',
        line: 1,
        url: 'https://github.com/org/repo/pull/15#discussion_r1',
        threadState: 'active',
        isOutdated: false,
      },
      {
        author: 'reviewer-large-thread',
        body: 'Second fetched thread comment',
        path: 'src/index.ts',
        line: 2,
        url: 'https://github.com/org/repo/pull/15#discussion_r2',
        threadState: 'active',
        isOutdated: false,
      },
    ]);
  });

  it('should pass GraphQL string variables as raw fields', () => {
    const ghResponse = {
      number: 17,
      title: 'Raw GraphQL fields',
      body: '',
      url: 'https://github.com/@org/@repo/pull/17',
      headRefName: 'fix/raw-graphql-fields',
      comments: [],
      reviews: [],
      files: [],
    };
    const thread = createReviewThread({
      id: '@/tmp/thread-id',
      isResolved: false,
      isOutdated: false,
      commentsPageInfo: { hasNextPage: true, endCursor: '@/tmp/comment-cursor' },
      comments: [
        {
          body: 'First page comment',
          path: 'src/index.ts',
          line: 1,
          originalLine: 1,
          url: 'https://github.com/org/repo/pull/17#discussion_r1',
          author: { login: 'reviewer-raw-field' },
        },
      ],
    });
    const nextComment = {
      body: 'Second page comment',
      path: 'src/index.ts',
      line: 2,
      originalLine: 2,
      url: 'https://github.com/org/repo/pull/17#discussion_r2',
      author: { login: 'reviewer-raw-field' },
    };

    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse(
        [thread],
        { hasNextPage: true, endCursor: '@/tmp/thread-cursor' },
      ))
      .mockReturnValueOnce(withReviewThreadCommentsResponse([nextComment]))
      .mockReturnValueOnce(withReviewThreadsResponse([]));

    fetchPrReviewComments(17, '/project');

    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-f', 'owner=@org');
    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-f', 'repo=@repo');
    expectGraphqlField(mockExecFileSync.mock.calls[1]?.[1], '-F', 'number=17');
    expectGraphqlField(mockExecFileSync.mock.calls[2]?.[1], '-f', 'threadId=@/tmp/thread-id');
    expectGraphqlField(mockExecFileSync.mock.calls[2]?.[1], '-f', 'commentsEndCursor=@/tmp/comment-cursor');
    expectGraphqlField(mockExecFileSync.mock.calls[3]?.[1], '-f', 'endCursor=@/tmp/thread-cursor');
  });

  it('should pass cwd to all execFileSync calls', () => {
    const ghResponse = {
      number: 50,
      title: 'cwd test',
      body: '',
      url: 'https://github.com/org/repo/pull/50',
      headRefName: 'fix/cwd',
      comments: [],
      reviews: [],
      files: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([]));
    fetchPrReviewComments(50, '/worktree/clone');
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ cwd: '/worktree/clone' }));
    }
  });

  it('should preserve fetched thread state through task formatting', () => {
    const ghResponse = {
      number: 51,
      title: 'Formatter handoff',
      body: '',
      url: 'https://github.com/org/repo/pull/51',
      headRefName: 'fix/formatter-handoff',
      comments: [],
      reviews: [],
      files: [],
    };
    const activeThread = createReviewThread({
      id: 'thread-51-active',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          body: 'Active comment',
          path: 'src/active.ts',
          line: 10,
          originalLine: 10,
          url: 'https://github.com/org/repo/pull/51#discussion_r1',
          author: { login: 'active-reviewer' },
        },
      ],
    });
    const resolvedThread = createReviewThread({
      id: 'thread-51-resolved',
      isResolved: true,
      isOutdated: true,
      resolvedBy: { login: 'maintainer' },
      comments: [
        {
          body: 'Resolved comment',
          path: 'src/resolved.ts',
          line: 20,
          originalLine: 20,
          url: 'https://github.com/org/repo/pull/51#discussion_r2',
          author: { login: 'resolved-reviewer' },
        },
      ],
    });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(withReviewThreadsResponse([activeThread, resolvedThread]));
    const prReview = fetchPrReviewComments(51, '/project');
    const task = formatPrReviewAsTask(prReview);
    expect(task).toContain('### Active Review Threads');
    expect(task).toContain('**active-reviewer**: Active comment');
    expect(task).toContain('### Resolved / Outdated Review Threads');
    expect(task).toContain('**resolved-reviewer**: Resolved comment');
    expect(task).toContain('Resolved by: maintainer');
    expect(task).not.toContain('### Review Comments');
  });

  it('should throw a clear error when GraphQL reviewThreads cannot be fetched', () => {
    const ghResponse = {
      number: 52,
      title: 'GraphQL failure',
      body: '',
      url: 'https://github.com/org/repo/pull/52',
      headRefName: 'fix/graphql-failure',
      comments: [],
      reviews: [],
      files: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockImplementationOnce(() => {
        throw new Error('gh api graphql failed');
      });
    expect(() => fetchPrReviewComments(52, '/project')).toThrow('GraphQL reviewThreads failed');
  });

  it('should throw when gh CLI fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: PR not found'); });
    expect(() => fetchPrReviewComments(999, '/project')).toThrow('gh: PR not found');
  });
});

describe('formatPrReviewAsTask', () => {
  it('should format PR review data with all sections', () => {
    const prReview: PrReviewData = {
      number: 456,
      title: 'Fix auth bug',
      body: 'PR description text',
      url: 'https://github.com/org/repo/pull/456',
      headRefName: 'fix/auth-bug',
      comments: [
        { author: 'commenter1', body: 'Can you also update the tests?' },
      ],
      reviews: [
        {
          author: 'reviewer1',
          body: 'Fix the null check in auth.ts',
          path: 'src/auth.ts',
          line: 42,
          threadState: 'active',
          isOutdated: false,
        },
        { author: 'reviewer2', body: 'This function should handle edge cases' },
      ],
      files: ['src/auth.ts', 'src/auth.test.ts'],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('## PR #456 Review Comments: Fix auth bug');
    expect(result).toContain('### PR Description');
    expect(result).toContain('PR description text');
    expect(result).toContain('### Review Policy');
    expect(result).toContain('### Review Summaries');
    expect(result).toContain('### Active Review Threads');
    expect(result).toContain('**reviewer1**: Fix the null check in auth.ts');
    expect(result).toContain('File: src/auth.ts, Line: 42');
    expect(result).toContain('**reviewer2**: This function should handle edge cases');
    expect(result).toContain('### Conversation Comments');
    expect(result).toContain('**commenter1**: Can you also update the tests?');
    expect(result).toContain('### Changed Files');
    expect(result).toContain('- src/auth.ts');
    expect(result).toContain('- src/auth.test.ts');
  });

  it('should omit PR Description when body is empty', () => {
    const prReview: PrReviewData = {
      number: 10,
      title: 'Quick fix',
      body: '',
      url: 'https://github.com/org/repo/pull/10',
      headRefName: 'fix/quick',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Fix this' }],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).not.toContain('### PR Description');
    expect(result).toContain('### Review Summaries');
  });

  it('should omit empty sections', () => {
    const prReview: PrReviewData = {
      number: 20,
      title: 'Empty review',
      body: '',
      url: 'https://github.com/org/repo/pull/20',
      headRefName: 'feat/empty',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Add tests' }],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).not.toContain('### Conversation Comments');
    expect(result).not.toContain('### Changed Files');
    expect(result).toContain('### Review Summaries');
  });

  it('should format inline comment with path but no line', () => {
    const prReview: PrReviewData = {
      number: 30,
      title: 'Path only',
      body: '',
      url: 'https://github.com/org/repo/pull/30',
      headRefName: 'feat/path-only',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Fix this', path: 'src/index.ts' }],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('File: src/index.ts');
    expect(result).not.toContain('Line:');
  });
});
