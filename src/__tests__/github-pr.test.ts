/**
 * Tests for github/pr module
 *
 * Tests buildPrBody formatting and findExistingPr logic.
 * createPullRequest/pushBranch/commentOnPr call `gh`/`git` CLI, not unit-tested here.
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

import { buildPrBody, findExistingPr, createPullRequest } from '../infra/github/pr.js';
import type { GitHubIssue } from '../infra/github/types.js';

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
