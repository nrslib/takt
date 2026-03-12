/**
 * Tests for git provider factory (getGitProvider / initGitProvider)
 *
 * Tests the factory logic including:
 * - initGitProvider with explicit vcs_provider config
 * - Auto-detection fallback when config is not set
 * - Singleton behavior and cache invalidation on provider type change
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDetectVcsProvider, mockResolveConfigValue } = vi.hoisted(() => ({
  mockDetectVcsProvider: vi.fn(),
  mockResolveConfigValue: vi.fn(),
}));

vi.mock('../infra/git/detect.js', () => ({
  detectVcsProvider: (...args: unknown[]) => mockDetectVcsProvider(...args),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

// Mock GitHubProvider and GitLabProvider to verify instantiation
vi.mock('../infra/github/GitHubProvider.js', () => ({
  GitHubProvider: vi.fn().mockImplementation(() => ({
    _type: 'github',
    checkCliStatus: vi.fn(),
    fetchIssue: vi.fn(),
    createIssue: vi.fn(),
    fetchPrReviewComments: vi.fn(),
    findExistingPr: vi.fn(),
    createPullRequest: vi.fn(),
    commentOnPr: vi.fn(),
  })),
}));

vi.mock('../infra/gitlab/GitLabProvider.js', () => ({
  GitLabProvider: vi.fn().mockImplementation(() => ({
    _type: 'gitlab',
    checkCliStatus: vi.fn(),
    fetchIssue: vi.fn(),
    createIssue: vi.fn(),
    fetchPrReviewComments: vi.fn(),
    findExistingPr: vi.fn(),
    createPullRequest: vi.fn(),
    commentOnPr: vi.fn(),
  })),
}));

import { getGitProvider, initGitProvider, resetGitProvider } from '../infra/git/index.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';

beforeEach(() => {
  vi.clearAllMocks();
  resetGitProvider();
});

describe('getGitProvider', () => {
  it('initGitProvider 未呼び出しの場合、自動検出で GitHub プロバイダーを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('github');

    // When
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
    expect(GitHubProvider).toHaveBeenCalledTimes(1);
  });

  it('initGitProvider 未呼び出し、自動検出で GitLab の場合、GitLab プロバイダーを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('gitlab');

    // When
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('gitlab');
    expect(GitLabProvider).toHaveBeenCalledTimes(1);
  });

  it('自動検出が undefined の場合、GitHub にフォールバックする', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue(undefined);

    // When
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
  });

  it('呼び出しのたびに同じインスタンスを返す（シングルトン）', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('github');

    // When
    const provider1 = getGitProvider();
    const provider2 = getGitProvider();

    // Then
    expect(provider1).toBe(provider2);
    expect(GitHubProvider).toHaveBeenCalledTimes(1);
  });

  it('GitProvider インターフェースを実装するインスタンスを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('github');

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
});

describe('initGitProvider', () => {
  it('設定に vcsProvider: gitlab が指定されている場合、GitLab プロバイダーを生成する', () => {
    // Given
    mockResolveConfigValue.mockReturnValue('gitlab');

    // When
    initGitProvider('/project');
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('gitlab');
    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'vcsProvider');
  });

  it('設定に vcsProvider: github が指定されている場合、GitHub プロバイダーを生成する', () => {
    // Given
    mockResolveConfigValue.mockReturnValue('github');

    // When
    initGitProvider('/project');
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
  });

  it('設定が未指定の場合、自動検出にフォールバックする', () => {
    // Given
    mockResolveConfigValue.mockReturnValue(undefined);
    mockDetectVcsProvider.mockReturnValue('gitlab');

    // When
    initGitProvider('/project');
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('gitlab');
    expect(mockDetectVcsProvider).toHaveBeenCalled();
  });

  it('設定が自動検出より優先される', () => {
    // Given
    mockResolveConfigValue.mockReturnValue('github');
    mockDetectVcsProvider.mockReturnValue('gitlab');

    // When
    initGitProvider('/project');
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
    expect(mockDetectVcsProvider).not.toHaveBeenCalled();
  });

  it('設定・自動検出ともに undefined の場合、GitHub にフォールバックする', () => {
    // Given
    mockResolveConfigValue.mockReturnValue(undefined);
    mockDetectVcsProvider.mockReturnValue(undefined);

    // When
    initGitProvider('/project');
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
  });

  it('同じプロバイダータイプで再呼び出しした場合、インスタンスを再生成しない', () => {
    // Given
    mockResolveConfigValue.mockReturnValue('gitlab');

    // When
    initGitProvider('/project');
    const provider1 = getGitProvider();
    initGitProvider('/project');
    const provider2 = getGitProvider();

    // Then
    expect(provider1).toBe(provider2);
    expect(GitLabProvider).toHaveBeenCalledTimes(1);
  });

  it('プロバイダータイプが変わった場合、インスタンスを再生成する', () => {
    // Given
    mockResolveConfigValue.mockReturnValueOnce('github').mockReturnValueOnce('gitlab');

    // When
    initGitProvider('/project');
    const provider1 = getGitProvider();
    initGitProvider('/project');
    const provider2 = getGitProvider();

    // Then
    expect(provider1).not.toBe(provider2);
    expect((provider1 as unknown as { _type: string })._type).toBe('github');
    expect((provider2 as unknown as { _type: string })._type).toBe('gitlab');
  });
});

describe('resetGitProvider', () => {
  it('リセット後、getGitProvider は新しいインスタンスを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('github');
    const provider1 = getGitProvider();

    // When
    resetGitProvider();
    const provider2 = getGitProvider();

    // Then
    expect(provider1).not.toBe(provider2);
  });
});
