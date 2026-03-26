import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/github/issue.js', () => ({
  checkGhCli: vi.fn().mockReturnValue({ available: true }),
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

import { findExistingPr, createPullRequest, fetchPrReviewComments } from '../infra/github/pr.js';
import { buildPrBody, formatPrReviewAsTask } from '../infra/git/format.js';
import type { Issue, PrReviewData } from '../infra/git/types.js';

describe('findExistingPr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('オープンな PR がある場合はその PR を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ number: 42, url: 'https://github.com/org/repo/pull/42' }]));

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toEqual({ number: 42, url: 'https://github.com/org/repo/pull/42' });
  });

  it('PR がない場合は undefined を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toBeUndefined();
  });

  it('gh CLI が失敗した場合は undefined を返す', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: command not found'); });

    const result = findExistingPr('task/fix-bug', '/project');

    expect(result).toBeUndefined();
  });
});

describe('createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draft: true の場合、args に --draft が含まれる', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/1\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: true,
    }, '/project');

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--draft');
  });

  it('draft: false の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/2\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: false,
    }, '/project');

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });

  it('draft が未指定の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/3\n');

    createPullRequest({
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
    }, '/project');

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });
});

describe('buildPrBody', () => {
  it('should build body with single issue and report', () => {
    const issue: Issue = {
      number: 99,
      title: 'Add login feature',
      body: 'Implement username/password authentication.',
      labels: [],
      comments: [],
    };

    const result = buildPrBody([issue], 'Piece `default` completed.');

    expect(result).toContain('## Summary');
    expect(result).toContain('Implement username/password authentication.');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Piece `default` completed.');
    expect(result).toContain('Closes #99');
  });

  it('should use title when body is empty', () => {
    const issue: Issue = {
      number: 10,
      title: 'Fix bug',
      body: '',
      labels: [],
      comments: [],
    };

    const result = buildPrBody([issue], 'Done.');

    expect(result).toContain('Fix bug');
    expect(result).toContain('Closes #10');
  });

  it('should build body without issue', () => {
    const result = buildPrBody(undefined, 'Task completed.');

    expect(result).toContain('## Summary');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Task completed.');
    expect(result).not.toContain('Closes');
  });

  it('should support multiple issues', () => {
    const issues: Issue[] = [
      {
        number: 1,
        title: 'First issue',
        body: 'First issue body.',
        labels: [],
        comments: [],
      },
      {
        number: 2,
        title: 'Second issue',
        body: 'Second issue body.',
        labels: [],
        comments: [],
      },
    ];

    const result = buildPrBody(issues, 'Done.');

    expect(result).toContain('## Summary');
    expect(result).toContain('First issue body.');
    expect(result).toContain('Closes #1');
    expect(result).toContain('Closes #2');
  });

});

