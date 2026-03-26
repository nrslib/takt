/**
 * Tests for gitlab/issue module
 *
 * Tests checkGlabCli, fetchIssue, and createIssue via execFileSync mocking.
 * Mirrors the testing pattern from github-pr.test.ts.
 *
 * AI-AP-002: fetchIssue now fetches notes via separate `glab api` call
 * with pagination, instead of relying on `glab issue view` JSON output.
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

import { fetchIssue, createIssue } from '../infra/gitlab/issue.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchIssue', () => {
  it('glab issue view と glab api notes を統合して Issue 型にマッピングする', () => {
    // Given: glab issue view returns issue metadata (without notes)
    const glabIssueResponse = {
      iid: 42,
      title: 'Test issue',
      description: 'Issue body text',
      labels: ['bug', 'urgent'],
    };
    // glab api returns notes separately
    const notesResponse = [
      { author: { username: 'user1' }, body: 'I can reproduce this.', system: false },
      { author: { username: 'user2' }, body: 'Fixed in MR !7.', system: false },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse)) // glab issue view
      .mockReturnValueOnce(JSON.stringify(notesResponse)); // glab api notes

    // When
    const result = fetchIssue(42, '/project');

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
    const glabIssueResponse = {
      iid: 10,
      title: 'Title',
      description: '',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([])); // empty notes

    // When
    fetchIssue(10, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[0]).toBe('glab');
    expect(call[1]).toContain('issue');
    expect(call[1]).toContain('view');
    expect(call[1]).toContain('10');
  });

  it('glab api で notes エンドポイントを呼び出す', () => {
    // Given
    const glabIssueResponse = {
      iid: 10,
      title: 'Title',
      description: '',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchIssue(10, '/project');

    // Then: second call should be glab api for notes
    const notesCall = mockExecFileSync.mock.calls[1];
    expect(notesCall[0]).toBe('glab');
    expect(notesCall[1][0]).toBe('api');
    const apiPath = notesCall[1][1] as string;
    expect(apiPath).toContain('issues/10/notes');
    expect(apiPath).toContain('per_page=100');
  });

  it('description が null の場合は空文字にマッピングする', () => {
    // Given
    const glabIssueResponse = {
      iid: 5,
      title: 'No body',
      description: null,
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchIssue(5, '/project');

    // Then
    expect(result.body).toBe('');
  });

  it('system ノートはスキップする', () => {
    // Given
    const glabIssueResponse = {
      iid: 7,
      title: 'Issue with system notes',
      description: 'Body',
      labels: [],
    };
    const notesResponse = [
      { author: { username: 'bot' }, body: 'changed the description', system: true },
      { author: { username: 'user1' }, body: 'Actual comment', system: false },
      { author: { username: 'bot' }, body: 'added label ~bug', system: true },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify(notesResponse));

    // When
    const result = fetchIssue(7, '/project');

    // Then
    expect(result.comments).toEqual([
      { author: 'user1', body: 'Actual comment' },
    ]);
  });

  it('glab CLI がエラーの場合は例外を投げる', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: issue not found'); });

    // When / Then
    expect(() => fetchIssue(999, '/project')).toThrow();
  });

  it('glab issue view が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    mockExecFileSync.mockReturnValue('<html>500 Internal Server Error</html>');

    // When / Then
    expect(() => fetchIssue(42, '/project')).toThrow('glab returned invalid JSON');
  });

  it('notes API が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    const glabIssueResponse = {
      iid: 42,
      title: 'Title',
      description: '',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce('invalid json');

    // When / Then
    expect(() => fetchIssue(42, '/project')).toThrow('glab returned invalid JSON');
  });

  it('notes が空の場合は空配列を返す', () => {
    // Given
    const glabIssueResponse = {
      iid: 3,
      title: 'No comments',
      description: 'Body',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchIssue(3, '/project');

    // Then
    expect(result.comments).toEqual([]);
  });

  it('notes が100件ちょうどの場合は次ページを取得する（ページネーション）', () => {
    // Given
    const glabIssueResponse = {
      iid: 50,
      title: 'Many notes',
      description: 'Body',
      labels: [],
    };
    const firstPageNotes = Array.from({ length: 100 }, (_, i) => ({
      author: { username: `user${i}` },
      body: `Note ${i + 1}`,
      system: false,
    }));
    const secondPageNotes = [
      { author: { username: 'user100' }, body: 'Note 101', system: false },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify(firstPageNotes))
      .mockReturnValueOnce(JSON.stringify(secondPageNotes));

    // When
    const result = fetchIssue(50, '/project');

    // Then
    expect(result.comments).toHaveLength(101);
    expect(result.comments[0]).toEqual({ author: 'user0', body: 'Note 1' });
    expect(result.comments[100]).toEqual({ author: 'user100', body: 'Note 101' });
  });

  it('notes のページネーションで page パラメータが正しく増加する', () => {
    // Given
    const glabIssueResponse = {
      iid: 50,
      title: 'Paginated',
      description: '',
      labels: [],
    };
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      author: { username: 'user' },
      body: `Note ${i}`,
      system: false,
    }));
    const secondPage = [
      { author: { username: 'user' }, body: 'Last note', system: false },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify(firstPage))
      .mockReturnValueOnce(JSON.stringify(secondPage));

    // When
    fetchIssue(50, '/project');

    // Then: verify page=1 and page=2
    const notesCall1 = mockExecFileSync.mock.calls[1];
    const apiPath1 = notesCall1[1][1] as string;
    expect(apiPath1).toContain('page=1');

    const notesCall2 = mockExecFileSync.mock.calls[2];
    const apiPath2 = notesCall2[1][1] as string;
    expect(apiPath2).toContain('page=2');
  });

  it('notes が100件未満の場合は追加ページを取得しない', () => {
    // Given
    const glabIssueResponse = {
      iid: 51,
      title: 'Few notes',
      description: '',
      labels: [],
    };
    const notes = Array.from({ length: 50 }, (_, i) => ({
      author: { username: 'user' },
      body: `Note ${i}`,
      system: false,
    }));
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify(notes));

    // When
    fetchIssue(51, '/project');

    // Then: only 2 calls (issue view + 1 page of notes)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('cwd を glab issue view の execFileSync に渡す', () => {
    // Given
    const glabIssueResponse = {
      iid: 10,
      title: 'Title',
      description: '',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchIssue(10, '/worktree/clone');

    // Then: glab issue view に cwd が渡される
    const issueViewCall = mockExecFileSync.mock.calls[0];
    expect(issueViewCall[2]).toHaveProperty('cwd', '/worktree/clone');
  });

  it('cwd を fetchAllPages（notes 取得）にも伝搬する', () => {
    // Given
    const glabIssueResponse = {
      iid: 10,
      title: 'Title',
      description: '',
      labels: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(glabIssueResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchIssue(10, '/worktree/clone');

    // Then: glab api（notes）にも cwd が渡される
    const notesCall = mockExecFileSync.mock.calls[1];
    expect(notesCall[2]).toHaveProperty('cwd', '/worktree/clone');
  });
});

describe('createIssue', () => {
  it('成功時は success: true と URL を返す', () => {
    // Given: getRemoteHostname (git remote), checkGlabCli (glab auth), then createIssue
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/1\n');

    // When
    const result = createIssue({ title: 'New issue', body: 'Description' }, '/my/project');

    // Then
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://gitlab.com/org/repo/-/issues/1');
  });

  it('--description オプションで body を渡す（--body ではない）', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/2\n');

    // When
    createIssue({ title: 'Title', body: 'Body text' }, '/my/project');

    // Then
    const createCall = mockExecFileSync.mock.calls[2];
    expect(createCall[1]).toContain('--description');
    expect(createCall[1]).not.toContain('--body');
  });

  it('ラベル付きの場合 --label オプションを使う', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/3\n');

    // When
    createIssue({ title: 'Bug', body: 'Details', labels: ['bug', 'urgent'] }, '/my/project');

    // Then
    const createCall = mockExecFileSync.mock.calls[2];
    expect(createCall[1]).toContain('--label');
  });

  it('glab CLI が利用不可の場合は success: false を返す', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockImplementationOnce(() => { throw new Error('not logged in'); })
      .mockImplementationOnce(() => { throw new Error('command not found'); });

    // When
    const result = createIssue({ title: 'Title', body: 'Body' }, '/my/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('glab issue create が失敗した場合は success: false を返す', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockReturnValueOnce('') // glab auth status
      .mockImplementationOnce(() => { throw new Error('API error'); });

    // When
    const result = createIssue({ title: 'Title', body: 'Body' }, '/my/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('cwd を checkGlabCli に転送する', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('https://gitlab.com/org/repo.git\n') // git remote get-url origin
      .mockReturnValueOnce('') // glab auth status
      .mockReturnValueOnce('https://gitlab.com/org/repo/-/issues/5\n');

    // When
    createIssue({ title: 'Test', body: 'Body' }, '/specific/dir');

    // Then: first call is getRemoteHostname which receives cwd via execFileSync options
    const remoteCall = mockExecFileSync.mock.calls[0];
    expect(remoteCall[2]).toHaveProperty('cwd', '/specific/dir');

    // Then: third call is glab issue create which also receives cwd
    const createCall = mockExecFileSync.mock.calls[2];
    expect(createCall[2]).toHaveProperty('cwd', '/specific/dir');
  });
});
