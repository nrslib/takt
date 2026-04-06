/**
 * Tests for relayPushCloneToOrigin in infra/task/git.ts
 *
 * Verifies the safe relay push strategy:
 *   1. root repo fetches clone HEAD → refs/takt-relay/<branch>
 *   2. root repo pushes temp ref → origin refs/heads/<branch>
 *   3. temp ref is always cleaned up (finally)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
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

import { relayPushCloneToOrigin } from '../infra/task/git.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('relayPushCloneToOrigin', () => {
  it('fetches clone HEAD into temp ref then pushes to origin', () => {
    // Given: all git commands succeed
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch');

    // Then: fetch is called first with correct args
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', '/tmp/clone', 'HEAD:refs/takt-relay/feat/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );

    // Then: push uses the temp ref as source, targets origin branch
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'refs/takt-relay/feat/my-branch:refs/heads/feat/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('cleans up temp ref after successful push', () => {
    // Given: all git commands succeed
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch');

    // Then: temp ref is deleted after push
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', 'refs/takt-relay/feat/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('cleans up temp ref even when push to origin fails', () => {
    // Given: fetch succeeds but push fails
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('push')) {
        throw new Error('remote: Permission to org/repo.git denied to user');
      }
      return Buffer.from('');
    });

    // When: push error is surfaced
    expect(() =>
      relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch'),
    ).toThrow('remote: Permission to org/repo.git denied to user');

    // Then: cleanup is still called despite the push failure
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', 'refs/takt-relay/feat/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('cleans up temp ref even when fetch fails', () => {
    // Given: fetch itself throws
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('fetch')) {
        throw new Error('fatal: not a git repository');
      }
      return Buffer.from('');
    });

    // When
    expect(() =>
      relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch'),
    ).toThrow('fatal: not a git repository');

    // Then: cleanup still runs (update-ref -d)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', 'refs/takt-relay/feat/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });

  it('does not throw when temp ref cleanup fails (non-fatal)', () => {
    // Given: fetch and push succeed, but update-ref -d throws
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('-d')) {
        throw new Error('error: cannot lock ref');
      }
      return Buffer.from('');
    });

    // When: cleanup failure is swallowed
    expect(() =>
      relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch'),
    ).not.toThrow();
  });

  it('uses root cwd (projectDir) for all git commands, not clone cwd', () => {
    // Given
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch');

    // Then: every call uses rootCwd as cwd
    for (const call of mockExecFileSync.mock.calls) {
      const opts = call[2] as { cwd?: string };
      expect(opts.cwd).toBe('/project');
    }
  });

  it('handles branch names with slashes correctly in temp ref', () => {
    // Given
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feature/auth/fix-timeout');

    // Then: temp ref contains the full branch name including slashes
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', '/tmp/clone', 'HEAD:refs/takt-relay/feature/auth/fix-timeout'],
      expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'refs/takt-relay/feature/auth/fix-timeout:refs/heads/feature/auth/fix-timeout'],
      expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', 'refs/takt-relay/feature/auth/fix-timeout'],
      expect.anything(),
    );
  });

  it('does not use git push <projectDir> HEAD (the unsafe pattern)', () => {
    // Given
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch');

    // Then: the old unsafe pattern is never used
    const hasUnsafePush = mockExecFileSync.mock.calls.some(call => {
      const args = call[1] as string[];
      return args.includes('push') && args.includes('/project') && args.includes('HEAD');
    });
    expect(hasUnsafePush).toBe(false);
  });

  it('call order is: fetch → push → cleanup', () => {
    // Given
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // When
    relayPushCloneToOrigin('/tmp/clone', '/project', 'feat/my-branch');

    const calls = mockExecFileSync.mock.calls;
    const fetchIdx = calls.findIndex(c => (c[1] as string[]).includes('fetch'));
    const pushIdx = calls.findIndex(c => (c[1] as string[]).includes('push'));
    const cleanupIdx = calls.findIndex(c => (c[1] as string[]).includes('-d'));

    // Then: sequential order is maintained
    expect(fetchIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(cleanupIdx);
  });
});
