/**
 * Tests for gitlab/pr module
 *
 * Tests MR operations via glab CLI mock, mirroring github-pr.test.ts pattern.
 * AI-AP-001: notes/discussions fetching now uses pagination.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
const { mockCheckGlabCli } = vi.hoisted(() => ({
  mockCheckGlabCli: vi.fn().mockReturnValue({ available: true }),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/gitlab/utils.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    checkGlabCli: (...args: unknown[]) => mockCheckGlabCli(...args),
  };
});

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

import { findExistingMr, createMergeRequest, commentOnMr, fetchMrReviewComments } from '../infra/gitlab/pr.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findExistingMr', () => {
  it('オープンな MR がある場合はその MR を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue(
      JSON.stringify([{ iid: 42, web_url: 'https://gitlab.com/org/repo/-/merge_requests/42' }]),
    );

    // When
    const result = findExistingMr('task/fix-bug', '/project');

    // Then
    expect(result).toEqual({ number: 42, url: 'https://gitlab.com/org/repo/-/merge_requests/42' });
  });

  it('glab mr list を --source-branch オプションで呼び出す', () => {
    // Given
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    // When
    findExistingMr('feat/my-feature', '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[0]).toBe('glab');
    expect(call[1]).toContain('mr');
    expect(call[1]).toContain('list');
    expect(call[1]).toContain('--source-branch');
    expect(call[1]).toContain('feat/my-feature');
  });

  it('MR がない場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    // When
    const result = findExistingMr('task/no-mr', '/project');

    // Then
    expect(result).toBeUndefined();
  });

  it('glab CLI が失敗した場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: command not found'); });

    // When
    const result = findExistingMr('task/fix-bug', '/project');

    // Then
    expect(result).toBeUndefined();
  });

  it('checkGlabCli に cwd を渡す', () => {
    // Given
    mockCheckGlabCli.mockReturnValue({ available: true });
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    // When
    findExistingMr('feat/branch', '/my/project');

    // Then
    expect(mockCheckGlabCli).toHaveBeenCalledWith('/my/project');
  });
});

describe('createMergeRequest', () => {
  it('成功時は success: true と URL を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/1\n');

    // When
    const result = createMergeRequest({
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    }, '/project');

    // Then
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://gitlab.com/org/repo/-/merge_requests/1');
  });

  it('--source-branch オプションで branch を渡す（--head ではない）', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/2\n');

    // When
    createMergeRequest({
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    }, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--source-branch');
    expect(call[1]).not.toContain('--head');
  });

  it('--description オプションで body を渡す（--body ではない）', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/3\n');

    // When
    createMergeRequest({
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    }, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--description');
    expect(call[1]).not.toContain('--body');
  });

  it('draft: true の場合、args に --draft が含まれる', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/4\n');

    // When
    createMergeRequest({
      branch: 'feat/my-branch',
      title: 'Draft MR',
      body: 'body',
      draft: true,
    }, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--draft');
  });

  it('draft: false の場合、args に --draft が含まれない', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/5\n');

    // When
    createMergeRequest({
      branch: 'feat/my-branch',
      title: 'MR',
      body: 'body',
      draft: false,
    }, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });

  it('base が指定された場合、--target-branch で渡す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/6\n');

    // When
    createMergeRequest({
      branch: 'feat/my-branch',
      title: 'MR',
      body: 'body',
      base: 'develop',
    }, '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--target-branch');
    expect(call[1]).toContain('develop');
  });

  it('glab mr create が失敗した場合は success: false を返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('API error'); });

    // When
    const result = createMergeRequest({
      branch: 'feat/fail',
      title: 'Fail MR',
      body: 'body',
    }, '/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('checkGlabCli に cwd を渡す', () => {
    // Given
    mockCheckGlabCli.mockReturnValue({ available: true });
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/99\n');

    // When
    createMergeRequest({
      branch: 'feat/branch',
      title: 'MR',
      body: 'body',
    }, '/my/project');

    // Then
    expect(mockCheckGlabCli).toHaveBeenCalledWith('/my/project');
  });

  it('repo が指定された場合、明示エラーを throw する', () => {
    // Given
    const options = {
      branch: 'feat/my-branch',
      title: 'MR with repo',
      body: 'body',
      repo: 'org/repo',
    };

    // When
    const execute = () => createMergeRequest(options, '/project');

    // Then
    expect(execute).toThrow('--repo is not supported with GitLab provider. Use cwd context instead.');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockCheckGlabCli).not.toHaveBeenCalled();
  });
});

describe('commentOnMr', () => {
  it('成功時は success: true を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('');

    // When
    const result = commentOnMr(42, 'LGTM', '/project');

    // Then
    expect(result).toEqual({ success: true });
  });

  it('glab mr note コマンドを使用する', () => {
    // Given
    mockExecFileSync.mockReturnValue('');

    // When
    commentOnMr(42, 'Comment body', '/project');

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[0]).toBe('glab');
    expect(call[1]).toContain('mr');
    expect(call[1]).toContain('note');
    expect(call[1]).toContain('42');
  });

  it('失敗時は success: false とエラーメッセージを返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('Permission denied'); });

    // When
    const result = commentOnMr(42, 'comment', '/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('checkGlabCli に cwd を渡す', () => {
    // Given
    mockCheckGlabCli.mockReturnValue({ available: true });
    mockExecFileSync.mockReturnValue('');

    // When
    commentOnMr(42, 'LGTM', '/my/project');

    // Then
    expect(mockCheckGlabCli).toHaveBeenCalledWith('/my/project');
  });
});

describe('fetchMrReviewComments', () => {
  /** Helper: minimal MR view response */
  function makeMrViewResponse(overrides: Partial<{
    iid: number;
    title: string;
    description: string | null;
    web_url: string;
    source_branch: string;
    target_branch: string;
  }> = {}) {
    return {
      iid: overrides.iid ?? 1,
      title: overrides.title ?? 'MR',
      description: overrides.description ?? '',
      web_url: overrides.web_url ?? 'https://gitlab.com/org/repo/-/merge_requests/1',
      source_branch: overrides.source_branch ?? 'feat/x',
      target_branch: overrides.target_branch ?? 'main',
    };
  }

  it('MR メタデータとノートを統合して PrReviewData を返す', () => {
    // Given: glab mr view returns MR metadata
    const mrViewResponse = makeMrViewResponse({
      iid: 456,
      title: 'Fix auth bug',
      description: 'MR description',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/456',
      source_branch: 'fix/auth-bug',
      target_branch: 'main',
    });
    // glab api returns diffs
    const diffsResponse = [
      { new_path: 'src/auth.ts' },
      { new_path: 'src/auth.test.ts' },
    ];
    // glab api returns notes (discussions)
    const notesResponse = [
      {
        body: 'General comment on MR',
        author: { username: 'commenter1' },
        system: false,
        type: null,
      },
    ];
    // glab api returns discussions with inline diff notes
    const discussionsResponse = [
      {
        notes: [
          {
            body: 'Fix null check here',
            author: { username: 'reviewer1' },
            system: false,
            position: {
              new_path: 'src/auth.ts',
              new_line: 42,
            },
          },
        ],
      },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify(diffsResponse))
      .mockReturnValueOnce(JSON.stringify(notesResponse))
      .mockReturnValueOnce(JSON.stringify(discussionsResponse));

    // When
    const result = fetchMrReviewComments(456, '/project');

    // Then
    expect(result.number).toBe(456);
    expect(result.title).toBe('Fix auth bug');
    expect(result.body).toBe('MR description');
    expect(result.url).toBe('https://gitlab.com/org/repo/-/merge_requests/456');
    expect(result.headRefName).toBe('fix/auth-bug');
    expect(result.baseRefName).toBe('main');
    expect(result.files).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    expect(result.comments).toEqual([
      { author: 'commenter1', body: 'General comment on MR' },
    ]);
    expect(result.reviews).toEqual([
      { author: 'reviewer1', body: 'Fix null check here', path: 'src/auth.ts', line: 42 },
    ]);
  });

  it('system ノートはスキップする', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 10 });
    const notesResponse = [
      { body: 'approved this merge request', author: { username: 'bot' }, system: true, type: null },
      { body: 'Actual comment', author: { username: 'reviewer' }, system: false, type: null },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify(notesResponse))
      .mockReturnValueOnce(JSON.stringify([])); // no discussions

    // When
    const result = fetchMrReviewComments(10, '/project');

    // Then
    expect(result.comments).toEqual([
      { author: 'reviewer', body: 'Actual comment' },
    ]);
  });

  it('description が null の場合は空文字にマッピングする', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 11, description: null });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchMrReviewComments(11, '/project');

    // Then
    expect(result.body).toBe('');
  });

  it('ディスカッション内のインラインコメントで position がない場合はスキップする', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 12 });
    const discussionsResponse = [
      {
        notes: [
          {
            body: 'General discussion note',
            author: { username: 'reviewer1' },
            system: false,
            // no position field
          },
        ],
      },
      {
        notes: [
          {
            body: 'Inline note',
            author: { username: 'reviewer2' },
            system: false,
            position: { new_path: 'src/foo.ts', new_line: 10 },
          },
        ],
      },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify(discussionsResponse));

    // When
    const result = fetchMrReviewComments(12, '/project');

    // Then
    expect(result.reviews).toEqual([
      { author: 'reviewer2', body: 'Inline note', path: 'src/foo.ts', line: 10 },
    ]);
  });

  it('glab CLI がエラーの場合は例外を投げる', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: MR not found'); });

    // When / Then
    expect(() => fetchMrReviewComments(999, '/project')).toThrow();
  });

  it('glab mr view が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    mockExecFileSync.mockReturnValue('<html>502 Bad Gateway</html>');

    // When / Then
    expect(() => fetchMrReviewComments(100, '/project')).toThrow('glab returned invalid JSON');
  });

  it('notes API が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 101 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce('invalid json');

    // When / Then
    expect(() => fetchMrReviewComments(101, '/project')).toThrow('glab returned invalid JSON');
  });

  it('discussions API が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 102 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce('not json');

    // When / Then
    expect(() => fetchMrReviewComments(102, '/project')).toThrow('glab returned invalid JSON');
  });

  it('diffs, notes, discussions API に per_page パラメータが含まれる', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 200 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchMrReviewComments(200, '/project');

    // Then: verify diffs API call has per_page (call index 1, after mr view)
    const diffsCall = mockExecFileSync.mock.calls[1];
    const diffsApiPath = diffsCall[1][1] as string;
    expect(diffsApiPath).toContain('per_page=100');
    expect(diffsApiPath).toContain('diffs');

    // Then: verify notes API call has per_page (call index 2)
    const notesCall = mockExecFileSync.mock.calls[2];
    const notesApiPath = notesCall[1][1] as string;
    expect(notesApiPath).toContain('per_page=100');

    // Then: verify discussions API call has per_page (call index 3)
    const discussionsCall = mockExecFileSync.mock.calls[3];
    const discussionsApiPath = discussionsCall[1][1] as string;
    expect(discussionsApiPath).toContain('per_page=100');
  });

  it('notes が100件の場合は次ページを取得する（ページネーション）', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 300 });
    const firstPageNotes = Array.from({ length: 100 }, (_, i) => ({
      body: `Note ${i + 1}`,
      author: { username: 'commenter' },
      system: false,
    }));
    const secondPageNotes = [
      { body: 'Note 101', author: { username: 'commenter' }, system: false },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify(firstPageNotes))
      .mockReturnValueOnce(JSON.stringify(secondPageNotes))
      .mockReturnValueOnce(JSON.stringify([])); // discussions (single page)

    // When
    const result = fetchMrReviewComments(300, '/project');

    // Then
    expect(result.comments).toHaveLength(101);
    expect(result.comments[100]).toEqual({ author: 'commenter', body: 'Note 101' });
  });

  it('notes のページネーションで page パラメータが正しく増加する', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 301 });
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      body: `Note ${i}`,
      author: { username: 'user' },
      system: false,
    }));
    const secondPage = [
      { body: 'Last note', author: { username: 'user' }, system: false },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify(firstPage))
      .mockReturnValueOnce(JSON.stringify(secondPage))
      .mockReturnValueOnce(JSON.stringify([])); // discussions

    // When
    fetchMrReviewComments(301, '/project');

    // Then: verify page=1 for notes (call index 2, after mr view + diffs API)
    const notesCall1 = mockExecFileSync.mock.calls[2];
    const apiPath1 = notesCall1[1][1] as string;
    expect(apiPath1).toContain('page=1');
    expect(apiPath1).toContain('notes');

    // Then: verify page=2 for notes
    const notesCall2 = mockExecFileSync.mock.calls[3];
    const apiPath2 = notesCall2[1][1] as string;
    expect(apiPath2).toContain('page=2');
    expect(apiPath2).toContain('notes');
  });

  it('discussions が100件の場合は次ページを取得する（ページネーション）', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 302 });
    const firstPageDiscussions = Array.from({ length: 100 }, (_, i) => ({
      notes: [{
        body: `Discussion ${i + 1}`,
        author: { username: 'reviewer' },
        system: false,
        position: { new_path: 'src/app.ts', new_line: i + 1 },
      }],
    }));
    const secondPageDiscussions = [{
      notes: [{
        body: 'Discussion 101',
        author: { username: 'reviewer' },
        system: false,
        position: { new_path: 'src/app.ts', new_line: 101 },
      }],
    }];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([])) // notes (empty, single page)
      .mockReturnValueOnce(JSON.stringify(firstPageDiscussions))
      .mockReturnValueOnce(JSON.stringify(secondPageDiscussions));

    // When
    const result = fetchMrReviewComments(302, '/project');

    // Then
    expect(result.reviews).toHaveLength(101);
    expect(result.reviews[100]).toEqual({
      author: 'reviewer',
      body: 'Discussion 101',
      path: 'src/app.ts',
      line: 101,
    });
  });

  it('discussions のページネーションで page パラメータが正しく増加する', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 303 });
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      notes: [{
        body: `D${i}`,
        author: { username: 'r' },
        system: false,
        position: { new_path: 'a.ts', new_line: i },
      }],
    }));
    const secondPage = [{
      notes: [{
        body: 'Last',
        author: { username: 'r' },
        system: false,
        position: { new_path: 'a.ts', new_line: 100 },
      }],
    }];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([])) // notes
      .mockReturnValueOnce(JSON.stringify(firstPage))
      .mockReturnValueOnce(JSON.stringify(secondPage));

    // When
    fetchMrReviewComments(303, '/project');

    // Then: discussions page=1 (call index 3, after mr view + diffs API + notes)
    const discCall1 = mockExecFileSync.mock.calls[3];
    const discPath1 = discCall1[1][1] as string;
    expect(discPath1).toContain('page=1');
    expect(discPath1).toContain('discussions');

    // Then: discussions page=2
    const discCall2 = mockExecFileSync.mock.calls[4];
    const discPath2 = discCall2[1][1] as string;
    expect(discPath2).toContain('page=2');
    expect(discPath2).toContain('discussions');
  });

  it('notes に position を持つ DiffNote が含まれる場合、一般コメントから除外する', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 400 });
    const notesResponse = [
      {
        body: 'General comment',
        author: { username: 'commenter1' },
        system: false,
      },
      {
        body: 'Inline diff note that should be excluded',
        author: { username: 'reviewer1' },
        system: false,
        position: { new_path: 'src/foo.ts', new_line: 10 },
      },
      {
        body: 'Another general comment',
        author: { username: 'commenter2' },
        system: false,
      },
    ];
    const discussionsResponse = [
      {
        notes: [{
          body: 'Inline diff note that should be excluded',
          author: { username: 'reviewer1' },
          system: false,
          position: { new_path: 'src/foo.ts', new_line: 10 },
        }],
      },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify(notesResponse))
      .mockReturnValueOnce(JSON.stringify(discussionsResponse));

    // When
    const result = fetchMrReviewComments(400, '/project');

    // Then: DiffNote excluded from comments, only general comments remain
    expect(result.comments).toEqual([
      { author: 'commenter1', body: 'General comment' },
      { author: 'commenter2', body: 'Another general comment' },
    ]);
    // DiffNote appears in reviews via discussions
    expect(result.reviews).toEqual([
      { author: 'reviewer1', body: 'Inline diff note that should be excluded', path: 'src/foo.ts', line: 10 },
    ]);
  });

  it('GitLab API 経由で変更ファイル一覧を取得する', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 500 });
    const diffsResponse = [
      { new_path: 'src/a.ts' },
      { new_path: 'src/b.ts' },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify(diffsResponse))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchMrReviewComments(500, '/project');

    // Then
    expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);
    const diffsCall = mockExecFileSync.mock.calls[1];
    expect(diffsCall[0]).toBe('glab');
    expect(diffsCall[1][0]).toBe('api');
    const diffsApiPath = diffsCall[1][1] as string;
    expect(diffsApiPath).toContain('merge_requests/500/diffs');
  });

  it('diffs API が空配列を返す場合は空配列を返す', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 501 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // empty diffs
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchMrReviewComments(501, '/project');

    // Then
    expect(result.files).toEqual([]);
  });

  it('notes が100件未満の場合は追加ページを取得しない', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 304 });
    const fewNotes = Array.from({ length: 50 }, (_, i) => ({
      body: `Note ${i}`,
      author: { username: 'user' },
      system: false,
    }));
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify(fewNotes))
      .mockReturnValueOnce(JSON.stringify([])); // discussions

    // When
    fetchMrReviewComments(304, '/project');

    // Then: 4 calls total (mr view + diffs API + 1 page notes + 1 page discussions)
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
  });

  it('cwd を glab mr view の execFileSync に渡す', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 600 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchMrReviewComments(600, '/worktree/clone');

    // Then: glab mr view に cwd が渡される
    const mrViewCall = mockExecFileSync.mock.calls[0];
    expect(mrViewCall[2]).toHaveProperty('cwd', '/worktree/clone');
  });

  it('cwd を fetchAllPages（diffs, notes, discussions）にも伝搬する', () => {
    // Given
    const mrViewResponse = makeMrViewResponse({ iid: 601 });
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([])) // diffs API
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchMrReviewComments(601, '/worktree/clone');

    // Then: すべての execFileSync 呼び出しに cwd が渡される
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toHaveProperty('cwd', '/worktree/clone');
    }
  });

});
