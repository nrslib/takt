/**
 * Tests for github/pr module
 *
 * Tests buildPrBody formatting and findExistingPr logic.
 * createPullRequest/commentOnPr call `gh` CLI, not unit-tested here.
 */

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

import { buildPrBody, findExistingPr, createPullRequest, fetchPrReviewComments, formatPrReviewAsTask } from '../infra/github/pr.js';
import type { GitHubIssue } from '../infra/github/types.js';
import type { PrReviewData } from '../infra/git/types.js';

describe('findExistingPr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('オープンな PR がある場合はその PR を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ number: 42, url: 'https://github.com/org/repo/pull/42' }]));

    const result = findExistingPr('/project', 'task/fix-bug');

    expect(result).toEqual({ number: 42, url: 'https://github.com/org/repo/pull/42' });
  });

  it('PR がない場合は undefined を返す', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    const result = findExistingPr('/project', 'task/fix-bug');

    expect(result).toBeUndefined();
  });

  it('gh CLI が失敗した場合は undefined を返す', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: command not found'); });

    const result = findExistingPr('/project', 'task/fix-bug');

    expect(result).toBeUndefined();
  });
});

describe('createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draft: true の場合、args に --draft が含まれる', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/1\n');

    createPullRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: true,
    });

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).toContain('--draft');
  });

  it('draft: false の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/2\n');

    createPullRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
      draft: false,
    });

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });

  it('draft が未指定の場合、args に --draft が含まれない', () => {
    mockExecFileSync.mockReturnValue('https://github.com/org/repo/pull/3\n');

    createPullRequest('/project', {
      branch: 'feat/my-branch',
      title: 'My PR',
      body: 'PR body',
    });

    const call = mockExecFileSync.mock.calls[0];
    expect(call[1]).not.toContain('--draft');
  });
});

describe('buildPrBody', () => {
  it('should build body with single issue and report', () => {
    const issue: GitHubIssue = {
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
    const issue: GitHubIssue = {
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
    const issues: GitHubIssue[] = [
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

  it('should parse gh pr view JSON and return PrReviewData', () => {
    // Given
    const ghResponse = {
      number: 456,
      title: 'Fix auth bug',
      body: 'PR description',
      url: 'https://github.com/org/repo/pull/456',
      headRefName: 'fix/auth-bug',
      comments: [
        { author: { login: 'commenter1' }, body: 'Please update tests' },
      ],
      reviews: [
        {
          author: { login: 'reviewer1' },
          body: 'Looks mostly good',
          comments: [
            { body: 'Fix null check here', path: 'src/auth.ts', line: 42, author: { login: 'reviewer1' } },
          ],
        },
        {
          author: { login: 'reviewer2' },
          body: '',
          comments: [],
        },
      ],
      files: [
        { path: 'src/auth.ts' },
        { path: 'src/auth.test.ts' },
      ],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(ghResponse));

    // When
    const result = fetchPrReviewComments(456);

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '456', '--json', 'number,title,body,url,headRefName,comments,reviews,files'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(result.number).toBe(456);
    expect(result.title).toBe('Fix auth bug');
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
        { author: { login: 'approver' }, body: '', comments: [] },
      ],
      files: [],
    };
    mockExecFileSync.mockReturnValue(JSON.stringify(ghResponse));

    // When
    const result = fetchPrReviewComments(10);

    // Then
    expect(result.reviews).toEqual([]);
  });

  it('should throw when gh CLI fails', () => {
    // Given
    mockExecFileSync.mockImplementation(() => { throw new Error('gh: PR not found'); });

    // When/Then
    expect(() => fetchPrReviewComments(999)).toThrow('gh: PR not found');
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
