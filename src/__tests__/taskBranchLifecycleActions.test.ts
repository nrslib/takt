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
  mockReadFileSync,
  mockRealpathSync,
  mockAssertReusableWorktreePath,
  mockRmSync,
  mockUnlinkSync,
  mockCleanupOrphanedClone,
  mockWorktreePath,
  mockTargetBranch,
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
  mockReadFileSync: vi.fn(),
  mockRealpathSync: vi.fn(),
  mockAssertReusableWorktreePath: vi.fn(),
  mockRmSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockCleanupOrphanedClone: vi.fn(),
  mockWorktreePath: vi.fn(),
  mockTargetBranch: vi.fn(),
}));

vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  lstatSync: mockLstatSync,
  readFileSync: mockReadFileSync,
  realpathSync: mockRealpathSync,
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
  resolveTargetBranch: mockTargetBranch,
  resolveTargetWorktreePath: mockWorktreePath,
}));

vi.mock('../infra/task/index.js', () => ({
  cleanupOrphanedClone: mockCleanupOrphanedClone,
  resolveCloneBaseDir: () => '/tmp',
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: mockAssertReusableWorktreePath,
}));

import { deleteBranch, tryMergeBranch } from '../features/tasks/list/taskBranchLifecycleActions.js';

const target = { kind: 'failed' as const, name: 'task', content: 'task',
  createdAt: '2026-01-01T00:00:00Z', filePath: '/project/.takt/tasks.yaml', branch: 'takt/test-branch' };
