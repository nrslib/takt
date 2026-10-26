/**
 * Tests for autoCommitAndPush with branch parameter (root branch materialization behavior)
 *
 * Verifies that:
 * - When branch is provided, root branch materialization is used
 * - When branch is omitted, old behavior (git push <projectDir> HEAD) is used
 * - Root branch materialization failure sets localPushFailed: true without losing commitHash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(null, '', '')),
  execFileSync: vi.fn(),
}));

const mockResolveConfigValue = vi.fn<(_projectDir: string, _key: string) => boolean | undefined>(() => undefined);
vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (projectDir: string, key: string) => mockResolveConfigValue(projectDir, key),
}));

const mockMaterializeCloneHeadToRootBranch = vi.fn();
vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeCloneHeadToRootBranch: (...args: unknown[]) => mockMaterializeCloneHeadToRootBranch(...args),
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
    if (argsArr.includes('diff')) return 'M src/index.ts\n';
    if (argsArr.includes('rev-parse')) return 'abc1234\n';
    if (argsArr.includes('symbolic-ref')) return 'feat/my-branch\n';
    if (argsArr.includes('cat-file')) return 'abc1234 missing\n';
    if (argsArr.includes('config')) return '';
    return '';
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConfigValue.mockReturnValue(undefined);
  mockMaterializeCloneHeadToRootBranch.mockReturnValue(undefined);
});

describe('autoCommitAndPush — branch parameter', () => {
  it.each([
    { objectType: 'missing', targetExists: false, unpublished: true },
    { objectType: 'commit', targetExists: false, unpublished: true },
    { objectType: 'commit', targetExists: true, unpublished: true },
    { objectType: 'commit', targetExists: true, unpublished: false },
    { objectType: 'commit', targetExists: false, unpublished: false },
  ])('publishes only an unpublished clean HEAD: %j', async ({ objectType, targetExists, unpublished }) => {
    const head = 'a'.repeat(40);
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const command = args?.[0];
      if (command === 'rev-parse') return head;
      if (command === 'cat-file') return objectType === 'missing' ? `${head} missing\n` : 'commit\n';
      if (command === 'for-each-ref') return targetExists ? 'refs/heads/feat/my-branch\n' : '';
      if (command === 'rev-list') return unpublished ? head : '';
      return '';
    });

    const result = await autoCommitAndPush('/tmp/clone', 'agent task', '/project', 'feat/my-branch');

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
    expect(result.localPushFailed).toBeUndefined();
    expect(result.publishedHead).toBe(unpublished ? head : undefined);
    expect(mockMaterializeCloneHeadToRootBranch).toHaveBeenCalledTimes(unpublished ? 1 : 0);
  });

  it.each(['rev-parse', 'cat-file', 'for-each-ref', 'rev-list'])('reports publication inspection failure instead of treating it as no changes: %s', async (failedCommand) => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args?.[0] === failedCommand) throw new Error('inspection failed');
      if (args?.[0] === 'rev-parse') return 'a'.repeat(40);
      if (args?.[0] === 'cat-file') return 'commit\n';
      return '';
    });

    const result = await autoCommitAndPush('/tmp/clone', 'agent task', '/project', 'feat/my-branch');

    expect(result.localPushFailed).toBe(true);
    expect(result.publishedHead).toBeUndefined();
    expect(mockMaterializeCloneHeadToRootBranch).not.toHaveBeenCalled();
  });

  it('uses materializeCloneHeadToRootBranch when branch is provided', async () => {
    // Given: changes exist
    setupSuccessfulCommit();

    // When: called with a branch
    const result = await autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: relay push is used
    expect(mockMaterializeCloneHeadToRootBranch).toHaveBeenCalledWith(
      '/tmp/clone',
      '/project',
      'feat/my-branch',
    );
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.publishedHead).toBe('abc1234');
    expect(result.localPushFailed).toBeUndefined();
  });

  it('does not call git push <projectDir> HEAD when branch is provided', async () => {
    // Given
    setupSuccessfulCommit();

    // When
    await autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: the old unsafe push pattern is NOT used
    const hasDirectPush = mockExecFileSync.mock.calls.some(call => {
      const args = call[1] as string[];
      return args.includes('push') && args.includes('/project') && args.includes('HEAD');
    });
    expect(hasDirectPush).toBe(false);
  });

  it('falls back to git push <projectDir> HEAD when branch is not provided', async () => {
    // Given
    setupSuccessfulCommit();

    // When: called without branch (backward-compat path)
    const result = await autoCommitAndPush('/tmp/clone', 'my-task', '/project');

    // Then: relay is NOT used
    expect(mockMaterializeCloneHeadToRootBranch).not.toHaveBeenCalled();

    // Then: old direct push is used
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', '/project', 'HEAD'],
      expect.objectContaining({ cwd: '/tmp/clone' }),
    );
    expect(result.success).toBe(true);
  });

  it('returns localPushFailed: true when root branch materialization fails after commit creation', async () => {
    // Given: commit succeeds but materialization throws
    setupSuccessfulCommit();
    mockMaterializeCloneHeadToRootBranch.mockImplementation(() => {
      throw new Error('remote: refusing to update checked out branch');
    });

    // When
    const result = await autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: commit is preserved, but push failure is reported
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.localPushFailed).toBe(true);
    expect(result.publishedHead).toBeUndefined();
    expect(result.message).toContain('abc1234');
    expect(result.message).not.toContain('Auto-commit failed');
  });

  it('returns success: false when commit itself fails (with or without branch)', async () => {
    // Given: git add throws
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    // When
    const result = await autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: failure is reported, relay is never attempted
    expect(result.success).toBe(false);
    expect(mockMaterializeCloneHeadToRootBranch).not.toHaveBeenCalled();
  });

  it('skips root branch materialization when clean HEAD is already reachable in the base', async () => {
    // Given: no staged changes
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('diff')) return '';
      if (argsArr.includes('rev-parse')) return 'abc1234\n';
      if (argsArr.includes('cat-file')) return 'commit\n';
      if (argsArr.includes('config')) return '';
      return '';
    });

    // When
    const result = await autoCommitAndPush('/tmp/clone', 'my-task', '/project', 'feat/my-branch');

    // Then: no push attempted
    expect(mockMaterializeCloneHeadToRootBranch).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeUndefined();
    expect(result.publishedHead).toBeUndefined();
    expect(result.localPushFailed).toBeUndefined();
  });
});
