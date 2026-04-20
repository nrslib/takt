/**
 * Tests for gitlab/utils module
 *
 * Tests parseJson, checkGlabCli, and fetchAllPages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const { mockGetRemoteHostname } = vi.hoisted(() => ({
  mockGetRemoteHostname: vi.fn(),
}));
vi.mock('../infra/git/detect.js', () => ({
  getRemoteHostname: (...args: unknown[]) => mockGetRemoteHostname(...args),
}));

import { parseJson, checkGlabCli, fetchAllPages } from '../infra/gitlab/utils.js';

function withGlabApiResponse(body: unknown, nextPath?: string): string {
  const headers = [
    'HTTP/2 200 OK',
    'content-type: application/json',
    ...(nextPath ? [`link: <https://gitlab.example.com/api/v4/${nextPath}>; rel="next"`] : []),
  ];
  return `${headers.join('\n')}\n\n${JSON.stringify(body)}`;
}

function getApiPath(call: unknown[]): string {
  const args = call[1] as string[];
  return args[2] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseJson', () => {
  it('有効な JSON をパースする', () => {
    const result = parseJson<{ key: string }>('{"key":"value"}', 'test');
    expect(result).toEqual({ key: 'value' });
  });

  it('無効な JSON の場合はコンテキスト付きエラーをスローする', () => {
    expect(() => parseJson('not json', 'test context')).toThrow(
      'glab returned invalid JSON (test context)',
    );
  });
});

describe('checkGlabCli', () => {
  describe('ホスト名が取得できる場合（ホスト単位判定）', () => {
    it('対象ホストが認証済みの場合は available: true を返す', () => {
      // Given: remote URL から gitlab.example.com が取得できる
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      // glab auth status --hostname gitlab.example.com が成功
      mockExecFileSync.mockReturnValue('');

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result).toEqual({ available: true });
    });

    it('glab auth status に --hostname オプションを付与して呼び出す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      mockExecFileSync.mockReturnValue('');

      // When
      checkGlabCli('/project');

      // Then
      const call = mockExecFileSync.mock.calls[0];
      expect(call[0]).toBe('glab');
      expect(call[1]).toContain('auth');
      expect(call[1]).toContain('status');
      expect(call[1]).toContain('--hostname');
      expect(call[1]).toContain('gitlab.example.com');
    });

    it('対象ホストが認証済み、別ホストが未認証でも available: true を返す（最重要ケース）', () => {
      // Given: remote URL から対象ホストが取得できる
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      // glab auth status --hostname gitlab.example.com は成功（ホスト限定なので別ホストの状態は無関係）
      mockExecFileSync.mockReturnValue('');

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result).toEqual({ available: true });
    });

    it('対象ホストが未認証の場合は available: false と認証エラーを返す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      // glab auth status --hostname gitlab.example.com が失敗
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not logged in'); })
        // glab --version は成功（インストール済み）
        .mockReturnValueOnce('glab version 1.36.0');

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result.available).toBe(false);
      expect(result.error).toContain('not authenticated');
    });

    it('glab 未インストールの場合は available: false とインストールエラーを返す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      // glab auth status と glab --version の両方が失敗
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('command not found'); })
        .mockImplementationOnce(() => { throw new Error('command not found'); });

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result.available).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('cwd を getRemoteHostname に渡す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      mockExecFileSync.mockReturnValue('');

      // When
      checkGlabCli('/my/project/path');

      // Then
      expect(mockGetRemoteHostname).toHaveBeenCalledWith('/my/project/path');
    });

    it('execFileSync に cwd を渡す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue('gitlab.example.com');
      mockExecFileSync.mockReturnValue('');

      // When
      checkGlabCli('/worktree/clone');

      // Then: glab auth status の execFileSync に cwd が渡されていること
      const call = mockExecFileSync.mock.calls[0];
      expect(call[2]).toHaveProperty('cwd', '/worktree/clone');
    });
  });

  describe('ホスト名が取得できない場合（フォールバック）', () => {
    it('glab auth status（全体）にフォールバックし、成功すれば available: true を返す', () => {
      // Given: ホスト名取得に失敗
      mockGetRemoteHostname.mockReturnValue(undefined);
      // glab auth status（引数なし）が成功
      mockExecFileSync.mockReturnValue('');

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result).toEqual({ available: true });
    });

    it('フォールバック時に --hostname オプションを付与しない', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue('');

      // When
      checkGlabCli('/project');

      // Then
      const call = mockExecFileSync.mock.calls[0];
      expect(call[0]).toBe('glab');
      expect(call[1]).toContain('auth');
      expect(call[1]).toContain('status');
      expect(call[1]).not.toContain('--hostname');
    });

    it('フォールバック時に認証失敗すれば認証エラーを返す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue(undefined);
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not logged in'); })
        .mockReturnValueOnce('glab version 1.36.0');

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result.available).toBe(false);
      expect(result.error).toContain('not authenticated');
    });

    it('フォールバック時に glab 未インストールならインストールエラーを返す', () => {
      // Given
      mockGetRemoteHostname.mockReturnValue(undefined);
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('command not found'); })
        .mockImplementationOnce(() => { throw new Error('command not found'); });

      // When
      const result = checkGlabCli('/project');

      // Then
      expect(result.available).toBe(false);
      expect(result.error).toContain('not installed');
    });
  });
});

describe('fetchAllPages', () => {
  it('1ページで完了する場合はそのまま返す', () => {
    const items = [{ id: 1 }, { id: 2 }];
    mockExecFileSync.mockReturnValueOnce(JSON.stringify(items));

    const result = fetchAllPages<{ id: number }>('projects/:id/issues/1/notes', 100, 'test', '/project');

    expect(result).toEqual(items);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('複数ページを取得する', () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 100 }, { id: 101 }];
    mockExecFileSync
      .mockReturnValueOnce(withGlabApiResponse(page1, 'projects/1/issues/1/notes?per_page=100&page=2'))
      .mockReturnValueOnce(withGlabApiResponse(page2));

    const result = fetchAllPages<{ id: number }>('projects/:id/issues/1/notes', 100, 'test', '/project');

    expect(result).toHaveLength(102);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('page パラメータが正しく増加する', () => {
    const page1 = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 10 }];
    mockExecFileSync
      .mockReturnValueOnce(withGlabApiResponse(page1, 'projects/1/test?per_page=10&page=2'))
      .mockReturnValueOnce(withGlabApiResponse(page2));

    fetchAllPages<{ id: number }>('projects/:id/test', 10, 'test', '/project');

    const call1 = mockExecFileSync.mock.calls[0];
    expect(getApiPath(call1)).toContain('page=1');
    const call2 = mockExecFileSync.mock.calls[1];
    expect(getApiPath(call2)).toContain('page=2');
  });

  it('pagination link が無ければ件数に関係なく終了する', () => {
    const fullPage = Array.from({ length: 5 }, (_, index) => ({ id: index }));
    mockExecFileSync
      .mockReturnValueOnce(withGlabApiResponse(fullPage));

    const result = fetchAllPages<{ id: number }>('projects/:id/test', 5, 'test', '/project');

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fullPage);
  });

  it('endpoint に既にクエリパラメータがある場合は & で結合する', () => {
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([]));

    fetchAllPages<unknown>('projects/:id/test?sort=asc', 50, 'test', '/project');

    const call = mockExecFileSync.mock.calls[0];
    const apiPath = getApiPath(call);
    expect(apiPath).toContain('?sort=asc&per_page=50&page=1');
  });

  it('endpoint にクエリパラメータがない場合は ? で結合する', () => {
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([]));

    fetchAllPages<unknown>('projects/:id/test', 50, 'test', '/project');

    const call = mockExecFileSync.mock.calls[0];
    const apiPath = getApiPath(call);
    expect(apiPath).toContain('projects/:id/test?per_page=50&page=1');
  });

  it('不正な JSON の場合はコンテキスト付きエラーをスローする', () => {
    mockExecFileSync.mockReturnValueOnce('invalid');

    expect(() => fetchAllPages<unknown>('endpoint', 50, 'my context', '/project')).toThrow(
      'glab returned invalid JSON (my context)',
    );
  });

  it('cwd を execFileSync に渡す', () => {
    // Given
    mockExecFileSync.mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchAllPages<unknown>('projects/:id/test', 50, 'test', '/worktree/clone');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[2]).toHaveProperty('cwd', '/worktree/clone');
  });

  it('複数ページ取得時にすべてのページで cwd を execFileSync に渡す', () => {
    // Given
    const page1 = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 10 }];
    mockExecFileSync
      .mockReturnValueOnce(withGlabApiResponse(page1, 'projects/1/test?per_page=10&page=2'))
      .mockReturnValueOnce(withGlabApiResponse(page2));

    // When
    fetchAllPages<{ id: number }>('projects/:id/test', 10, 'test', '/worktree/clone');

    // Then
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toHaveProperty('cwd', '/worktree/clone');
    }
  });

  it('pagination link が上限を超えて続く場合は明示エラーにする', () => {
    let page = 1;
    mockExecFileSync.mockImplementation(() => {
      const response = withGlabApiResponse(
        [{ id: page }],
        `projects/1/test?per_page=1&page=${page + 1}`,
      );
      page += 1;
      return response;
    });

    expect(() => fetchAllPages<{ id: number }>('projects/:id/test', 1, 'test', '/project')).toThrow(
      'Pagination limit exceeded while fetching test (>100 pages)',
    );
  });
});

describe('dead-reexport prevention', () => {
  it('issue.ts は checkGlabCli を re-export しない', async () => {
    const issueModule = await import('../infra/gitlab/issue.js');
    const exportedKeys = Object.keys(issueModule);
    expect(exportedKeys).not.toContain('checkGlabCli');
  });
});
