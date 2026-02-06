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

import { createIssue, checkGhCli } from '../infra/github/issue.js';

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
    const result = createIssue({ title: 'Test issue', body: 'Test body' });

    // Then
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://github.com/owner/repo/issues/42');
  });

  it('should pass title and body as arguments', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'My Title', body: 'My Body' });

    // Then: verify the second call (issue create) has correct args
    const issueCreateCall = mockExecFileSync.mock.calls[1];
    expect(issueCreateCall?.[0]).toBe('gh');
    expect(issueCreateCall?.[1]).toEqual([
      'issue', 'create', '--title', 'My Title', '--body', 'My Body',
    ]);
  });

  it('should include labels when provided', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Bug', body: 'Fix it', labels: ['bug', 'priority:high'] });

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[1];
    expect(issueCreateCall?.[1]).toEqual([
      'issue', 'create', '--title', 'Bug', '--body', 'Fix it',
      '--label', 'bug,priority:high',
    ]);
  });

  it('should not include --label when labels is empty', () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockReturnValueOnce('https://github.com/owner/repo/issues/1\n' as unknown as Buffer);

    // When
    createIssue({ title: 'Title', body: 'Body', labels: [] });

    // Then
    const issueCreateCall = mockExecFileSync.mock.calls[1];
    expect(issueCreateCall?.[1]).not.toContain('--label');
  });

  it('should return error when gh CLI is not authenticated', () => {
    // Given: auth fails, version succeeds
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not authenticated'); })
      .mockReturnValueOnce(Buffer.from('gh version 2.0.0'));

    // When
    const result = createIssue({ title: 'Test', body: 'Body' });

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
    const result = createIssue({ title: 'Test', body: 'Body' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('not installed');
  });

  it('should return error when gh issue create fails', () => {
    // Given: auth succeeds but issue creation fails
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('')) // gh auth status
      .mockImplementationOnce(() => { throw new Error('repo not found'); });

    // When
    const result = createIssue({ title: 'Test', body: 'Body' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('repo not found');
  });
});
