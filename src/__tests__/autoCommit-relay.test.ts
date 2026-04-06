/**
 * Tests for autoCommitAndPush with branch parameter (relay push behavior)
 *
 * Verifies that:
 * - When branch is provided, relay push (relayPushCloneToOrigin) is used
 * - When branch is omitted, old behavior (git push <projectDir> HEAD) is used
 * - Relay push failure sets localPushFailed: true without losing commitHash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockResolveConfigValue = vi.fn(() => undefined);
vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

const mockRelayPushCloneToOrigin = vi.fn();
vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  relayPushCloneToOrigin: (...args: unknown[]) => mockRelayPushCloneToOrigin(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { autoCommitAndPush } from '../infra/task/autoCommit.js';

function setupSuccessfulCommit(): void {
  mockExecFileSync.mockImplementation((_cmd, args) => {
    const argsArr = args as string[];
    if (argsArr.includes('status')) return 'M src/index.ts\n';
    if (argsArr.includes('rev-parse')) return 'abc1234\n';
    if (argsArr.includes('config')) return '';
    return Buffer.from('');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConfigValue.mockReturnValue(undefined);
  mockRelayPushCloneToOrigin.mockReturnValue(undefined);
});

describe('autoCommitAndPush — branch parameter', () => {
  it('uses relayPushCloneToOrigin when branch is provided', () => {
    // Given: changes exist
    setupSuccessfulCommit();

    // When: called with a branch
    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: relay push is used
    expect(mockRelayPushCloneToOrigin).toHaveBeenCalledWith(
      '/tmp/clone',
      '/project',
      'feat/my-branch',
    );
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.localPushFailed).toBeUndefined();
  });

  it('does not call git push <projectDir> HEAD when branch is provided', () => {
    // Given
    setupSuccessfulCommit();

    // When
    autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: the old unsafe push pattern is NOT used
    const hasDirectPush = mockExecFileSync.mock.calls.some(call => {
      const args = call[1] as string[];
      return args.includes('push') && args.includes('/project') && args.includes('HEAD');
    });
    expect(hasDirectPush).toBe(false);
  });

  it('falls back to git push <projectDir> HEAD when branch is not provided', () => {
    // Given
    setupSuccessfulCommit();

    // When: called without branch (backward-compat path)
    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    // Then: relay is NOT used
    expect(mockRelayPushCloneToOrigin).not.toHaveBeenCalled();

    // Then: old direct push is used
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', '/project', 'HEAD'],
      expect.objectContaining({ cwd: '/tmp/clone' }),
    );
    expect(result.success).toBe(true);
  });

  it('returns localPushFailed: true when relay push fails after commit creation', () => {
    // Given: commit succeeds but relay throws
    setupSuccessfulCommit();
    mockRelayPushCloneToOrigin.mockImplementation(() => {
      throw new Error('remote: refusing to update checked out branch');
    });

    // When
    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: commit is preserved, but push failure is reported
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.localPushFailed).toBe(true);
    expect(result.message).toContain('abc1234');
    expect(result.message).not.toContain('Auto-commit failed');
  });

  it('returns success: false when commit itself fails (with or without branch)', () => {
    // Given: git add throws
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    // When
    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: failure is reported, relay is never attempted
    expect(result.success).toBe(false);
    expect(mockRelayPushCloneToOrigin).not.toHaveBeenCalled();
  });

  it('skips relay push when there are no changes to commit', () => {
    // Given: no staged changes
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('status')) return '';
      if (argsArr.includes('config')) return '';
      return Buffer.from('');
    });

    // When
    const result = autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: no push attempted
    expect(mockRelayPushCloneToOrigin).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
  });
});
