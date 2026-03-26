/**
 * Tests for GitHubProvider and getGitProvider factory.
 *
 * GitHubProvider should delegate each method to the corresponding function
 * in github/issue.ts and github/pr.ts.
 * getGitProvider() should return a singleton GitProvider instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCheckGhCli,
  mockFetchIssue,
  mockCreateIssue,
  mockFindExistingPr,
  mockCommentOnPr,
  mockCreatePullRequest,
  mockFetchPrReviewComments,
} = vi.hoisted(() => ({
  mockCheckGhCli: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockCommentOnPr: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
}));

vi.mock('../infra/github/issue.js', () => ({
  checkGhCli: (...args: unknown[]) => mockCheckGhCli(...args),
  fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
}));

vi.mock('../infra/github/pr.js', () => ({
  findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
  commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
  createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
}));

import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { getGitProvider } from '../infra/git/index.js';
import type { CommentResult, PrReviewData } from '../infra/git/index.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubProvider', () => {
  describe('checkCliStatus', () => {
    it('checkGhCli() の結果をそのまま返す', () => {
      // Given
      const status = { available: true };
      mockCheckGhCli.mockReturnValue(status);
      const provider = new GitHubProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(mockCheckGhCli).toHaveBeenCalledWith(process.cwd());
      expect(result).toBe(status);
    });

    it('gh CLI が利用不可の場合は available: false を返す', () => {
      // Given
      mockCheckGhCli.mockReturnValue({ available: false, error: 'gh is not installed' });
      const provider = new GitHubProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(mockCheckGhCli).toHaveBeenCalledWith(process.cwd());
      expect(result.available).toBe(false);
      expect(result.error).toBe('gh is not installed');
    });

    it('cwd を指定した場合は checkGhCli にそのまま転送する', () => {
      // Given
      const status = { available: true };
      mockCheckGhCli.mockReturnValue(status);
      const provider = new GitHubProvider();

      // When
      const result = provider.checkCliStatus('/worktree/clone');

      // Then
      expect(mockCheckGhCli).toHaveBeenCalledWith('/worktree/clone');
      expect(result).toBe(status);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      mockCheckGhCli.mockReturnValue({ available: true });
      const provider = new GitHubProvider();

      // When
      provider.checkCliStatus();

      // Then
      expect(mockCheckGhCli).toHaveBeenCalledWith(process.cwd());
    });
  });

  describe('fetchIssue', () => {
    it('fetchIssue(n) に委譲し結果を返す', () => {
      // Given
      const issue = { number: 42, title: 'Test issue', body: 'Body', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);
      const provider = new GitHubProvider();

      // When
      const result = provider.fetchIssue(42);

      // Then
      expect(mockFetchIssue).toHaveBeenCalledWith(42, process.cwd());
      expect(result).toBe(issue);
    });

    it('cwd を指定した場合は fetchIssue にそのまま転送する', () => {
      // Given
      const issue = { number: 10, title: 'Issue', body: '', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);
      const provider = new GitHubProvider();

      // When
      const result = provider.fetchIssue(10, '/worktree/clone');

      // Then
      expect(mockFetchIssue).toHaveBeenCalledWith(10, '/worktree/clone');
      expect(result).toBe(issue);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const issue = { number: 20, title: 'Issue', body: '', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);
      const provider = new GitHubProvider();

      // When
      provider.fetchIssue(20);

      // Then
      expect(mockFetchIssue).toHaveBeenCalledWith(20, process.cwd());
    });
  });

  describe('createIssue', () => {
    it('createIssue(opts) に委譲し結果を返す', () => {
      // Given
      const opts = { title: 'New issue', body: 'Description' };
      const issueResult = { success: true, url: 'https://github.com/org/repo/issues/1' };
      mockCreateIssue.mockReturnValue(issueResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
      expect(result).toBe(issueResult);
    });

    it('ラベルを含む場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { title: 'Bug', body: 'Details', labels: ['bug', 'urgent'] };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/org/repo/issues/2' });
      const provider = new GitHubProvider();

      // When
      provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
    });

    it('cwd を指定した場合は createIssue にそのまま転送する', () => {
      // Given
      const opts = { title: 'Issue', body: 'Body' };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/org/repo/issues/3' });
      const provider = new GitHubProvider();

      // When
      provider.createIssue(opts, '/worktree/clone');

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const opts = { title: 'Issue', body: 'Body' };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/org/repo/issues/4' });
      const provider = new GitHubProvider();

      // When
      provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
    });
  });

  describe('findExistingPr', () => {
    it('findExistingPr(branch, cwd) に委譲し PR を返す', () => {
      // Given
      const pr = { number: 10, url: 'https://github.com/org/repo/pull/10' };
      mockFindExistingPr.mockReturnValue(pr);
      const provider = new GitHubProvider();

      // When
      const result = provider.findExistingPr('feat/my-feature', '/project');

      // Then
      expect(mockFindExistingPr).toHaveBeenCalledWith('feat/my-feature', '/project');
      expect(result).toBe(pr);
    });

    it('PR が存在しない場合は undefined を返す', () => {
      // Given
      mockFindExistingPr.mockReturnValue(undefined);
      const provider = new GitHubProvider();

      // When
      const result = provider.findExistingPr('feat/no-pr', '/project');

      // Then
      expect(result).toBeUndefined();
    });

    it('cwd を指定した場合は findExistingPr にそのまま転送する', () => {
      // Given
      const pr = { number: 20, url: 'https://github.com/org/repo/pull/20' };
      mockFindExistingPr.mockReturnValue(pr);
      const provider = new GitHubProvider();

      // When
      const result = provider.findExistingPr('feat/branch', '/worktree/clone');

      // Then
      expect(mockFindExistingPr).toHaveBeenCalledWith('feat/branch', '/worktree/clone');
      expect(result).toBe(pr);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      mockFindExistingPr.mockReturnValue(undefined);
      const provider = new GitHubProvider();

      // When
      provider.findExistingPr('feat/branch');

      // Then
      expect(mockFindExistingPr).toHaveBeenCalledWith('feat/branch', process.cwd());
    });
  });

  describe('createPullRequest', () => {
    it('createPullRequest(opts, cwd) に委譲し結果を返す', () => {
      // Given
      const opts = { branch: 'feat/new', title: 'My PR', body: 'PR body', draft: false };
      const prResult = { success: true, url: 'https://github.com/org/repo/pull/5' };
      mockCreatePullRequest.mockReturnValue(prResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.createPullRequest(opts, '/project');

      // Then
      expect(mockCreatePullRequest).toHaveBeenCalledWith(opts, '/project');
      expect(result).toBe(prResult);
    });

    it('draft: true の場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { branch: 'feat/draft', title: 'Draft PR', body: 'body', draft: true };
      mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/6' });
      const provider = new GitHubProvider();

      // When
      provider.createPullRequest(opts, '/project');

      // Then
      expect(mockCreatePullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }), '/project');
    });

    it('cwd を指定した場合は createPullRequest にそのまま転送する', () => {
      // Given
      const opts = { branch: 'feat/x', title: 'PR', body: 'body', draft: false };
      mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/7' });
      const provider = new GitHubProvider();

      // When
      provider.createPullRequest(opts, '/worktree/clone');

      // Then
      expect(mockCreatePullRequest).toHaveBeenCalledWith(opts, '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const opts = { branch: 'feat/y', title: 'PR', body: 'body', draft: false };
      mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/8' });
      const provider = new GitHubProvider();

      // When
      provider.createPullRequest(opts);

      // Then
      expect(mockCreatePullRequest).toHaveBeenCalledWith(opts, process.cwd());
    });
  });

  describe('commentOnPr', () => {
    it('commentOnPr(prNumber, body, cwd) に委譲し CommentResult を返す', () => {
      const commentResult: CommentResult = { success: true };
      mockCommentOnPr.mockReturnValue(commentResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.commentOnPr(42, 'Updated!', '/project');

      // Then
      expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'Updated!', '/project');
      expect(result).toBe(commentResult);
    });

    it('コメント失敗時はエラー結果を委譲して返す', () => {
      // Given
      const commentResult: CommentResult = { success: false, error: 'Permission denied' };
      mockCommentOnPr.mockReturnValue(commentResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.commentOnPr(42, 'comment', '/project');

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('cwd を指定した場合は commentOnPr にそのまま転送する', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnPr.mockReturnValue(commentResult);
      const provider = new GitHubProvider();

      // When
      provider.commentOnPr(10, 'body', '/worktree/clone');

      // Then
      expect(mockCommentOnPr).toHaveBeenCalledWith(10, 'body', '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnPr.mockReturnValue(commentResult);
      const provider = new GitHubProvider();

      // When
      provider.commentOnPr(10, 'body');

      // Then
      expect(mockCommentOnPr).toHaveBeenCalledWith(10, 'body', process.cwd());
    });
  });

  describe('fetchPrReviewComments', () => {
    it('fetchPrReviewComments(n) に委譲し結果を返す', () => {
      // Given
      const prReview: PrReviewData = {
        number: 456,
        title: 'Fix bug',
        body: 'Description',
        url: 'https://github.com/org/repo/pull/456',
        headRefName: 'fix/bug',
        comments: [],
        reviews: [{ author: 'reviewer', body: 'Fix this' }],
        files: ['src/index.ts'],
      };
      mockFetchPrReviewComments.mockReturnValue(prReview);
      const provider = new GitHubProvider();

      // When
      const result = provider.fetchPrReviewComments(456);

      // Then
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, process.cwd());
      expect(result).toBe(prReview);
    });

    it('cwd を指定した場合は fetchPrReviewComments にそのまま転送する', () => {
      // Given
      const prReview: PrReviewData = {
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
      const provider = new GitHubProvider();

      // When
      const result = provider.fetchPrReviewComments(100, '/worktree/clone');

      // Then
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(100, '/worktree/clone');
      expect(result).toBe(prReview);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const prReview: PrReviewData = {
        number: 200,
        title: 'PR',
        body: '',
        url: 'https://github.com/org/repo/pull/200',
        headRefName: 'feat/y',
        comments: [],
        reviews: [],
        files: [],
      };
      mockFetchPrReviewComments.mockReturnValue(prReview);
      const provider = new GitHubProvider();

      // When
      provider.fetchPrReviewComments(200);

      // Then
      expect(mockFetchPrReviewComments).toHaveBeenCalledWith(200, process.cwd());
    });
  });
});

describe('getGitProvider', () => {
  it('GitProvider インターフェースを実装するインスタンスを返す', () => {
    // When
    const provider = getGitProvider();

    // Then
    expect(typeof provider.checkCliStatus).toBe('function');
    expect(typeof provider.fetchIssue).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.fetchPrReviewComments).toBe('function');
    expect(typeof provider.findExistingPr).toBe('function');
    expect(typeof provider.createPullRequest).toBe('function');
    expect(typeof provider.commentOnPr).toBe('function');
  });

  it('呼び出しのたびに同じインスタンスを返す（シングルトン）', () => {
    // When
    const provider1 = getGitProvider();
    const provider2 = getGitProvider();

    // Then
    expect(provider1).toBe(provider2);
  });
});
