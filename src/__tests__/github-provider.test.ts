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
  mockPushBranch,
} = vi.hoisted(() => ({
  mockCheckGhCli: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockCommentOnPr: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockPushBranch: vi.fn(),
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
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
}));

// These imports will fail until implementation exists (expected "fail first" behavior)
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { getGitProvider } from '../infra/git/index.js';

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
      expect(mockCheckGhCli).toHaveBeenCalledTimes(1);
      expect(result).toBe(status);
    });

    it('gh CLI が利用不可の場合は available: false を返す', () => {
      // Given
      mockCheckGhCli.mockReturnValue({ available: false, error: 'gh is not installed' });
      const provider = new GitHubProvider();

      // When
      const result = provider.checkCliStatus();

      // Then
      expect(result.available).toBe(false);
      expect(result.error).toBe('gh is not installed');
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
      expect(mockFetchIssue).toHaveBeenCalledWith(42);
      expect(result).toBe(issue);
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
      expect(mockCreateIssue).toHaveBeenCalledWith(opts);
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
      expect(mockCreateIssue).toHaveBeenCalledWith(opts);
    });
  });

  describe('findExistingPr', () => {
    it('findExistingPr(cwd, branch) に委譲し PR を返す', () => {
      // Given
      const pr = { number: 10, url: 'https://github.com/org/repo/pull/10' };
      mockFindExistingPr.mockReturnValue(pr);
      const provider = new GitHubProvider();

      // When
      const result = provider.findExistingPr('/project', 'feat/my-feature');

      // Then
      expect(mockFindExistingPr).toHaveBeenCalledWith('/project', 'feat/my-feature');
      expect(result).toBe(pr);
    });

    it('PR が存在しない場合は undefined を返す', () => {
      // Given
      mockFindExistingPr.mockReturnValue(undefined);
      const provider = new GitHubProvider();

      // When
      const result = provider.findExistingPr('/project', 'feat/no-pr');

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('createPullRequest', () => {
    it('createPullRequest(cwd, opts) に委譲し結果を返す', () => {
      // Given
      const opts = { branch: 'feat/new', title: 'My PR', body: 'PR body', draft: false };
      const prResult = { success: true, url: 'https://github.com/org/repo/pull/5' };
      mockCreatePullRequest.mockReturnValue(prResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.createPullRequest('/project', opts);

      // Then
      expect(mockCreatePullRequest).toHaveBeenCalledWith('/project', opts);
      expect(result).toBe(prResult);
    });

    it('draft: true の場合、opts をそのまま委譲する', () => {
      // Given
      const opts = { branch: 'feat/draft', title: 'Draft PR', body: 'body', draft: true };
      mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/6' });
      const provider = new GitHubProvider();

      // When
      provider.createPullRequest('/project', opts);

      // Then: draft flag is passed through as-is
      expect(mockCreatePullRequest).toHaveBeenCalledWith('/project', expect.objectContaining({ draft: true }));
    });
  });

  describe('commentOnPr', () => {
    it('commentOnPr(cwd, prNumber, body) に委譲し結果を返す', () => {
      // Given
      const commentResult = { success: true };
      mockCommentOnPr.mockReturnValue(commentResult);
      const provider = new GitHubProvider();

      // When
      const result = provider.commentOnPr('/project', 42, 'Updated!');

      // Then
      expect(mockCommentOnPr).toHaveBeenCalledWith('/project', 42, 'Updated!');
      expect(result).toBe(commentResult);
    });

    it('コメント失敗時はエラー結果を委譲して返す', () => {
      // Given
      mockCommentOnPr.mockReturnValue({ success: false, error: 'Permission denied' });
      const provider = new GitHubProvider();

      // When
      const result = provider.commentOnPr('/project', 42, 'comment');

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  describe('pushBranch', () => {
    it('pushBranch(cwd, branch) に委譲する', () => {
      // Given
      mockPushBranch.mockReturnValue(undefined);
      const provider = new GitHubProvider();

      // When
      provider.pushBranch('/project', 'feat/my-feature');

      // Then
      expect(mockPushBranch).toHaveBeenCalledWith('/project', 'feat/my-feature');
    });
  });
});

describe('getGitProvider', () => {
  it('GitProvider インターフェースを実装するインスタンスを返す', () => {
    // When
    const provider = getGitProvider();

    // Then: has all required methods
    expect(typeof provider.checkCliStatus).toBe('function');
    expect(typeof provider.fetchIssue).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.findExistingPr).toBe('function');
    expect(typeof provider.createPullRequest).toBe('function');
    expect(typeof provider.commentOnPr).toBe('function');
    expect(typeof provider.pushBranch).toBe('function');
  });

  it('呼び出しのたびに同じインスタンスを返す（シングルトン）', () => {
    // When
    const provider1 = getGitProvider();
    const provider2 = getGitProvider();

    // Then
    expect(provider1).toBe(provider2);
  });
});
