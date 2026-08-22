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

    const messages = [
      ...mockSuccess.mock.calls.map(([message]) => String(message)),
      ...mockInfo.mock.calls.map(([message]) => String(message)),
    ].join('\\n');
    expect(messages).toContain('bad-task\\n');
    expect(messages).toContain('/tmp/tasks\\tfile.yaml');
    expect(messages).toContain('/tmp/worktree\\r');
    expect(messages).toContain('feature');
    expect(messages).toContain('main\\t');
    expect(messages).toContain('workflow');
    expect(messages).not.toContain('\\x1b');
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

    expect(mockConfirm).toHaveBeenCalledWith(expect.stringContaining('feature\\n'), true);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('feature\\n'));
  });
});
