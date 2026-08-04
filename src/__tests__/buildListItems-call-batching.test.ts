import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/task/branchGitResolver.js', () => ({
  createBranchBaseResolutionCache: vi.fn(() => ({
    allCandidateRefsByRepositoryKey: new Map<string, string[]>(),
    repositoryKeyByGitCwd: new Map<string, string>(),
  })),
  resolveGitCwd: vi.fn((cwd: string, worktreePath?: string) => worktreePath ?? cwd),
  resolveBranchBaseCommit: vi.fn((_: string, __: string, branch: string) => `base-${branch}`),
  findFirstTaktCommit: vi.fn((_: string, __: string, branch: string) => ({ subject: `takt: instruction-${branch}` })),
}));

import { execFileSync } from 'node:child_process';
import {
  buildListItems,
  type BranchInfo,
} from '../infra/task/branchList.js';
import {
  findFirstTaktCommit,
  resolveBranchBaseCommit,
} from '../infra/task/branchGitResolver.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockResolveBranchBaseCommit = vi.mocked(resolveBranchBaseCommit);
const mockFindFirstTaktCommit = vi.mocked(findFirstTaktCommit);

describe('buildListItems performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'diff') {
        return '1\t0\tfile.ts\n';
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });
  });

  it('should resolve base commit once per branch and reuse it for files/instruction', () => {
    const branches: BranchInfo[] = [
      { branch: 'takt/20260128-task-a', commit: 'abc123' },
      { branch: 'takt/20260128-task-b', commit: 'def456' },
    ];

    const items = buildListItems('/project', branches, 'main');

    expect(items).toHaveLength(2);
    expect(mockResolveBranchBaseCommit).toHaveBeenCalledTimes(2);
    expect(mockFindFirstTaktCommit).toHaveBeenNthCalledWith(
      1,
      '/project',
      'main',
      'takt/20260128-task-a',
      expect.objectContaining({ baseCommit: 'base-takt/20260128-task-a' }),
    );
    expect(mockFindFirstTaktCommit).toHaveBeenNthCalledWith(
      2,
      '/project',
      'main',
      'takt/20260128-task-b',
      expect.objectContaining({ baseCommit: 'base-takt/20260128-task-b' }),
    );
  });
});
