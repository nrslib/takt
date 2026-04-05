import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSuccess,
  mockInfo,
  mockError,
  mockConfirm,
  mockPromptInput,
  mockGetCurrentBranch,
  mockBranchExists,
} = vi.hoisted(() => ({
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockConfirm: vi.fn(),
  mockPromptInput: vi.fn(),
  mockGetCurrentBranch: vi.fn(),
  mockBranchExists: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: (...args: unknown[]) => mockSuccess(...args),
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  promptInput: (...args: unknown[]) => mockPromptInput(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  branchExists: (...args: unknown[]) => mockBranchExists(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

import { displayTaskCreationResult, promptWorktreeSettings } from '../features/tasks/add/worktree-settings.js';

describe('worktree-settings terminal sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sanitizes dynamic values in task creation output', () => {
    displayTaskCreationResult(
      {
        taskName: 'bad\x1b[31m-task\n',
        tasksFile: '/tmp/tasks\tfile.yaml',
      },
      {
        worktree: '/tmp/worktree\r',
        branch: 'feature\x1b[2J',
        baseBranch: 'main\t',
        autoPr: true,
        draftPr: true,
      },
      'workflow\x1b]0;title\x07',
    );

    expect(mockSuccess).toHaveBeenCalledWith('Task created: bad-task\\n');
    expect(mockInfo).toHaveBeenCalledWith('  File: /tmp/tasks\\tfile.yaml');
    expect(mockInfo).toHaveBeenCalledWith('  Worktree: /tmp/worktree\\r');
    expect(mockInfo).toHaveBeenCalledWith('  Branch: feature');
    expect(mockInfo).toHaveBeenCalledWith('  Base branch: main\\t');
    expect(mockInfo).toHaveBeenCalledWith('  Workflow: workflow');
  });

  it('sanitizes current branch in base branch confirmation and missing branch error', async () => {
    mockGetCurrentBranch.mockReturnValue('feature\x1b[31m\n');
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockBranchExists.mockReturnValue(false);
    mockPromptInput
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('next\tbranch');

    await promptWorktreeSettings('/project');

    expect(mockConfirm).toHaveBeenCalledWith(
      '現在のブランチ: feature\\n\nBase branch として feature\\n を使いますか？',
      true,
    );
    expect(mockError).toHaveBeenCalledWith('Base branch does not exist: feature\\n');
  });
});
