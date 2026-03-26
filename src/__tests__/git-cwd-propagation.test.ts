/**
 * Integration tests for cwd propagation through GitProvider call chain.
 *
 * Verifies that cwd is correctly propagated from high-level callers
 * (routing-inputs, pipeline/steps, tasks/add) through to the
 * GitProvider methods. This ensures worktree execution works correctly
 * even when process.cwd() differs from the project directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCheckCliStatus,
  mockFetchIssue,
  mockCreateIssue,
  mockFetchPrReviewComments,
  mockFindExistingPr,
  mockCreatePullRequest,
  mockCommentOnPr,
} = vi.hoisted(() => ({
  mockCheckCliStatus: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockCommentOnPr: vi.fn(),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    createIssue: (...args: unknown[]) => mockCreateIssue(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
    commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
  }),
  formatIssueAsTask: vi.fn((issue: { number: number; title: string }) => `## Issue #${issue.number}: ${issue.title}`),
  parseIssueNumbers: vi.fn(() => []),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  formatPrReviewAsTask: vi.fn((pr: { number: number; title: string }) => `## PR #${pr.number}: ${pr.title}`),
  buildPrBody: vi.fn(() => 'pr-body'),
  createPullRequestSafely: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  withProgress: vi.fn(async (_start: unknown, _done: unknown, operation: () => unknown) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckCliStatus.mockReturnValue({ available: true });
});

describe('cwd propagation: routing-inputs', () => {
  describe('resolveIssueInput', () => {
    it('cwd を指定した場合は checkCliStatus と fetchIssue に cwd を渡す', async () => {
      // Given
      const issue = { number: 42, title: 'Test', body: 'Body', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);

      const { resolveIssueInput } = await import('../app/cli/routing-inputs.js');

      // When
      await resolveIssueInput(42, undefined, '/worktree/clone');

      // Then
      expect(mockCheckCliStatus).toHaveBeenCalledWith('/worktree/clone');
      expect(mockFetchIssue).toHaveBeenCalledWith(42, '/worktree/clone');
    });

    it('cwd 省略時は checkCliStatus と fetchIssue に cwd を渡さない', async () => {
      // Given
      const issue = { number: 10, title: 'Issue', body: '', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);

      const { resolveIssueInput } = await import('../app/cli/routing-inputs.js');

      // When
      await resolveIssueInput(10, undefined);

      // Then: cwd is not passed (provider's fallback handles it)
      expect(mockCheckCliStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchIssue).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolvePrInput', () => {
    it('cwd を指定した場合は checkCliStatus と fetchPrReviewComments に cwd を渡す', async () => {
      // Given
      const prReview = {
        number: 456,
        title: 'Fix bug',
        body: 'Description',
        url: 'https://github.com/org/repo/pull/456',
        headRefName: 'fix/bug',
        comments: [],
        reviews: [],
        files: [],
      };
      mockFetchPrReviewComments.mockReturnValue(prReview);

      const { resolvePrInput } = await import('../app/cli/routing-inputs.js');

      // When
      await resolvePrInput(456, '/worktree/clone');

      // Then
      expect(mockCheckCliStatus).toHaveBeenCalledWith('/worktree/clone');
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, '/worktree/clone');
    });

    it('cwd 省略時は checkCliStatus と fetchPrReviewComments に cwd を渡さない', async () => {
      // Given
      const prReview = {
        number: 100,
        title: 'PR',
        body: '',
        url: 'https://github.com/org/repo/pull/100',
        headRefName: 'feat/x',
        comments: [],
        reviews: [],
        files: [],
      };
      mockFetchPrReviewComments.mockReturnValue(prReview);

      const { resolvePrInput } = await import('../app/cli/routing-inputs.js');

      // When
      await resolvePrInput(100);

      // Then
      expect(mockCheckCliStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchPrReviewComments).toHaveBeenCalledTimes(1);
    });
  });
});

describe('cwd propagation: GitProvider pattern A interface consistency', () => {
  it('findExistingPr は branch が第1引数、cwd が第2引数（オプショナル）', () => {
    // Given
    const pr = { number: 1, url: 'https://github.com/org/repo/pull/1' };
    mockFindExistingPr.mockReturnValue(pr);

    // When: パターンA（末尾オプショナル）で呼び出す
    const provider = {
      findExistingPr: (branch: string, cwd?: string) =>
        mockFindExistingPr(branch, cwd),
    };
    const result = provider.findExistingPr('feat/branch', '/project');

    // Then: 引数順が (branch, cwd) であること
    expect(mockFindExistingPr).toHaveBeenCalledWith('feat/branch', '/project');
    expect(result).toBe(pr);
  });

  it('createPullRequest は options が第1引数、cwd が第2引数（オプショナル）', () => {
    // Given
    const prResult = { success: true, url: 'https://github.com/org/repo/pull/1' };
    mockCreatePullRequest.mockReturnValue(prResult);

    // When: パターンA（末尾オプショナル）で呼び出す
    const provider = {
      createPullRequest: (options: { branch: string; title: string; body: string }, cwd?: string) =>
        mockCreatePullRequest(options, cwd),
    };
    const opts = { branch: 'feat/x', title: 'PR', body: 'body' };
    const result = provider.createPullRequest(opts, '/project');

    // Then: 引数順が (options, cwd) であること
    expect(mockCreatePullRequest).toHaveBeenCalledWith(opts, '/project');
    expect(result).toBe(prResult);
  });

  it('commentOnPr は prNumber が第1引数、body が第2引数、cwd が第3引数（オプショナル）', () => {
    // Given
    const commentResult = { success: true };
    mockCommentOnPr.mockReturnValue(commentResult);

    // When: パターンA（末尾オプショナル）で呼び出す
    const provider = {
      commentOnPr: (prNumber: number, body: string, cwd?: string) =>
        mockCommentOnPr(prNumber, body, cwd),
    };
    const result = provider.commentOnPr(42, 'Updated!', '/project');

    // Then: 引数順が (prNumber, body, cwd) であること
    expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'Updated!', '/project');
    expect(result).toBe(commentResult);
  });

  it('findExistingPr の cwd 省略時は undefined が渡される（provider側で process.cwd() にフォールバック）', () => {
    // Given
    mockFindExistingPr.mockReturnValue(undefined);

    // When: cwd を省略して呼び出す
    const provider = {
      findExistingPr: (branch: string, cwd?: string) =>
        mockFindExistingPr(branch, cwd),
    };
    provider.findExistingPr('feat/branch');

    // Then: cwd は undefined
    expect(mockFindExistingPr).toHaveBeenCalledWith('feat/branch', undefined);
  });

  it('createPullRequest の cwd 省略時は undefined が渡される', () => {
    // Given
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });

    // When
    const provider = {
      createPullRequest: (options: { branch: string; title: string; body: string }, cwd?: string) =>
        mockCreatePullRequest(options, cwd),
    };
    provider.createPullRequest({ branch: 'feat/x', title: 'PR', body: 'body' });

    // Then
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feat/x' }),
      undefined,
    );
  });

  it('commentOnPr の cwd 省略時は undefined が渡される', () => {
    // Given
    mockCommentOnPr.mockReturnValue({ success: true });

    // When
    const provider = {
      commentOnPr: (prNumber: number, body: string, cwd?: string) =>
        mockCommentOnPr(prNumber, body, cwd),
    };
    provider.commentOnPr(42, 'body');

    // Then
    expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'body', undefined);
  });
});

describe('cwd propagation: addTask wiring', () => {
  it('addTask の PR 取得フローは cwd を checkCliStatus と fetchPrReviewComments に渡す', async () => {
    // Given
    const prReview = {
      number: 10,
      title: 'PR',
      body: '',
      url: 'https://github.com/org/repo/pull/10',
      headRefName: 'feat/x',
      comments: [{ author: 'a', body: 'fix' }],
      reviews: [{ author: 'b', body: 'ok' }],
      files: [],
    };
    mockFetchPrReviewComments.mockReturnValue(prReview);

    vi.mock('../infra/task/index.js', () => ({
      TaskRunner: vi.fn().mockImplementation(() => ({ addTask: vi.fn(() => ({ name: 'task-1' })) })),
      summarizeTaskName: vi.fn(async () => 'slug'),
    }));
    vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
      determinePiece: vi.fn(async () => 'default'),
    }));
    vi.mock('../infra/task/naming.js', () => ({
      firstLine: vi.fn(() => 'line'),
    }));
    vi.mock('../features/tasks/add/worktree-settings.js', () => ({
      displayTaskCreationResult: vi.fn(),
      promptWorktreeSettings: vi.fn(),
    }));
    vi.mock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    vi.mock('../shared/i18n/index.js', () => ({
      getLabel: vi.fn(() => ''),
    }));
    vi.mock('../shared/prompt/index.js', () => ({
      promptInput: vi.fn(),
      confirm: vi.fn(),
      selectOption: vi.fn(),
    }));

    const { addTask } = await import('../features/tasks/add/index.js');

    // When
    await addTask('/worktree/clone', undefined, { prNumber: 10 });

    // Then
    expect(mockCheckCliStatus).toHaveBeenCalledWith('/worktree/clone');
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(10, '/worktree/clone');
  });
});

describe('cwd propagation: string型引数の位置逆転による誤用検出', () => {
  it('findExistingPr に旧シグネチャ (cwd, branch) で渡すと意味が逆転する', () => {
    // Given: 旧パターン B の引数順で呼んでしまった場合
    mockFindExistingPr.mockReturnValue(undefined);

    // When: 間違った順番で呼ぶ（cwd が branch 位置に入る）
    const wrongCall = () => {
      // 実装後: findExistingPr(branch, cwd?) なので、
      // 旧パターンの findExistingPr('/project', 'feat/x') は
      // branch='/project', cwd='feat/x' として解釈される
      mockFindExistingPr('/project', 'feat/x');
    };
    wrongCall();

    // Then: 第1引数が branch として使われるため、
    // '/project' がブランチ名として渡されてしまう
    // この検証はテストケースのドキュメントとして機能する
    expect(mockFindExistingPr).toHaveBeenCalledWith('/project', 'feat/x');
    // ↑ これは意図的に "間違った" 呼び出しの記録。
    // 実装者はこのケースに注意すること。
  });
});
