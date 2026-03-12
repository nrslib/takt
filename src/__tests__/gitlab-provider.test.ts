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

vi.mock('../infra/gitlab/issue.js', () => ({
  checkGlabCli: (...args: unknown[]) => mockCheckGlabCli(...args),
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
      expect(mockCheckGlabCli).toHaveBeenCalledTimes(1);
      expect(result).toBe(status);
    });

    it('glab CLI が利用不可の場合は available: false を返す', () => {
      // Given
      mockCheckGlabCli.mockReturnValue({ available: false, error: 'glab is not installed' });
      const provider = new GitLabProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
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
      expect(result.available).toBe(false);
      expect(result.error).toContain('not authenticated');
    });
  });

  describe('fetchIssue', () => {
    it('fetchIssue(n) に委譲し結果を返す', () => {
      // Given
      const issue = { number: 42, title: 'Test issue', body: 'Body', labels: [], comments: [] };
      mockFetchIssue.mockReturnValue(issue);
      const provider = new GitLabProvider();

      // When
      const result = provider.fetchIssue(42);

      // Then
      expect(mockFetchIssue).toHaveBeenCalledWith(42);
      expect(result).toBe(issue);
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
      expect(mockCreateIssue).toHaveBeenCalledWith(opts);
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
      expect(mockCreateIssue).toHaveBeenCalledWith(opts);
    });
  });

  describe('fetchPrReviewComments', () => {
    it('fetchMrReviewComments(n) に委譲し結果を返す', () => {
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
      expect(mockFetchMrReviewComments).toHaveBeenCalledWith(456);
      expect(result).toBe(prReview);
    });
  });

  describe('findExistingPr', () => {
    it('findExistingMr(cwd, branch) に委譲し MR を返す', () => {
      // Given
      const mr = { number: 10, url: 'https://gitlab.com/org/repo/-/merge_requests/10' };
      mockFindExistingMr.mockReturnValue(mr);
      const provider = new GitLabProvider();

      // When
      const result = provider.findExistingPr('/project', 'feat/my-feature');

      // Then
      expect(mockFindExistingMr).toHaveBeenCalledWith('/project', 'feat/my-feature');
      expect(result).toBe(mr);
    });

    it('MR が存在しない場合は undefined を返す', () => {
      // Given
      mockFindExistingMr.mockReturnValue(undefined);
      const provider = new GitLabProvider();

      // When
      const result = provider.findExistingPr('/project', 'feat/no-mr');

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('createPullRequest', () => {
    it('createMergeRequest(cwd, opts) に委譲し結果を返す', () => {
      // Given
      const opts = { branch: 'feat/new', title: 'My MR', body: 'MR body', draft: false };
      const mrResult = { success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/5' };
      mockCreateMergeRequest.mockReturnValue(mrResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.createPullRequest('/project', opts);

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith('/project', opts);
      expect(result).toBe(mrResult);
    });

    it('draft: true の場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { branch: 'feat/draft', title: 'Draft MR', body: 'body', draft: true };
      mockCreateMergeRequest.mockReturnValue({ success: true, url: 'https://gitlab.com/org/repo/-/merge_requests/6' });
      const provider = new GitLabProvider();

      // When
      provider.createPullRequest('/project', opts);

      // Then
      expect(mockCreateMergeRequest).toHaveBeenCalledWith('/project', expect.objectContaining({ draft: true }));
    });
  });

  describe('commentOnPr', () => {
    it('commentOnMr(cwd, mrNumber, body) に委譲し CommentResult を返す', () => {
      // Given
      const commentResult: CommentResult = { success: true };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.commentOnPr('/project', 42, 'Updated!');

      // Then
      expect(mockCommentOnMr).toHaveBeenCalledWith('/project', 42, 'Updated!');
      expect(result).toBe(commentResult);
    });

    it('コメント失敗時はエラー結果を委譲して返す', () => {
      // Given
      const commentResult: CommentResult = { success: false, error: 'Permission denied' };
      mockCommentOnMr.mockReturnValue(commentResult);
      const provider = new GitLabProvider();

      // When
      const result = provider.commentOnPr('/project', 42, 'comment');

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });
});
