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
    if (gitArgs[0] === 'diff' && gitArgs.includes('--cached')) {
      return ' src/staged.ts | 1 +\n';
    }
    if (gitArgs[0] === 'diff' && gitArgs.includes('main...takt/fix')) {
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
});
