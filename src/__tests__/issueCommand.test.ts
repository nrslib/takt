import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../infra/git/index.js';

const { mockProvider } = vi.hoisted(() => ({ mockProvider: { fetchIssue: vi.fn(), checkCliStatus: vi.fn() } }));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => mockProvider,
}));

import { formatIssueAsTask } from '../infra/git/index.js';
import { resolveIssueCommand } from '../features/interactive/issueCommand.js';

function createIssue(number: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    labels: ['bug'],
    comments: [],
  };
}

describe('resolveIssueCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.checkCliStatus.mockReturnValue({ available: true });
    mockProvider.fetchIssue.mockImplementation((number: number) => createIssue(number));
  });

  it('should normalize bare and # prefixed numbers and join formatted Issues in order', () => {
    const result = resolveIssueCommand('/project', '123 #456', 'en');

    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/project');
    expect(mockProvider.fetchIssue.mock.calls).toEqual([[123, '/project'], [456, '/project']]);
    expect(result.sourceContext).toBe([
      formatIssueAsTask(createIssue(123)),
      formatIssueAsTask(createIssue(456)),
    ].join('\n\n---\n\n'));
    expect(result).not.toHaveProperty('issueNumber');
    expect(result.notice).toContain('#123');
    expect(result.notice).toContain('#456');
  });

  it('should expose the number when exactly one Issue was fetched', () => {
    const result = resolveIssueCommand('/project', '#123', 'ja');

    expect(result.issueNumber).toBe(123);
    expect(result.sourceContext).toBe(formatIssueAsTask(createIssue(123)));
    expect(result.notice).toContain('#123');
  });

  it('should accept the largest safe Issue number', () => {
    const result = resolveIssueCommand('/project', String(Number.MAX_SAFE_INTEGER), 'en');

    expect(mockProvider.fetchIssue).toHaveBeenCalledExactlyOnceWith(Number.MAX_SAFE_INTEGER, '/project');
    expect(result.issueNumber).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should require at least one Issue number', () => {
    expect(() => resolveIssueCommand('/project', '  ', 'en')).toThrow('/issue 123 456');
    expect(mockProvider.checkCliStatus).not.toHaveBeenCalled();
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('should reject mixed non-number arguments before fetching', () => {
    expect(() => resolveIssueCommand('/project', '123 nope', 'en')).toThrow('Issue numbers');
    expect(mockProvider.checkCliStatus).not.toHaveBeenCalled();
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it.each([
    '0',
    '#0',
    '9007199254740992',
    '#9007199254740993',
    '99999999999999999999999999999999999999999999999999999',
    '123 0',
    '123 #9007199254740993',
  ])('should reject an invalid Issue number before fetching: %s', (input) => {
    expect(() => resolveIssueCommand('/project', input, 'en')).toThrow();
    expect(mockProvider.checkCliStatus).not.toHaveBeenCalled();
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('should stop when the provider CLI is unavailable', () => {
    mockProvider.checkCliStatus.mockReturnValue({ available: false, error: 'gh unavailable' });

    expect(() => resolveIssueCommand('/project', '123', 'en')).toThrow('gh unavailable');
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('should not return a partial replacement when a later Issue fetch fails', () => {
    mockProvider.fetchIssue.mockImplementation((number: number) => {
      if (number === 456) throw new Error('Issue not found');
      return createIssue(number);
    });

    expect(() => resolveIssueCommand('/project', '123 456', 'en')).toThrow('Issue not found');
    expect(mockProvider.fetchIssue.mock.calls).toEqual([[123, '/project'], [456, '/project']]);
  });
});
