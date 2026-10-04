import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { collectTaskWorktreeSummary } from '../features/tasks/list/taskWorktreeSummary.js';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockImplementation((_command, args) => {
    const gitArgs = args as string[];
    if (gitArgs[0] === 'status') {
      return ' M src/work.ts\nA  src/staged.ts\n?? evidence.md\n';
    }
    if (gitArgs[0] === 'show-ref') {
      return 'refs/heads/verified\n';
    }
    if (gitArgs[0] === 'diff' && gitArgs.includes('--cached')) {
      return ' src/staged.ts | 1 +\n';
    }
    if (gitArgs[0] === 'diff' && gitArgs.includes('refs/heads/main...refs/heads/takt/fix')) {
      return ' src/committed.ts | 2 +-\n';
    }
    if (gitArgs[0] === 'diff') {
      return ' src/work.ts | 1 +\n';
    }
    return '';
  });
});

describe('task worktree summary', () => {
  it('committed、staged、unstaged、untracked の概要と commit 対象一覧を収集する', () => {
    const result = collectTaskWorktreeSummary('/worktree', 'main', 'takt/fix');

    expect(result.files).toEqual(expect.arrayContaining(['src/staged.ts', 'src/work.ts', 'evidence.md']));
    expect(result.files).toHaveLength(3);
    expect(result.text).toContain('src/committed.ts');
    expect(result.text).toContain('src/staged.ts');
    expect(result.text).toContain('src/work.ts');
    expect(result.text).toContain('evidence.md');
  });

  it('preview用の収集中に add、commit、fetch、push を実行しない', () => {
    collectTaskWorktreeSummary('/worktree', 'main', 'takt/fix');

    const commands = mockExecFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(commands.every((args) => !['add', 'commit', 'fetch', 'push'].includes(args[0]!))).toBe(true);
  });

  it('base ref が無い場合は committed diff だけを省略し、作業ツリーの概要を維持する', () => {
    mockExecFileSync.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'status') {
        return ' M src/work.ts\nA  src/staged.ts\n?? evidence.md\n';
      }
      if (gitArgs[0] === 'show-ref') {
        const error = new Error('missing base ref') as Error & { status: number };
        error.status = 1;
        throw error;
      }
      if (gitArgs[0] === 'diff' && gitArgs.includes('--cached')) {
        return ' src/staged.ts | 1 +\n';
      }
      if (gitArgs[0] === 'diff') {
        return ' src/work.ts | 1 +\n';
      }
      return '';
    });

    const result = collectTaskWorktreeSummary('/worktree', 'missing-base', 'takt/fix');

    expect(result.text).toContain('src/staged.ts');
    expect(result.text).toContain('src/work.ts');
    expect(result.text).toContain('evidence.md');
    expect(result.files).toEqual(expect.arrayContaining(['src/staged.ts', 'src/work.ts', 'evidence.md']));
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/heads/missing-base'],
      expect.objectContaining({ cwd: '/worktree' }),
    );
  });

  it('refspec や Git option を branch ref として受け付けない', () => {
    expect(() => collectTaskWorktreeSummary('/worktree', 'main', '--output=/tmp/summary')).toThrow();
  });

  it('ref検証自体のGit失敗は committed diff の省略として握りつぶさない', () => {
    mockExecFileSync.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'status') {
        return '';
      }
      if (gitArgs[0] === 'show-ref') {
        const error = new Error('git repository unavailable') as Error & { status: number };
        error.status = 128;
        throw error;
      }
      return '';
    });

    expect(() => collectTaskWorktreeSummary('/worktree', 'main', 'takt/fix'))
      .toThrow('git repository unavailable');
  });
});
