import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelectOption, mockExecFileSync } = vi.hoisted(() => ({
  mockSelectOption: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  localBranchExists: vi.fn(() => true),
  materializeCloneHeadToRootBranch: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: (...args: unknown[]) => mockSelectOption(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { showDiffAndPromptActionForTask } from '../features/tasks/list/taskDiffActions.js';

const task = {
  kind: 'completed' as const,
  name: 'task',
  createdAt: '2026-08-15T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'Implement task',
  branch: 'takt/task',
  worktreePath: '/project/.takt/worktrees/task',
};

describe('showDiffAndPromptActionForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue('diff --stat\n');
    mockSelectOption.mockResolvedValue(null);
  });

  it('completed task menu includes PR creation', async () => {
    await showDiffAndPromptActionForTask('/project', task);

    const options = mockSelectOption.mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toContain('create_pr');
  });

  it('PR creation can be excluded for other branch menus', async () => {
    await showDiffAndPromptActionForTask('/project', task, false);

    const options = mockSelectOption.mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options.map((option) => option.value)).not.toContain('create_pr');
  });
});
