import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecFileSync,
  mockSpawnSync,
  mockSuccess,
  mockInfo,
  mockError,
  mockWarn,
  mockLogError,
  mockExistsSync,
  mockEnsureRootBranchReady,
  mockLstatSync,
  mockRmSync,
  mockUnlinkSync,
  mockCleanupOrphanedClone,
  mockWorktreePath,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockExistsSync: vi.fn(),
  mockEnsureRootBranchReady: vi.fn(),
  mockLstatSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockCleanupOrphanedClone: vi.fn(),
  mockWorktreePath: vi.fn(),
}));

vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  lstatSync: mockLstatSync,
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawnSync: mockSpawnSync,
}));

vi.mock('../shared/ui/index.js', () => ({
  success: mockSuccess,
  info: mockInfo,
  error: mockError,
  warn: mockWarn,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

vi.mock('../features/tasks/list/taskActionTarget.js', () => ({
  ensureRootBranchReady: (...args: unknown[]) => mockEnsureRootBranchReady(...args),
  resolveTargetBranch: () => 'takt/test-branch',
  resolveTargetWorktreePath: mockWorktreePath,
}));

vi.mock('../infra/task/index.js', () => ({
  cleanupOrphanedClone: mockCleanupOrphanedClone,
}));

import { deleteBranch, tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';

const target = { kind: 'failed' as const, name: 'task', content: 'task',
  createdAt: '2026-01-01T00:00:00Z', filePath: '/project/.takt/tasks.yaml', branch: 'takt/test-branch' };
const resume = { quiet: true, resume: true };

function mockRootRefs(refs: string): void {
  mockExecFileSync.mockImplementation((_command, args: string[]) => {
    switch (args[0]) {
      case 'branch':
        return '';
      case 'for-each-ref':
        return refs;
      default:
        throw new Error(`Unexpected Git command: ${args.join(' ')}`);
    }
  });
}

describe('taskBranchLifecycleActions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnsureRootBranchReady.mockReturnValue(true);
    mockWorktreePath.mockReturnValue('/tmp/worktree');
    mockExistsSync.mockReturnValue(true);
    mockLstatSync.mockReturnValue({});
    mockRootRefs('');
  });

  it.each([undefined, false, true])('cleans remaining metadata and sessions without a clone (resume: %s)', (resume) => {
    mockExistsSync.mockImplementation((path: string) => path !== '/tmp/worktree');
    mockLstatSync.mockImplementation((path: string) => {
      if (path === '/tmp/worktree') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {};
    });
    mockRootRefs('refs/heads/takt/test-branch\n');

    expect(deleteBranch('/project', target, { resume })).toBe(true);

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-d', 'takt/test-branch'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    expect(mockCleanupOrphanedClone.mock.invocationCallOrder[0]).toBeLessThan(mockExecFileSync.mock.invocationCallOrder[0]!);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, false], [undefined, true], [false, false], [false, true], [true, false], [true, true],
  ] as const)('deletes an existing root branch when clone and metadata are absent (resume: %s, branch exists: %s)', (resume, branchExists) => {
    mockExistsSync.mockReturnValue(false);
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    mockRootRefs(branchExists ? 'refs/heads/takt/test-branch\n' : '');

    expect(deleteBranch('/project', target, { resume })).toBe(true);

    expect(mockExecFileSync.mock.calls).toEqual([
      ['git', ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
      ...(branchExists ? [['git', ['branch', '-d', 'takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }]] : []),
    ]);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalled();
  });

  it.each([undefined, false, true])('safely deletes the root branch after clone cleanup (resume: %s)', (resume) => {
    mockRootRefs('refs/heads/takt/test-branch\n');

    expect(deleteBranch('/project', target, { resume })).toBe(true);

    expect(mockRmSync).toHaveBeenCalledWith('/tmp/worktree', { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('worktree-sessions'));
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
    expect(mockExecFileSync.mock.calls).toEqual([
      ['git', ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
      ['git', ['branch', '-d', 'takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    expect(mockRmSync.mock.invocationCallOrder[0]).toBeLessThan(mockUnlinkSync.mock.invocationCallOrder[0]!);
    expect(mockUnlinkSync.mock.invocationCallOrder[0]).toBeLessThan(mockCleanupOrphanedClone.mock.invocationCallOrder[0]!);
    expect(mockCleanupOrphanedClone.mock.invocationCallOrder[0]).toBeLessThan(mockExecFileSync.mock.invocationCallOrder[0]!);
    expect(mockSuccess).toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it.each([
    'refs/heads/takt/test-branch',
    'refs/heads/takt/other\nrefs/heads/takt/test-branch\n',
    'refs/heads/takt/test-branch/child\nrefs/heads/takt/test-branch',
  ])('deletes a root branch only when an exact ref line is present in %j', (refs) => {
    mockRootRefs(refs);

    expect(deleteBranch('/project', target)).toBe(true);

    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-d', 'takt/test-branch'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
  });

  it.each(['', 'refs/heads/takt/test-branch/child\n', 'refs/heads/takt/other\n'])(
    'succeeds without deleting a root branch when no exact ref is present in %j', (refs) => {
      mockRootRefs(refs);

      expect(deleteBranch('/project', target)).toBe(true);

      expect(mockExecFileSync).toHaveBeenCalledWith('git',
        ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' });
      expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([]);
      expect(mockWarn).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false, true])('completes clone cleanup when safe root branch deletion is rejected (quiet: %s)', (quiet) => {
    const rejection = new Error('branch is not fully merged');
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'for-each-ref') return 'refs/heads/takt/test-branch\n';
      if (args[0] === 'branch' && args[1] === '-d') throw rejection;
      return '';
    });

    expect(deleteBranch('/project', target, { quiet })).toBe(true);

    expect(mockRmSync).toHaveBeenCalledWith('/tmp/worktree', { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('worktree-sessions'));
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-d', 'takt/test-branch'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    if (quiet === true) expect(mockWarn).not.toHaveBeenCalled();
    else expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('takt/test-branch'));
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
      branch: 'takt/test-branch', error: rejection.message,
    });
    expect(mockError).not.toHaveBeenCalled();
  });

  it('suppresses success output for quiet clone branch deletion', () => {
    mockRootRefs('refs/heads/takt/test-branch\n');

    expect(deleteBranch('/project', target, { quiet: true })).toBe(true);

    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['branch', '-d', 'takt/test-branch'],
      { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' });
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('does not treat a clone root branch inspection failure as successful deletion', () => {
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'for-each-ref') throw new Error('git read failed');
      return '';
    });

    expect(deleteBranch('/project', target)).toBe(false);

    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([]);
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('git read failed'));
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('keeps clone cleanup incomplete when required orphan cleanup fails', () => {
    mockRootRefs('refs/heads/takt/test-branch\n');
    mockCleanupOrphanedClone.mockImplementation(() => { throw new Error('clone cleanup failed'); });

    expect(deleteBranch('/project', target, { requireCleanupSuccess: true })).toBe(false);

    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch', { throwOnError: true });
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch' || args[0] === 'for-each-ref')).toEqual([]);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('force deletes the root branch for a pending worktree task without a recorded path', () => {
    const pendingTask = {
      ...target,
      kind: 'pending' as const,
      data: { task: 'task', worktree: true, branch: 'takt/test-branch' },
    };
    mockWorktreePath.mockReturnValue(undefined);
    mockRootRefs('refs/heads/takt/test-branch\n');

    expect(deleteBranch('/project', pendingTask)).toBe(true);

    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-D', 'takt/test-branch'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
  });

  it.each([false, true])('resumes only remaining branch and orphan clone cleanup (branch exists: %s)', (branchExists) => {
    mockWorktreePath.mockReturnValue(undefined);
    mockLstatSync.mockReturnValue({});
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'for-each-ref') return branchExists ? 'refs/heads/takt/test-branch\n' : '';
      if (!branchExists) throw new Error('branch already deleted');
      return '';
    });

    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(branchExists ? 1 : 0);
    if (branchExists) {
      expect(mockExecFileSync).toHaveBeenCalledWith('git', ['branch', '-D', 'takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' });
    }
    expect(mockCleanupOrphanedClone).toHaveBeenCalledOnce();
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
  });

  it('does not mistake a branch inspection failure for completed cleanup', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation(() => { throw new Error('git read failed'); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it('retains a cleanup failure after the branch has disappeared until orphan cleanup succeeds', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockReturnValue({});
    mockCleanupOrphanedClone.mockImplementationOnce(() => { throw new Error('clone cleanup failed'); });

    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(0);
    expect(mockCleanupOrphanedClone).toHaveBeenCalledTimes(2);
  });

  it('skips completed branch and orphan cleanup when neither resource remains', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    expect(deleteBranch('/project', target, resume)).toBe(true);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toHaveLength(0);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it('does not treat failed orphan resource inspection as completed cleanup', () => {
    mockWorktreePath.mockReturnValue(undefined);
    mockExecFileSync.mockReturnValue('');
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, false], [false, false, true], [false, true, false], [false, true, true],
    [true, false, false], [true, false, true], [true, true, false], [true, true, true],
  ])('resumes only remaining clone resources (directory: %s, session: %s, metadata: %s)', (directory, session, metadata) => {
    mockLstatSync.mockImplementation((path: string) => {
      const exists = path === '/tmp/worktree' ? directory : path.includes('worktree-sessions') ? session : metadata;
      if (exists) return {};
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    });

    expect(deleteBranch('/project', target, resume)).toBe(true);

    expect(mockRmSync).toHaveBeenCalledTimes(directory ? 1 : 0);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(session ? 1 : 0);
    expect(mockCleanupOrphanedClone).toHaveBeenCalledTimes(metadata ? 1 : 0);
    if (metadata) expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch');
    expect(mockExecFileSync.mock.calls).toEqual([
      ['git', ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
  });

  it('keeps worktree recovery incomplete when existence inspection fails', () => {
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    expect(deleteBranch('/project', target, resume)).toBe(false);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('surfaces git stderr when try-merge fails', () => {
    const err = new Error('Command failed: git merge --squash takt/test-branch');
    Object.assign(err, {
      stderr: Buffer.from('error: Merging is not possible because you have unmerged files.\n'),
    });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    const result = tryMergeBranch('/project', {
      kind: 'completed',
      name: 'task',
      createdAt: '2026-01-01T00:00:00Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'task',
      branch: 'takt/test-branch',
    });

    expect(result).toBe(false);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('error: Merging is not possible because you have unmerged files.'),
    );
  });
});
