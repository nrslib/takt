/**
 * Tests for createIssue function
 *
 * createIssue uses `gh issue create` via execFileSync, which is an
 * integration concern. Tests focus on argument construction and error handling
 * by mocking child_process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { closeIssue, createIssue } from '../infra/github/issue.js';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createIssue', () => {
  it('should return success with URL when gh issue create succeeds', () => {
    // Given: gh auth and issue creation both succeed
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/42\n' as unknown as Buffer);

    // When
    const result = createIssue({ title: 'Test issue', body: 'Test body' }, '/project');

    // Then
    expect(result).toEqual({
      success: true,
      issueNumber: 42,
      url: 'https://github.com/owner/repo/issues/42',
    });
  });

  it('should pass title and body as arguments', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'My Title', body: 'My Body' }, '/project');

    // Then: verify the second call (issue create) has correct args
    const issueCreateCall = mockExecFileSync.mock.calls[1];
    expect(issueCreateCall?.[0]).toBe('gh');
    expect(issueCreateCall?.[1]).toEqual([
      'issue', 'create', '--title', 'My Title', '--body', 'My Body',
    ]);
  });

  it('should include labels when provided and they exist on the repo', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('bug\npriority:high\n' as unknown as Buffer) // gh label list
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Bug', body: 'Fix it', labels: ['bug', 'priority:high'] }, '/project');

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[2];
    expect(issueCreateCall?.[1]).toEqual([
      'issue', 'create', '--title', 'Bug', '--body', 'Fix it',
      '--label', 'bug,priority:high',
    ]);
  });

  it('should skip non-existent labels', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('bug\n' as unknown as Buffer) // gh label list (only bug exists)
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Bug', body: 'Fix it', labels: ['bug', 'Docs'] }, '/project');

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[2];
    expect(issueCreateCall?.[1]).toEqual([
      'issue', 'create', '--title', 'Bug', '--body', 'Fix it',
      '--label', 'bug',
    ]);
  });

  it('should not include --label when labels is empty', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Title', body: 'Body', labels: [] }, '/project');

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[1];
    expect(issueCreateCall?.[1]).not.toContain('--label');
  });

  it('should not include --label when all labels are non-existent', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('bug\n' as unknown as Buffer) // gh label list
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Title', body: 'Body', labels: ['Docs', 'Chore'] }, '/project');

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[2];
    expect(issueCreateCall?.[1]).not.toContain('--label');
  });

  it('should return error when gh CLI is not authenticated', () => {
    // Given: auth fails, version succeeds
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not authenticated'); })
      .mockReturnValueOnce(Buffer.from('gh version 2.0.0'));

    // When
    const result = createIssue({ title: 'Test', body: 'Body' }, '/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
  });

  it('should return error when gh CLI is not installed', () => {
    // Given: both auth and version fail
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('command not found'); })
      .mockImplementationOnce(() => { throw new Error('command not found'); });

    // When
    const result = createIssue({ title: 'Test', body: 'Body' }, '/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('not installed');
  });

  it('should pass cwd to execFileSync for all gh commands', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('bug\n' as unknown as Buffer) // gh label list
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Title', body: 'Body', labels: ['bug'] }, '/worktree/clone');

    // Then: all execFileSync calls should include cwd
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ cwd: '/worktree/clone' }));
    }
  });

  it('should return error when gh issue create fails', () => {
    // Given: auth succeeds but issue creation fails
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockImplementationOnce(() => { throw new Error('repo not found'); });

    // When
    const result = createIssue({ title: 'Test', body: 'Body' }, '/project');

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('repo not found');
  });

  it('should return error when gh issue create returns a URL without a numeric issue number', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce('https://github.com/owner/repo/issues/not-a-number\n' as unknown as Buffer);

    const result = createIssue({ title: 'Test', body: 'Body' }, '/project');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(
        'Issue URL must end with a positive issue number: https://github.com/owner/repo/issues/not-a-number',
      ),
    });
  });

  it('should return error when gh issue create returns a URL with a trailing slash', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce('https://github.com/owner/repo/issues/42/\n' as unknown as Buffer);

    const result = createIssue({ title: 'Test', body: 'Body' }, '/project');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(
        'Issue URL must end with a positive issue number: https://github.com/owner/repo/issues/42/',
      ),
    });
  });
});

describe('closeIssue', () => {
  it('should close a GitHub issue with a compensation comment', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''));

    const result = closeIssue(938, 'Compensation comment', '/project');

    expect(result).toEqual({ success: true, commentCreated: true });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'close', '938', '--comment', 'Compensation comment'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('should return an error when gh CLI is unavailable', () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not authenticated'); })
      .mockReturnValueOnce(Buffer.from('gh version 2.0.0'));

    const result = closeIssue(938, 'Compensation comment', '/project');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('should return an error when gh issue close fails', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockImplementationOnce(() => { throw new Error('close failed'); });

    const result = closeIssue(938, 'Compensation comment', '/project');

    expect(result.success).toBe(false);
    expect(result.error).toContain('close failed');
  });

  it('should pass cwd to all gh commands', () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''));

    closeIssue(938, 'Compensation comment', '/worktree/clone');

    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ cwd: '/worktree/clone' }));
    }
  });
});
