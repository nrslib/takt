/**
 * Tests for gitlab/issue module
 *
 * Tests checkGlabCli, fetchIssue, and createIssue via execFileSync mocking.
 * Mirrors the testing pattern from github-pr.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

import { checkGlabCli, fetchIssue, createIssue } from '../infra/gitlab/issue.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkGlabCli', () => {
  it('glab auth status が成功する場合は available: true を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('');

    // When
    const result = checkGlabCli();

    // Then
    expect(result).toEqual({ available: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('glab auth status が失敗し glab --version が成功する場合は認証エラーを返す', () => {
    // Given
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not logged in'); })
      .mockReturnValueOnce('glab version 1.36.0');

    // When
    const result = checkGlabCli();

    // Then
    expect(result.available).toBe(false);
    expect(result.error).toContain('not authenticated');
    expect(result.error).toContain('glab auth login');
  });

  it('glab auth status と glab --version の両方が失敗する場合はインストールエラーを返す', () => {
    // Given
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('command not found'); })
      .mockImplementationOnce(() => { throw new Error('command not found'); });

    // When
    const result = checkGlabCli();

    // Then
    expect(result.available).toBe(false);
    expect(result.error).toContain('not installed');
  });
});

describe('fetchIssue', () => {
  it('glab issue view の JSON 出力を GitProvider の Issue 型にマッピングする', () => {
    // Given
    const glabResponse = {
      iid: 42,
      title: 'Test issue',
      description: 'Issue body text',
      labels: ['bug', 'urgent'],
      notes: [
        { author: { username: 'user1' }, body: 'I can reproduce this.' },
        { author: { username: 'user2' }, body: 'Fixed in MR !7.' },
      ],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(glabResponse));

    // When
    const result = fetchIssue(42);

    // Then
    expect(result).toEqual({
      number: 42,
      title: 'Test issue',
      body: 'Issue body text',
      labels: ['bug', 'urgent'],
      comments: [
        { author: 'user1', body: 'I can reproduce this.' },
        { author: 'user2', body: 'Fixed in MR !7.' },
      ],
    });
  });

  it('glab issue view を正しい引数で呼び出す', () => {
    // Given
    const glabResponse = {
      iid: 10,
      title: 'Title',
      description: '',
      labels: [],
      notes: [],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(glabResponse));

    // When
    fetchIssue(10);

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[0]).toBe('glab');
    expect(call[1]).toContain('issue');
    expect(call[1]).toContain('view');
    expect(call[1]).toContain('10');
  });

  it('description が null の場合は空文字にマッピングする', () => {
    // Given
    const glabResponse = {
      iid: 5,
      title: 'No body',
      description: null,
      labels: [],
      notes: [],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(glabResponse));

    // When
    const result = fetchIssue(5);

    // Then
    expect(result.body).toBe('');
  });

  it('glab CLI がエラーの場合は例外を投げる', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: issue not found'); });

    // When / Then
    expect(() => fetchIssue(999)).toThrow();
  });

  it('glab が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    mockExecFileSync.mockReturnValue('<html>500 Internal Server Error</html>');

    // When / Then
    expect(() => fetchIssue(42)).toThrow('glab returned invalid JSON for issue #42');
  });

  it('notes が空の場合は空配列を返す', () => {
    // Given
    const glabResponse = {
      iid: 3,
      title: 'No comments',
      description: 'Body',
      labels: [],
      notes: [],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(glabResponse));

    // When
    const result = fetchIssue(3);

    // Then
    expect(result.comments).toEqual([]);
  });
});

describe('createIssue', () => {
  it('成功時は success: true と URL を返す', () => {
    // Given: checkGlabCli succeeds (first call), then createIssue succeeds
    mockExecFileSync
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/1\n');

    // When
    const result = createIssue({ title: 'New issue', body: 'Description' });

    // Then
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://gitlab.com/org/repo/-/issues/1');
  });

  it('--description オプションで body を渡す（--body ではない）', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/2\n');

    // When
    createIssue({ title: 'Title', body: 'Body text' });

    // Then
    const createCall = mockExecFileSync.mock.calls[1];
    expect(createCall[1]).toContain('--description');
    expect(createCall[1]).not.toContain('--body');
  });

  it('ラベル付きの場合 --label オプションを使う', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/3\n');

    // When
    createIssue({ title: 'Bug', body: 'Details', labels: ['bug', 'urgent'] });

    // Then
    const createCall = mockExecFileSync.mock.calls[1];
    expect(createCall[1]).toContain('--label');
  });

  it('glab CLI が利用不可の場合は success: false を返す', () => {
    // Given
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not logged in'); })
      .mockImplementationOnce(() => { throw new Error('command not found'); });

    // When
    const result = createIssue({ title: 'Title', body: 'Body' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('glab issue create が失敗した場合は success: false を返す', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('') // glab auth status
      .mockImplementationOnce(() => { throw new Error('API error'); });

    // When
    const result = createIssue({ title: 'Title', body: 'Body' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