describe('fetchPrReviewComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return PrReviewData when gh pr view JSON is valid', () => {
    // Given
    const ghResponse = {
      number: 456,
      title: 'Fix auth bug',
      body: 'PR description',
      url: 'https://github.com/org/repo/pull/456',
      baseRefName: 'release/main',
      headRefName: 'fix/auth-bug',
      comments: [
        { author: { login: 'commenter1' }, body: 'Please update tests' },
      ],
      reviews: [
        {
          author: { login: 'reviewer1' },
          body: 'Looks mostly good',
        },
        {
          author: { login: 'reviewer2' },
          body: '',
        },
      ],
      files: [
        { path: 'src/auth.ts' },
        { path: 'src/auth.test.ts' },
      ],
    };
    const inlineCommentsResponse = [
      { body: 'Fix null check here', path: 'src/auth.ts', line: 42, user: { login: 'reviewer1' } },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify(inlineCommentsResponse));

    // When
    const result = fetchPrReviewComments(456, '/project');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '456', '--json', 'number,title,body,url,headRefName,baseRefName,comments,reviews,files'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/org/repo/pulls/456/comments?per_page=100&page=1'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(result.number).toBe(456);
    expect(result.title).toBe('Fix auth bug');
    expect((result as { baseRefName?: string }).baseRefName).toBe('release/main');
    expect(result.headRefName).toBe('fix/auth-bug');
    expect(result.comments).toEqual([{ author: 'commenter1', body: 'Please update tests' }]);
    expect(result.reviews).toEqual([
      { author: 'reviewer1', body: 'Looks mostly good' },
      { author: 'reviewer1', body: 'Fix null check here', path: 'src/auth.ts', line: 42 },
    ]);
    expect(result.files).toEqual(['src/auth.ts', 'src/auth.test.ts']);
  });

  it('should skip reviews with empty body', () => {
    // Given
    const ghResponse = {
      number: 10,
      title: 'Approved PR',
      body: '',
      url: 'https://github.com/org/repo/pull/10',
      headRefName: 'feat/approved',
      comments: [],
      reviews: [
        { author: { login: 'approver' }, body: '' },
      ],
      files: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    const result = fetchPrReviewComments(10, '/project');

    // Then
    expect(result.reviews).toEqual([]);
  });

  it('should include inline comments from pulls comments API even when review bodies are empty', () => {
    // Given
    const ghResponse = {
      number: 11,
      title: 'Inline only',
      body: '',
      url: 'https://github.com/org/repo/pull/11',
      headRefName: 'fix/inline-only',
      comments: [],
      reviews: [
        { author: { login: 'approver' }, body: '' },
      ],
      files: [],
    };
    const inlineCommentsResponse = [
      { body: 'Address this edge case', path: 'src/index.ts', line: 7, user: { login: 'reviewer3' } },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify(inlineCommentsResponse));

    // When
    const result = fetchPrReviewComments(11, '/project');

    // Then
    expect(result.reviews).toEqual([
      { author: 'reviewer3', body: 'Address this edge case', path: 'src/index.ts', line: 7 },
    ]);
  });

  it('should fetch all inline review comments when total comments exceed one default page', () => {
    // Given
    const ghResponse = {
      number: 12,
      title: 'Many inline comments',
      body: '',
      url: 'https://github.com/org/repo/pull/12',
      headRefName: 'fix/many-inline-comments',
      comments: [],
      reviews: [],
      files: [],
    };
    const inlineCommentsResponse = Array.from({ length: 31 }, (_, i) => ({
      body: `Inline comment ${i + 1}`,
      path: 'src/index.ts',
      line: i + 1,
      user: { login: 'reviewer-pagination' },
    }));
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify(inlineCommentsResponse));

    // When
    const result = fetchPrReviewComments(12, '/project');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/org/repo/pulls/12/comments?per_page=100&page=1'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(result.reviews).toHaveLength(31);
    expect(result.reviews[0]).toEqual({
      author: 'reviewer-pagination',
      body: 'Inline comment 1',
      path: 'src/index.ts',
      line: 1,
    });
    expect(result.reviews[30]).toEqual({
      author: 'reviewer-pagination',
      body: 'Inline comment 31',
      path: 'src/index.ts',
      line: 31,
    });
  });

  it('should request additional pages when inline review comments exceed per_page', () => {
    // Given
    const ghResponse = {
      number: 13,
      title: 'Paginated inline comments',
      body: '',
      url: 'https://github.com/org/repo/pull/13',
      headRefName: 'fix/paginated-inline-comments',
      comments: [],
      reviews: [],
      files: [],
    };
    const firstPageInlineComments = Array.from({ length: 100 }, (_, i) => ({
      body: `Inline comment ${i + 1}`,
      path: 'src/index.ts',
      line: i + 1,
      user: { login: 'reviewer-pagination' },
    }));
    const secondPageInlineComments = [
      { body: 'Inline comment 101', path: 'src/index.ts', line: 101, user: { login: 'reviewer-pagination' } },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify(firstPageInlineComments))
      .mockReturnValueOnce(JSON.stringify(secondPageInlineComments));

    // When
    const result = fetchPrReviewComments(13, '/project');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/org/repo/pulls/13/comments?per_page=100&page=1'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '/repos/org/repo/pulls/13/comments?per_page=100&page=2'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(result.reviews).toHaveLength(101);
    expect(result.reviews[100]).toEqual({
      author: 'reviewer-pagination',
      body: 'Inline comment 101',
      path: 'src/index.ts',
      line: 101,
    });
  });

  it('should fallback to original_line when line is null', () => {
    // Given
    const ghResponse = {
      number: 14,
      title: 'Keep original line',
      body: '',
      url: 'https://github.com/org/repo/pull/14',
      headRefName: 'fix/original-line',
      comments: [],
      reviews: [],
      files: [],
    };
    const inlineCommentsResponse = [
      {
        body: 'Line moved after suggestion',
        path: 'src/index.ts',
        line: null,
        original_line: 27,
        user: { login: 'reviewer-original-line' },
      },
    ];
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify(inlineCommentsResponse));

    // When
    const result = fetchPrReviewComments(14, '/project');

    // Then
    expect(result.reviews).toEqual([
      {
        author: 'reviewer-original-line',
        body: 'Line moved after suggestion',
        path: 'src/index.ts',
        line: 27,
      },
    ]);
  });

  it('should return collected comments when MAX_PAGES limit is reached', () => {
    // Given
    const ghResponse = {
      number: 15,
      title: 'Max pages hit',
      body: '',
      url: 'https://github.com/org/repo/pull/15',
      headRefName: 'fix/max-pages',
      comments: [],
      reviews: [],
      files: [],
    };
    // Every page returns exactly per_page (100) items, simulating a never-ending API
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      body: `Comment ${i + 1}`,
      path: 'src/index.ts',
      line: i + 1,
      user: { login: 'reviewer-max-pages' },
    }));

    mockExecFileSync.mockReturnValueOnce(JSON.stringify(ghResponse));
    // Return full pages for all 100 pages
    for (let i = 0; i < 100; i++) {
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(fullPage));
    }

    // When
    const result = fetchPrReviewComments(15, '/project');

    // Then — should have called gh api exactly 101 times (1 for pr view + 100 pages)
    expect(mockExecFileSync).toHaveBeenCalledTimes(101);
    // Should have collected 100 pages × 100 comments = 10000 comments
    expect(result.reviews).toHaveLength(10000);
  });

  it('should pass cwd to all execFileSync calls', () => {
    // Given
    const ghResponse = {
      number: 50,
      title: 'cwd test',
      body: '',
      url: 'https://github.com/org/repo/pull/50',
      headRefName: 'fix/cwd',
      comments: [],
      reviews: [],
      files: [],
    };
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(ghResponse))
      .mockReturnValueOnce(JSON.stringify([]));

    // When
    fetchPrReviewComments(50, '/worktree/clone');

    // Then: all execFileSync calls should include cwd
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ cwd: '/worktree/clone' }));
    }
  });

  it('should throw when gh CLI fails', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: PR not found'); });

    // When/Then
    expect(() => fetchPrReviewComments(999, '/project')).toThrow('gh: PR not found');
  });
});

