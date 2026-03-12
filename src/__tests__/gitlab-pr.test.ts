/**
 * Tests for gitlab/pr module
 *
 * Tests MR operations via glab CLI mock, mirroring github-pr.test.ts pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/gitlab/issue.js', () => ({
  checkGlabCli: vi.fn().mockReturnValue({ available: true }),
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
    const result = findExistingMr('/project', 'task/fix-bug');

    // Then
    expect(result).toEqual({ number: 42, url: 'https://gitlab.com/org/repo/-/merge_requests/42' });
  });

  it('glab mr list を --source-branch オプションで呼び出す', () => {
    // Given
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    // When
    findExistingMr('/project', 'feat/my-feature');

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
    const result = findExistingMr('/project', 'task/no-mr');

    // Then
    expect(result).toBeUndefined();
  });

  it('glab CLI が失敗した場合は undefined を返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: command not found'); });

    // When
    const result = findExistingMr('/project', 'task/fix-bug');

    // Then
    expect(result).toBeUndefined();
  });
});

describe('createMergeRequest', () => {
  it('成功時は success: true と URL を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/1\n');

    // When
    const result = createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    });

    // Then
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://gitlab.com/org/repo/-/merge_requests/1');
  });

  it('--source-branch オプションで branch を渡す（--head ではない）', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/2\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    });

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--source-branch');
    expect(call[1]).not.toContain('--head');
  });

  it('--description オプションで body を渡す（--body ではない）', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/3\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My MR',
      body: 'MR body',
    });

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--description');
    expect(call[1]).not.toContain('--body');
  });

  it('draft: true の場合、args に --draft が含まれる', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/4\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'Draft MR',
      body: 'body',
      draft: true,
    });

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--draft');
  });

  it('draft: false の場合、args に --draft が含まれない', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/5\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'MR',
      body: 'body',
      draft: false,
    });

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });

  it('base が指定された場合、--target-branch で渡す', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/6\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'MR',
      body: 'body',
      base: 'develop',
    });

    // Then
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--target-branch');
    expect(call[1]).toContain('develop');
  });

  it('glab mr create が失敗した場合は success: false を返す', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('API error'); });

    // When
    const result = createMergeRequest('/project', {
      branch: 'feat/fail',
      title: 'Fail MR',
      body: 'body',
    });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('commentOnMr', () => {
  it('成功時は success: true を返す', () => {
    // Given
    mockExecFileSync.mockReturnValue('');

    // When
    const result = commentOnMr('/project', 42, 'LGTM');

    // Then
    expect(result).toEqual({ success: true });
  });

  it('glab mr note コマンドを使用する', () => {
    // Given
    mockExecFileSync.mockReturnValue('');

    // When
    commentOnMr('/project', 42, 'Comment body');

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
    const result = commentOnMr('/project', 42, 'comment');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('fetchMrReviewComments', () => {
  it('MR メタデータとノートを統合して PrReviewData を返す', () => {
    // Given: glab mr view returns MR metadata
    const mrViewResponse = {
      iid: 456,
      title: 'Fix auth bug',
      description: 'MR description',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/456',
      source_branch: 'fix/auth-bug',
      target_branch: 'main',
      diff_stats: [
        { old_path: 'src/auth.ts', new_path: 'src/auth.ts' },
        { old_path: 'src/auth.test.ts', new_path: 'src/auth.test.ts' },
      ],
    };
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
      .mockReturnValueOnce(JSON.stringify(notesResponse))
      .mockReturnValueOnce(JSON.stringify(discussionsResponse));

    // When
    const result = fetchMrReviewComments(456);

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
    const mrViewResponse = {
      iid: 10,
      title: 'MR',
      description: '',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/10',
      source_branch: 'feat/x',
      target_branch: 'main',
      diff_stats: [],
    };
    const notesResponse = [
      { body: 'approved this merge request', author: { username: 'bot' }, system: true, type: null },
      { body: 'Actual comment', author: { username: 'reviewer' }, system: false, type: null },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify(notesResponse))
      .mockReturnValueOnce(JSON.stringify([])); // no discussions

    // When
    const result = fetchMrReviewComments(10);

    // Then
    expect(result.comments).toEqual([
      { author: 'reviewer', body: 'Actual comment' },
    ]);
  });

  it('description が null の場合は空文字にマッピングする', () => {
    // Given
    const mrViewResponse = {
      iid: 11,
      title: 'No description',
      description: null,
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/11',
      source_branch: 'feat/y',
      target_branch: 'main',
      diff_stats: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchMrReviewComments(11);

    // Then
    expect(result.body).toBe('');
  });

  it('ディスカッション内のインラインコメントで position がない場合はスキップする', () => {
    // Given
    const mrViewResponse = {
      iid: 12,
      title: 'MR',
      description: '',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/12',
      source_branch: 'feat/z',
      target_branch: 'main',
      diff_stats: [],
    };
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
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify(discussionsResponse));

    // When
    const result = fetchMrReviewComments(12);

    // Then
    expect(result.reviews).toEqual([
      { author: 'reviewer2', body: 'Inline note', path: 'src/foo.ts', line: 10 },
    ]);
  });

  it('glab CLI がエラーの場合は例外を投げる', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('glab: MR not found'); });

    // When / Then
    expect(() => fetchMrReviewComments(999)).toThrow();
  });

  it('glab mr view が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    mockExecFileSync.mockReturnValue('<html>502 Bad Gateway</html>');

    // When / Then
    expect(() => fetchMrReviewComments(100)).toThrow('glab returned invalid JSON');
  });

  it('notes API が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    const mrViewResponse = {
      iid: 101,
      title: 'MR',
      description: '',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/101',
      source_branch: 'feat/x',
      target_branch: 'main',
      diff_stats: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce('invalid json');

    // When / Then
    expect(() => fetchMrReviewComments(101)).toThrow('glab returned invalid JSON');
  });

  it('discussions API が不正な JSON を返した場合は明確なエラーメッセージをスローする', () => {
    // Given
    const mrViewResponse = {
      iid: 102,
      title: 'MR',
      description: '',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/102',
      source_branch: 'feat/x',
      target_branch: 'main',
      diff_stats: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce('not json');

    // When / Then
    expect(() => fetchMrReviewComments(102)).toThrow('glab returned invalid JSON');
  });

  it('notes API と discussions API に per_page=100 パラメータが含まれる', () => {
    // Given
    const mrViewResponse = {
      iid: 200,
      title: 'MR',
      description: '',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/200',
      source_branch: 'feat/pagination',
      target_branch: 'main',
      diff_stats: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(mrViewResponse))
      .mockReturnValueOnce(JSON.stringify([]))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchMrReviewComments(200);

    // Then: verify notes API call has per_page=100
    const notesCall = mockExecFileSync.mock.calls[1];
    const notesApiPath = notesCall[1][1] as string;
    expect(notesApiPath).toContain('per_page=100');

    // Then: verify discussions API call has per_page=100
    const discussionsCall = mockExecFileSync.mock.calls[2];
    const discussionsApiPath = discussionsCall[1][1] as string;
    expect(discussionsApiPath).toContain('per_page=100');
  });

  it('glab mr create は --repo オプションを含まない', () => {
    // Given
    mockExecFileSync.mockReturnValue('https://gitlab.com/org/repo/-/merge_requests/7\n');

    // When
    createMergeRequest('/project', {
      branch: 'feat/my-branch',
      title: 'MR with repo',
      body: 'body',
      repo: 'org/repo',
    });

    // Then: --repo should NOT be passed to glab
    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--repo');
  });
});