const resume = { quiet: true, resume: true };
const taskRecordQueries = [
  ['git', ['ls-files', '--cached', '--', '.takt/tasks.yaml'],
    { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
  ['git', ['ls-tree', '--name-only', 'HEAD', '--', '.takt/tasks.yaml'],
    { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
];
const metaQueries = taskRecordQueries.map(([command, args, options]) => [
  command, (args as string[]).map((arg) => arg === '.takt/tasks.yaml' ? '.takt/clone-meta/takt--test-branch.json' : arg), options,
]);

function mockRootRefs(refs: string): void {
  mockExecFileSync.mockImplementation((_command, args: string[]) => {
    switch (args[0]) {
      case 'ls-files':
      case 'ls-tree':
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
    mockTargetBranch.mockReturnValue('takt/test-branch');
    mockExistsSync.mockReturnValue(true);
    mockLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false, isFile: () => true });
    mockRealpathSync.mockImplementation((path: string) => path);
    mockReadFileSync.mockImplementation(() => JSON.stringify({ branch: mockTargetBranch(), clonePath: mockWorktreePath() }));
    mockRootRefs('');
  });

  it('cleans the verified recorded clone path and deletes the recorded root branch', () => {
    mockTargetBranch.mockReturnValue('feature/unrelated');
    const clonePath = '/tmp/clone-a';
    mockWorktreePath.mockReturnValue(clonePath);
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'ls-files' || args[0] === 'ls-tree') return '';
      return 'refs/heads/feature/unrelated\n';
    });

    expect(deleteBranch('/project', target)).toBe(true);

    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-d', 'feature/unrelated'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    expect(mockRmSync).toHaveBeenCalledWith(clonePath, expect.any(Object));
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'feature/unrelated', { worktreeBaseDirectory: '/tmp' });
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it.each(['ls-files', 'ls-tree'])('preserves all resources when task records are tracked by %s', (query) => {
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === query) return '.takt/tasks.yaml\n';
      if (args[0] === 'for-each-ref') return 'refs/heads/takt/test-branch\n';
      return '';
    });

    expect(deleteBranch('/project', target)).toBe(false);

    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'ls-files' || args[0] === 'ls-tree'))
      .toEqual(query === 'ls-files' ? taskRecordQueries.slice(0, 1) : taskRecordQueries);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch' || args[0] === 'for-each-ref')).toEqual([]);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('takt/test-branch'));
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: expect.any(String) }));
    expect(mockError).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['ls-files', undefined], ['ls-files', false], ['ls-files', true],
    ['ls-tree', undefined], ['ls-tree', false], ['ls-tree', true],
  ] as const)('preserves all resources when task provenance query %s fails (quiet: %s)', (query, quiet) => {
    const failure = new Error(`${query} failed`);
    mockExecFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === query) throw failure;
      if (args[0] === 'for-each-ref') return 'refs/heads/takt/test-branch\n';
      return '';
    });

    expect(deleteBranch('/project', target, { quiet })).toBe(false);

    expect(mockExecFileSync).toHaveBeenCalledWith(...taskRecordQueries[query === 'ls-files' ? 0 : 1]!);
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch' || args[0] === 'for-each-ref')).toEqual([]);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
    if (quiet === true) expect(mockWarn).not.toHaveBeenCalled();
    else expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('takt/test-branch'));
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: failure.message }));
    expect(mockError).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it.each(['missing', 'file', 'symlink', 'inspection failure'])(
    'preserves all resources when .git is %s', (kind) => {
      mockRootRefs('refs/heads/takt/test-branch\n');
      const stat = mockLstatSync();
      mockLstatSync.mockImplementation((path: string) => {
        if (path !== '/tmp/worktree/.git') return stat;
        if (kind === 'missing' || kind === 'inspection failure') {
          throw Object.assign(new Error(kind), { code: kind === 'missing' ? 'ENOENT' : 'EACCES' });
        }
        return { isDirectory: () => false, isSymbolicLink: () => kind === 'symlink' };
      });

      expect(deleteBranch('/project', target)).toBe(false);

      expect(mockExecFileSync.mock.calls).toEqual([
        ...taskRecordQueries,
        ...metaQueries,
      ]);
      expect(mockRmSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('takt/test-branch'));
      expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: expect.any(String) }));
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'symlink', 'directory', 'read failure', 'invalid JSON', 'null', 'missing path', 'invalid path', 'wrong path', 'wrong branch'])(
    'preserves all resources when clone metadata has %s', (condition) => {
      const stat = mockLstatSync();
      mockLstatSync.mockImplementation((path: string) => {
        if (!path.includes('clone-meta')) return stat;
        if (condition === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isSymbolicLink: () => condition === 'symlink', isFile: () => condition !== 'directory' };
      });
      mockReadFileSync.mockImplementation(() => {
        if (condition === 'read failure') throw Object.assign(new Error('read denied'), { code: 'EACCES' });
        if (condition === 'invalid JSON') return '{';
        if (condition === 'null') return 'null';
        return JSON.stringify({
          branch: condition === 'wrong branch' ? 'other' : 'takt/test-branch',
          clonePath: condition === 'missing path' ? undefined : condition === 'invalid path' ? 123
            : condition === 'wrong path' ? '/tmp/other-clone' : '/tmp/worktree',
        });
      });

      expect(deleteBranch('/project', target)).toBe(false);

      expect(mockRmSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
      expect(mockExecFileSync.mock.calls.filter(([, args]) => ['branch', 'for-each-ref'].includes(args[0]))).toEqual([]);
      expect(mockWarn).toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: expect.any(String) }));
      expect(mockSuccess).not.toHaveBeenCalled();
    },
  );

  it.each(['ls-files', 'ls-tree'])('preserves all resources when metadata is tracked by %s or its query fails', (query) => {
    for (const fails of [false, true]) {
      mockExecFileSync.mockImplementation((_command, args: string[]) => {
        if (args[0] === query && args.at(-1)?.includes('clone-meta')) {
          if (fails) throw new Error('metadata provenance query failed');
          return '.takt/clone-meta/takt--test-branch.json\n';
        }
        return '';
      });

      expect(deleteBranch('/project', target)).toBe(false);
      expect(mockRmSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
      expect(mockSuccess).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalled();
    }
  });

  it.each(['/outside/clone', '/tmp'])('preserves a clone outside the allowed descendants: %s', (path) => {
    mockWorktreePath.mockReturnValue(path);

    expect(deleteBranch('/project', target)).toBe(false);

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'not a directory', 'unsafe ancestor'])('preserves a clone rejected by the existing path boundary: %s', (reason) => {
    mockAssertReusableWorktreePath.mockImplementation(() => { throw new Error(reason); });

    expect(deleteBranch('/project', target)).toBe(false);

    expect(mockAssertReusableWorktreePath).toHaveBeenCalledWith('/project', '/tmp/worktree');
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason }));
  });

  it.each([undefined, false, true])('cleans remaining metadata and sessions without a clone (resume: %s)', (resume) => {
    const stat = mockLstatSync();
    mockLstatSync.mockImplementation((path: string) => {
      if (path === '/tmp/worktree') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return stat;
    });
    mockRootRefs('refs/heads/takt/test-branch\n');

    expect(deleteBranch('/project', target, { resume })).toBe(true);

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch', { worktreeBaseDirectory: '/tmp' });
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch')).toEqual([
      ['git', ['branch', '-d', 'takt/test-branch'], { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    expect(mockCleanupOrphanedClone.mock.invocationCallOrder[0]).toBeLessThan(mockExecFileSync.mock.invocationCallOrder[4]!);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not redirect cleanup from a missing clone to another clone in metadata', () => {
    const stat = mockLstatSync();
    mockLstatSync.mockImplementation((path: string) => {
      if (path === '/tmp/worktree') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return stat;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ branch: 'takt/test-branch', clonePath: '/tmp/other-clone' }));

    expect(deleteBranch('/project', target)).toBe(false);

    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, false], [undefined, true], [false, false], [false, true], [true, false], [true, true],
  ] as const)('deletes an existing root branch when clone and metadata are absent (resume: %s, branch exists: %s)', (resume, branchExists) => {
    mockExistsSync.mockReturnValue(false);
    mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    mockRootRefs(branchExists ? 'refs/heads/takt/test-branch\n' : '');

    expect(deleteBranch('/project', target, { resume })).toBe(true);

    expect(mockExecFileSync.mock.calls).toEqual([
      ...taskRecordQueries,
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

    expect(mockRmSync).toHaveBeenCalledWith('/tmp/worktree', expect.objectContaining({ recursive: true, force: true }));
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('worktree-sessions'));
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch', { worktreeBaseDirectory: '/tmp' });
    expect(mockExecFileSync.mock.calls).toEqual([
      ...taskRecordQueries,
      ...metaQueries,
      ['git', ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
      ['git', ['branch', '-d', 'takt/test-branch'],
        { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
    ]);
    expect(mockExecFileSync.mock.invocationCallOrder[3]).toBeLessThan(mockRmSync.mock.invocationCallOrder[0]!);
    expect(mockRmSync.mock.invocationCallOrder[0]).toBeLessThan(mockUnlinkSync.mock.invocationCallOrder[0]!);
    expect(mockUnlinkSync.mock.invocationCallOrder[0]).toBeLessThan(mockCleanupOrphanedClone.mock.invocationCallOrder[0]!);
    expect(mockCleanupOrphanedClone.mock.invocationCallOrder[0]).toBeLessThan(mockExecFileSync.mock.invocationCallOrder[4]!);
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

    expect(mockRmSync).toHaveBeenCalledWith('/tmp/worktree', expect.objectContaining({ recursive: true, force: true }));
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('worktree-sessions'));
    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch', { worktreeBaseDirectory: '/tmp' });
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

  it.each([undefined, false, true])('preserves the branch for an enabled worktree without a path (quiet: %s)', (quiet) => {
    mockWorktreePath.mockReturnValue(undefined);

    expect(deleteBranch('/project', { ...target, data: { task: 'task', worktree: true } }, { quiet })).toBe(true);

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedClone).not.toHaveBeenCalled();
    if (quiet === true) expect(mockWarn).not.toHaveBeenCalled();
    else expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('takt/test-branch'));
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      branch: 'takt/test-branch', reason: expect.any(String),
    }));
    expect(mockError).not.toHaveBeenCalled();
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

    expect(mockCleanupOrphanedClone).toHaveBeenCalledWith('/project', 'takt/test-branch', { worktreeBaseDirectory: '/tmp', throwOnError: true });
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockExecFileSync.mock.calls.filter(([, args]) => args[0] === 'branch' || args[0] === 'for-each-ref')).toEqual([]);
    expect(mockSuccess).not.toHaveBeenCalled();
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

  it.each([[false, false], [false, true], [true, false]])(
    'resumes only remaining worktree and session cleanup (directory: %s, session: %s)', (directory, session) => {
      const stat = mockLstatSync();
      mockLstatSync.mockImplementation((path: string) => {
        if (path === '/tmp/worktree' || path === '/tmp/worktree/.git') {
          if (directory) return stat;
        } else if (path.includes('worktree-sessions') ? session : directory) return stat;
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      });
      expect(deleteBranch('/project', target, resume)).toBe(true);
      expect(mockRmSync).toHaveBeenCalledTimes(directory ? 1 : 0);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(session ? 1 : 0);
      expect(mockExecFileSync.mock.calls).toEqual([
        ...taskRecordQueries,
        ...(directory ? metaQueries : []),
        ['git', ['for-each-ref', '--format=%(refname)', 'refs/heads/takt/test-branch'],
          { cwd: '/project', encoding: 'utf-8', stdio: 'pipe' }],
      ]);
      expect(mockCleanupOrphanedClone).toHaveBeenCalledTimes(directory ? 1 : 0);
    },
  );

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