describe('formatPrReviewAsTask', () => {
  it('should format PR review data with all sections', () => {
    // Given
    const prReview: PrReviewData = {
      number: 456,
      title: 'Fix auth bug',
      body: 'PR description text',
      url: 'https://github.com/org/repo/pull/456',
      headRefName: 'fix/auth-bug',
      comments: [
        { author: 'commenter1', body: 'Can you also update the tests?' },
      ],
      reviews: [
        { author: 'reviewer1', body: 'Fix the null check in auth.ts', path: 'src/auth.ts', line: 42 },
        { author: 'reviewer2', body: 'This function should handle edge cases' },
      ],
      files: ['src/auth.ts', 'src/auth.test.ts'],
    };

    // When
    const result = formatPrReviewAsTask(prReview);

    // Then
    expect(result).toContain('## PR #456 Review Comments: Fix auth bug');
    expect(result).toContain('### PR Description');
    expect(result).toContain('PR description text');
    expect(result).toContain('### Review Comments');
    expect(result).toContain('**reviewer1**: Fix the null check in auth.ts');
    expect(result).toContain('File: src/auth.ts, Line: 42');
    expect(result).toContain('**reviewer2**: This function should handle edge cases');
    expect(result).toContain('### Conversation Comments');
    expect(result).toContain('**commenter1**: Can you also update the tests?');
    expect(result).toContain('### Changed Files');
    expect(result).toContain('- src/auth.ts');
    expect(result).toContain('- src/auth.test.ts');
  });

  it('should omit PR Description when body is empty', () => {
    // Given
    const prReview: PrReviewData = {
      number: 10,
      title: 'Quick fix',
      body: '',
      url: 'https://github.com/org/repo/pull/10',
      headRefName: 'fix/quick',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Fix this' }],
      files: [],
    };

    // When
    const result = formatPrReviewAsTask(prReview);

    // Then
    expect(result).not.toContain('### PR Description');
    expect(result).toContain('### Review Comments');
  });

  it('should omit empty sections', () => {
    // Given
    const prReview: PrReviewData = {
      number: 20,
      title: 'Empty review',
      body: '',
      url: 'https://github.com/org/repo/pull/20',
      headRefName: 'feat/empty',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Add tests' }],
      files: [],
    };

    // When
    const result = formatPrReviewAsTask(prReview);

    // Then
    expect(result).not.toContain('### Conversation Comments');
    expect(result).not.toContain('### Changed Files');
    expect(result).toContain('### Review Comments');
  });

  it('should format inline comment with path but no line', () => {
    // Given
    const prReview: PrReviewData = {
      number: 30,
      title: 'Path only',
      body: '',
      url: 'https://github.com/org/repo/pull/30',
      headRefName: 'feat/path-only',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Fix this', path: 'src/index.ts' }],
      files: [],
    };

    // When
    const result = formatPrReviewAsTask(prReview);

    // Then
    expect(result).toContain('File: src/index.ts');
    expect(result).not.toContain('Line:');
  });
});
