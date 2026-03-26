/**
 * Tests for git provider factory (getGitProvider / initGitProvider)
 *
 * Tests the factory logic including:
 * - initGitProvider with explicit vcs_provider config
 * - Auto-detection fallback when config is not set
 * - Singleton behavior and cache invalidation on provider type change
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDetectVcsProvider, mockResolveConfigValue, MockGitHubProvider, MockGitLabProvider } = vi.hoisted(() => ({
  mockDetectVcsProvider: vi.fn(),
  mockResolveConfigValue: vi.fn(),
  MockGitHubProvider: vi.fn().mockImplementation(() => ({
    _type: 'github',
    checkCliStatus: vi.fn(),
    fetchIssue: vi.fn(),
    createIssue: vi.fn(),
    fetchPrReviewComments: vi.fn(),
    findExistingPr: vi.fn(),
    createPullRequest: vi.fn(),
    commentOnPr: vi.fn(),
  })),
  MockGitLabProvider: vi.fn().mockImplementation(() => ({
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

vi.mock('../infra/git/detect.js', () => ({
  detectVcsProvider: (...args: unknown[]) => mockDetectVcsProvider(...args),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

vi.mock('../infra/github/GitHubProvider.js', () => ({
  GitHubProvider: MockGitHubProvider,
}));

vi.mock('../infra/gitlab/index.js', () => ({
  GitLabProvider: MockGitLabProvider,
}));

let getGitProvider: typeof import('../infra/git/index.js').getGitProvider;
let initGitProvider: typeof import('../infra/git/index.js').initGitProvider;
let createPullRequestSafely: typeof import('../infra/git/index.js').createPullRequestSafely;
let resolveIssueTask: typeof import('../infra/git/index.js').resolveIssueTask;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import('../infra/git/index.js');
  getGitProvider = mod.getGitProvider;
  initGitProvider = mod.initGitProvider;
  createPullRequestSafely = mod.createPullRequestSafely;
  resolveIssueTask = mod.resolveIssueTask;
});

describe('getGitProvider', () => {
  it('initGitProvider 未呼び出しの場合、自動検出で GitHub プロバイダーを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('github');

    // When
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('github');
    expect(MockGitHubProvider).toHaveBeenCalledTimes(1);
  });

  it('initGitProvider 未呼び出し、自動検出で GitLab の場合、GitLab プロバイダーを返す', () => {
    // Given
    mockDetectVcsProvider.mockReturnValue('gitlab');

    // When
    const provider = getGitProvider();

    // Then
    expect((provider as unknown as { _type: string })._type).toBe('gitlab');
    expect(MockGitLabProvider).toHaveBeenCalledTimes(1);
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
    expect(MockGitHubProvider).toHaveBeenCalledTimes(1);
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
    expect(mockDetectVcsProvider).toHaveBeenCalledWith('/project');
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
    expect(MockGitLabProvider).toHaveBeenCalledTimes(1);
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

describe('createPullRequestSafely', () => {
  it('createPullRequest が例外を投げても失敗結果に正規化する', () => {
    mockDetectVcsProvider.mockReturnValue('github');
    const gitProvider = getGitProvider();
    const createPullRequestMock = vi.mocked(gitProvider.createPullRequest);
    createPullRequestMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = createPullRequestSafely(gitProvider, {
      branch: 'feature/test',
      title: 'Test',
      body: 'Body',
    }, '/project');

    expect(result).toEqual({
      success: false,
      error: 'boom',
    });
  });

  it('cwd を指定した場合は createPullRequest にそのまま転送する', () => {
    mockDetectVcsProvider.mockReturnValue('github');
    const gitProvider = getGitProvider();
    const createPullRequestMock = vi.mocked(gitProvider.createPullRequest);
    createPullRequestMock.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });

    const opts = { branch: 'feat/test', title: 'Test', body: 'Body' };
    createPullRequestSafely(gitProvider, opts, '/worktree/clone');

    expect(createPullRequestMock).toHaveBeenCalledWith(opts, '/worktree/clone');
  });

  it('cwd 省略時も createPullRequest を正しく呼び出す', () => {
    mockDetectVcsProvider.mockReturnValue('github');
    const gitProvider = getGitProvider();
    const createPullRequestMock = vi.mocked(gitProvider.createPullRequest);
    createPullRequestMock.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/2' });

    const opts = { branch: 'feat/test', title: 'Test', body: 'Body' };
    const result = createPullRequestSafely(gitProvider, opts);

    expect(result.success).toBe(true);
    expect(createPullRequestMock).toHaveBeenCalledWith(opts, undefined);
  });
});

describe('resolveIssueTask with cwd', () => {
  it('cwd を指定した場合は checkCliStatus と fetchIssue に cwd を渡す', () => {
    mockDetectVcsProvider.mockReturnValue('github');
    const gitProvider = getGitProvider();
    const checkCliStatusMock = vi.mocked(gitProvider.checkCliStatus);
    const fetchIssueMock = vi.mocked(gitProvider.fetchIssue);

    checkCliStatusMock.mockReturnValue({ available: true });
    fetchIssueMock.mockReturnValue({
      number: 42,
      title: 'Test Issue',
      body: 'Body',
      labels: [],
      comments: [],
    });

    // resolveIssueTask is a module-level function using getGitProvider()
    // After implementation, it should accept cwd? and pass to provider methods
    const mod = { resolveIssueTask } as { resolveIssueTask: (task: string, cwd?: string) => string };
    const result = mod.resolveIssueTask('#42', '/worktree/clone');

    expect(checkCliStatusMock).toHaveBeenCalledWith('/worktree/clone');
    expect(fetchIssueMock).toHaveBeenCalledWith(42, '/worktree/clone');
    expect(result).toContain('Test Issue');
  });
});
