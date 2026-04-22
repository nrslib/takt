import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listOpenIssues } from '../infra/github/issue.js';
import {
  parseIssueNumbers,
  isIssueReference,
  formatIssueAsTask,
} from '../infra/git/format.js';
import type { Issue } from '../infra/git/types.js';

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
  getErrorMessage: (error: unknown) => String(error),
}));

function withGhApiResponse(body: unknown, nextPath?: string): string {
  const headers = [
    'HTTP/2 200 OK',
    'content-type: application/json',
    ...(nextPath ? [`link: <https://api.github.com${nextPath}>; rel="next"`] : []),
  ];
  return `${headers.join('\n')}\n\n${JSON.stringify(body)}`;
}

describe('listOpenIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
  });

  it('repo 全体の open issue を後続ページまで取得して PR を除外する', () => {
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockReturnValueOnce(withGhApiResponse(
        [
          {
            number: 586,
            title: 'First issue',
            labels: [{ name: 'takt-managed' }],
            updated_at: '2026-04-20T12:00:00Z',
          },
          {
            number: 900,
            title: 'Open pull request masquerading as issue',
            labels: [{ name: 'takt-managed' }],
            updated_at: '2026-04-20T12:30:00Z',
            pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/900' },
          },
        ],
        '/repos/org/repo/issues?state=open&per_page=100&page=2',
      ))
      .mockReturnValueOnce(withGhApiResponse([
        {
          number: 587,
          title: 'Second issue',
          labels: [{ name: 'bug' }],
          updated_at: '2026-04-21T08:00:00Z',
        },
      ]));

    const result = listOpenIssues('/project');

    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', '--include', 'repos/org/repo/issues?state=open&per_page=100&page=1'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      'gh',
      ['api', '--include', '/repos/org/repo/issues?state=open&per_page=100&page=2'],
      expect.objectContaining({ cwd: '/project', encoding: 'utf-8' }),
    );
    expect(result).toEqual([
      { number: 586, title: 'First issue', labels: ['takt-managed'], updated_at: '2026-04-20T12:00:00Z' },
      { number: 587, title: 'Second issue', labels: ['bug'], updated_at: '2026-04-21T08:00:00Z' },
    ]);
  });

  it('pagination link が上限を超えて続く場合は明示エラーにする', () => {
    let page = 1;
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ nameWithOwner: 'org/repo' }))
      .mockImplementation(() => {
        const response = withGhApiResponse(
          [{
            number: page,
            title: `Issue ${page}`,
            labels: [{ name: 'takt-managed' }],
            updated_at: '2026-04-21T00:00:00Z',
          }],
          `/repos/org/repo/issues?state=open&per_page=100&page=${page + 1}`,
        );
        page += 1;
        return response;
      });

    expect(() => listOpenIssues('/project')).toThrow(
      'Pagination limit exceeded while fetching open issue list (>100 pages)',
    );
  });
});

describe('parseIssueNumbers', () => {
  it('should parse single issue reference', () => {
    expect(parseIssueNumbers(['#6'])).toEqual([6]);
  });

  it('should parse multiple issue references', () => {
    expect(parseIssueNumbers(['#6', '#7'])).toEqual([6, 7]);
  });

  it('should parse large issue numbers', () => {
    expect(parseIssueNumbers(['#123'])).toEqual([123]);
  });

  it('should return empty for non-issue args', () => {
    expect(parseIssueNumbers(['Fix bug'])).toEqual([]);
  });

  it('should return empty when mixed issue and non-issue args', () => {
    expect(parseIssueNumbers(['#6', 'and', '#7'])).toEqual([]);
  });

  it('should return empty for empty args', () => {
    expect(parseIssueNumbers([])).toEqual([]);
  });

  it('should not match partial issue patterns', () => {
    expect(parseIssueNumbers(['#abc'])).toEqual([]);
    expect(parseIssueNumbers(['#'])).toEqual([]);
    expect(parseIssueNumbers(['##6'])).toEqual([]);
    expect(parseIssueNumbers(['6'])).toEqual([]);
    expect(parseIssueNumbers(['issue#6'])).toEqual([]);
  });

  it('should handle #0', () => {
    expect(parseIssueNumbers(['#0'])).toEqual([0]);
  });
});

describe('isIssueReference', () => {
  it('should return true for #N patterns', () => {
    expect(isIssueReference('#6')).toBe(true);
    expect(isIssueReference('#123')).toBe(true);
  });

  it('should return true with whitespace trim', () => {
    expect(isIssueReference(' #6 ')).toBe(true);
  });

  it('should return false for non-issue text', () => {
    expect(isIssueReference('Fix bug')).toBe(false);
    expect(isIssueReference('#abc')).toBe(false);
    expect(isIssueReference('')).toBe(false);
    expect(isIssueReference('#')).toBe(false);
    expect(isIssueReference('6')).toBe(false);
  });

  it('should return false for issue number followed by text (issue #32)', () => {
    expect(isIssueReference('#32あああ')).toBe(false);
    expect(isIssueReference('#10abc')).toBe(false);
    expect(isIssueReference('#123text')).toBe(false);
  });

  it('should return false for multiple issues (single string)', () => {
    expect(isIssueReference('#6 #7')).toBe(false);
  });
});

describe('formatIssueAsTask', () => {
  it('should format issue with all fields', () => {
    const issue: Issue = {
      number: 6,
      title: 'Fix authentication bug',
      body: 'The login flow is broken.',
      labels: ['bug', 'priority:high'],
      comments: [
        { author: 'user1', body: 'I can reproduce this.' },
        { author: 'user2', body: 'Fixed in PR #7.' },
      ],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('## Issue #6: Fix authentication bug');
    expect(result).toContain('The login flow is broken.');
    expect(result).toContain('### Labels');
    expect(result).toContain('bug, priority:high');
    expect(result).toContain('### Comments');
    expect(result).toContain('**user1**: I can reproduce this.');
    expect(result).toContain('**user2**: Fixed in PR #7.');
  });

  it('should format issue with no body', () => {
    const issue: Issue = {
      number: 10,
      title: 'Empty issue',
      body: '',
      labels: [],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toBe('## Issue #10: Empty issue');
    expect(result).not.toContain('### Labels');
    expect(result).not.toContain('### Comments');
  });

  it('should format issue with labels but no comments', () => {
    const issue: Issue = {
      number: 5,
      title: 'Feature request',
      body: 'Add dark mode.',
      labels: ['enhancement'],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('### Labels');
    expect(result).toContain('enhancement');
    expect(result).not.toContain('### Comments');
  });

  it('should format issue with comments but no labels', () => {
    const issue: Issue = {
      number: 3,
      title: 'Discussion',
      body: 'Thoughts?',
      labels: [],
      comments: [
        { author: 'dev', body: 'LGTM' },
      ],
    };

    const result = formatIssueAsTask(issue);

    expect(result).not.toContain('### Labels');
    expect(result).toContain('### Comments');
    expect(result).toContain('**dev**: LGTM');
  });

  it('should handle multiline body', () => {
    const issue: Issue = {
      number: 1,
      title: 'Multi-line',
      body: 'Line 1\nLine 2\n\nLine 4',
      labels: [],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain('Line 1\nLine 2\n\nLine 4');
  });
});
