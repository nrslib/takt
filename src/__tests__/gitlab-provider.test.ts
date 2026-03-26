/**
 * Tests for GitLabProvider delegation and GitProvider factory integration.
 *
 * GitLabProvider should delegate each method to the corresponding function
 * in gitlab/issue.ts and gitlab/pr.ts, mirroring the GitHubProvider pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCheckGlabCli,
  mockFetchIssue,
  mockCreateIssue,
  mockFindExistingMr,
  mockCommentOnMr,
  mockCreateMergeRequest,
  mockFetchMrReviewComments,
} = vi.hoisted(() => ({
  mockCheckGlabCli: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockFindExistingMr: vi.fn(),
  mockCommentOnMr: vi.fn(),
  mockCreateMergeRequest: vi.fn(),
  mockFetchMrReviewComments: vi.fn(),
}));

vi.mock('../infra/gitlab/utils.js', () => ({
  checkGlabCli: (...args: unknown[]) => mockCheckGlabCli(...args),
  parseJson: (raw: string, context: string) => {
    try { return JSON.parse(raw); } catch { throw new Error(`glab returned invalid JSON (${context})`); }
  },
  fetchAllPages: vi.fn(),
}));

vi.mock('../infra/gitlab/issue.js', () => ({
  fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
}));

vi.mock('../infra/gitlab/pr.js', () => ({
  findExistingMr: (...args: unknown[]) => mockFindExistingMr(...args),
  commentOnMr: (...args: unknown[]) => mockCommentOnMr(...args),
  createMergeRequest: (...args: unknown[]) => mockCreateMergeRequest(...args),
  fetchMrReviewComments: (...args: unknown[]) => mockFetchMrReviewComments(...args),
}));

import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import type { CommentResult, PrReviewData } from '../infra/git/types.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitLabProvider', () => {
  describe('checkCliStatus', () => {
    it('checkGlabCli() の結果をそのまま返す', () => {
      // Given
      const status = { available: true };
      mockCheckGlabCli.mockReturnValue(status);
      const provider = new GitLabProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(mockCheckGlabCli).toHaveBeenCalledWith(process.cwd());
      expect(result).toBe(status);
    });

    it('glab CLI が利用不可の場合は available: false を返す', () => {
      // Given
      mockCheckGlabCli.mockReturnValue({ available: false, error: 'glab is not installed' });
      const provider = new GitLabProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(mockCheckGlabCli).toHaveBeenCalledWith(process.cwd());
      expect(result.available).toBe(false);
      expect(result.error).toBe('glab is not installed');
    });

    it('glab CLI が認証未済の場合は available: false を返す', () => {
      // Given
      mockCheckGlabCli.mockReturnValue({
        available: false,
        error: 'glab CLI is installed but not authenticated. Run `glab auth login` first.',
      });
      const provider = new GitLabProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(mockCheckGlabCli).toHaveBeenCalledWith(process.cwd());
      expect(result.available).toBe(false);
      expect(result.error).toContain('not authenticated');
    });

    it('cwd を指定した場合は checkGlabCli にそのまま転送する', () => {
      // Given
      const status = { available: true };
      mockCheckGlabCli.mockReturnValue(status);
      const provider = new GitLabProvider();

      // When
      const result = provider.checkCliStatus('/my/project');

      // Then
      expect(mockCheckGlabCli).toHaveBeenCalledWith('/my/project');
      expect(result).toBe(status);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      mockCheckGlabCli.mockReturnValue({ available: true });
      const provider = new GitLabProvider();

      // When
      provider.checkCliStatus();

      // Then
      expect(mockCheckGlabCli).toHaveBeenCalledWith(process.cwd());
    });
  });

  describe('fetchIssue', () => {
    it('fetchIssue(n, cwd) に委譲し結果を返す', () => {
      // Given
      const issue = { number: 42, title: 'Test issue', body: 'Body', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);
      const provider = new GitLabProvider();

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
      const provider = new GitLabProvider();

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
      const provider = new GitLabProvider();

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
      const issueResult = { success: true, url: 'https://gitlab.com/org/repo/-/issues/1' };
      mockCreateIssue.mockReturnValue(issueResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
      expect(result).toBe(issueResult);
    });

    it('ラベルを含む場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { title: 'Bug', body: 'Details', labels: ['bug', 'urgent'] };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/issues/2' });
      const provider = new GitLabProvider();

      // When
      provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
    });

    it('cwd を指定した場合は createIssue にそのまま転送する', () => {
      // Given
      const opts = { title: 'Issue', body: 'Body' };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/issues/3' });
      const provider = new GitLabProvider();

      // When
      provider.createIssue(opts, '/my/project');

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, '/my/project');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const opts = { title: 'Issue', body: 'Body' };
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/issues/4' });
      const provider = new GitLabProvider();

      // When
      provider.createIssue(opts);

      // Then
      expect(mockCreateIssue).toHaveBeenCalledWith(opts, process.cwd());
    });
  });

  describe('fetchPrReviewComments', () => {
    it('fetchMrReviewComments(n, cwd) に委譲し結果を返す', () => {
      // Given
      const prReview: PrReviewData = {
        number: 456,
        title: 'Fix bug',
        body: 'Description',
        url: 'https://gitlab.com/org/repo/-/merge_requests/456',
        headRefName: 'fix/bug',
        comments: [],
        reviews: [{ author: 'reviewer', body: 'Fix this' }],
        files: ['src/index.ts'],
      };
      mockFetchMrReviewComments.mockReturnValue(prReview);
      const provider = new GitLabProvider();

      // When
      const result = provider.fetchPrReviewComments(456);

      // Then
      expect(mockFetchMrReviewComments).toHaveBeenCalledWith(456, process.cwd());
      expect(result).toBe(prReview);
    });

    it('cwd を指定した場合は fetchMrReviewComments にそのまま転送する', () => {
      // Given
      const prReview: PrReviewData = {
        number: 100,
        title: 'MR',
        body: '',
        url: 'https://gitlab.com/org/repo/-/merge_requests/100',
        headRefName: 'feat/x',
        comments: [],
        reviews: [],
        files: [],
      };
      mockFetchMrReviewComments.mockReturnValue(prReview);
      const provider = new GitLabProvider();

      // When
      const result = provider.fetchPrReviewComments(100, '/worktree/clone');

      // Then
      expect(mockFetchMrReviewComments).toHaveBeenCalledWith(100, '/worktree/clone');
      expect(result).toBe(prReview);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const prReview: PrReviewData = {
        number: 200,
        title: 'MR',
        body: '',
        url: 'https://gitlab.com/org/repo/-/merge_requests/200',
        headRefName: 'feat/y',
        comments: [],
        reviews: [],
        files: [],
      };
      mockFetchMrReviewComments.mockReturnValue(prReview);
      const provider = new GitLabProvider();

      // When
      provider.fetchPrReviewComments(200);

      // Then
      expect(mockFetchMrReviewComments).toHaveBeenCalledWith(200, process.cwd());
    });
  });

  describe('findExistingPr', () => {
    it('findExistingMr(branch, cwd) に委譲し MR を返す', () => {
      // Given
      const mr = { number: 10, url: 'https://gitlab.com/org/repo/-/merge_requests/10' };
      mockFindExistingMr.mockReturnValue(mr);
      const provider = new GitLabProvider();

      // When
      const result = provider.findExistingPr('feat/my-feature', '/project');

      // Then
      expect(mockFindExistingMr).toHaveBeenCalledWith('feat/my-feature', '/project');
      expect(result).toBe(mr);
    });

    it('MR が存在しない場合は undefined を返す', () => {
      // Given
      mockFindExistingMr.mockReturnValue(undefined);
      const provider = new GitLabProvider();

      // When
      const result = provider.findExistingPr('feat/no-mr', '/project');

      // Then
      expect(result).toBeUndefined();
    });

    it('cwd を指定した場合は findExistingMr にそのまま転送する', () => {
      // Given
      const mr = { number: 20, url: 'https://gitlab.com/org/repo/-/merge_requests/20' };
      mockFindExistingMr.mockReturnValue(mr);
      const provider = new GitLabProvider();

      // When
      const result = provider.findExistingPr('feat/branch', '/worktree/clone');

      // Then
      expect(mockFindExistingMr).toHaveBeenCalledWith('feat/branch', '/worktree/clone');
      expect(result).toBe(mr);
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      mockFindExistingMr.mockReturnValue(undefined);
      const provider = new GitLabProvider();

      // When
      provider.findExistingPr('feat/branch');

      // Then
      expect(mockFindExistingMr).toHaveBeenCalledWith('feat/branch', process.cwd());
    });
  });

  describe('createPullRequest', () => {
    it('createMergeRequest(opts, cwd) に委譲し結果を返す', () => {
      // Given
      const opts = { branch: 'feat/new', title: 'My MR', body: 'MR body', draft: false };
      const mrResult = { success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/5' };
      mockCreateMergeRequest.mockReturnValue(mrResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.createPullRequest(opts, '/project');

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith(opts, '/project');
      expect(result).toBe(mrResult);
    });

    it('draft: true の場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { branch: 'feat/draft', title: 'Draft MR', body: 'body', draft: true };
      mockCreateMergeRequest.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/6' });
      const provider = new GitLabProvider();

      // When
      provider.createPullRequest(opts, '/project');

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true }), '/project');
    });

    it('cwd を指定した場合は createMergeRequest にそのまま転送する', () => {
      // Given
      const opts = { branch: 'feat/x', title: 'MR', body: 'body', draft: false };
      mockCreateMergeRequest.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/7' });
      const provider = new GitLabProvider();

      // When
      provider.createPullRequest(opts, '/worktree/clone');

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith(opts, '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const opts = { branch: 'feat/y', title: 'MR', body: 'body', draft: false };
      mockCreateMergeRequest.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/8' });
      const provider = new GitLabProvider();

      // When
      provider.createPullRequest(opts);

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith(opts, process.cwd());
    });
  });

  describe('commentOnPr', () => {
    it('commentOnMr(mrNumber, body, cwd) に委譲し CommentResult を返す', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.commentOnPr(42, 'Updated!', '/project');

      // Then
      expect(mockCommentOnMr).toHaveBeenCalledWith(42, 'Updated!', '/project');
      expect(result).toBe(commentResult);
    });

    it('コメント失敗時はエラー結果を委譲して返す', () => {
      // Given
      const commentResult: CommentResult = { success: false, error: 'Permission denied' };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.commentOnPr(42, 'comment', '/project');

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('cwd を指定した場合は commentOnMr にそのまま転送する', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      provider.commentOnPr(10, 'body', '/worktree/clone');

      // Then
      expect(mockCommentOnMr).toHaveBeenCalledWith(10, 'body', '/worktree/clone');
    });

    it('cwd 省略時は process.cwd() をフォールバックとして渡す', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      provider.commentOnPr(10, 'body');

      // Then
      expect(mockCommentOnMr).toHaveBeenCalledWith(10, 'body', process.cwd());
    });
  });
});
