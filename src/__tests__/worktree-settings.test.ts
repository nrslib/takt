import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSuccess,
  mockInfo,
  mockError,
  mockConfirm,
  mockPromptInput,
  mockConfirmWithCancel,
  mockPromptInputWithCancel,
  mockGetCurrentBranch,
  mockBranchExists,
} = vi.hoisted(() => ({
  mockSuccess: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockConfirm: vi.fn(),
  mockPromptInput: vi.fn(),
  mockConfirmWithCancel: vi.fn(),
  mockPromptInputWithCancel: vi.fn(),
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
  confirmWithCancel: (...args: unknown[]) => mockConfirmWithCancel(...args),
  promptInputWithCancel: (...args: unknown[]) => mockPromptInputWithCancel(...args),
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

const cancelled = { kind: 'cancelled' } as const;
const value = <T>(result: T) => ({ kind: 'value', value: result });

describe('worktree-settings terminal sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmWithCancel.mockReset();
    mockPromptInputWithCancel.mockReset();
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

  it('cancels at the current base branch confirmation without asking the next question', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/work');
    mockConfirmWithCancel.mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockConfirmWithCancel).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Base branch として feature/work を使いますか？'),
      true,
    );
    expect(mockPromptInputWithCancel).not.toHaveBeenCalled();
  });

  it('cancels while re-entering a missing base branch without asking for worktree settings', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/missing');
    mockConfirmWithCancel.mockResolvedValueOnce(value(true));
    mockBranchExists.mockReturnValue(false);
    mockPromptInputWithCancel.mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockPromptInputWithCancel).toHaveBeenCalledExactlyOnceWith('Base branch (Enter for default)');
    expect(mockConfirmWithCancel).toHaveBeenCalledExactlyOnceWith(expect.any(String), true);
    expect(mockPromptInputWithCancel).not.toHaveBeenCalledWith('Worktree path (Enter for auto)');
  });

  it('cancels at the worktree path prompt without asking for later settings', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockPromptInputWithCancel.mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockPromptInputWithCancel).toHaveBeenCalledExactlyOnceWith('Worktree path (Enter for auto)');
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
  });

  it('cancels at the branch name prompt without asking about pull requests', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockPromptInputWithCancel
      .mockResolvedValueOnce(value('/tmp/worktree'))
      .mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockPromptInputWithCancel.mock.calls.map(([message]) => message)).toEqual([
      'Worktree path (Enter for auto)',
      'Branch name (Enter for auto)',
    ]);
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
  });

  it('cancels at the auto-create PR confirmation without asking about draft status', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockPromptInputWithCancel
      .mockResolvedValueOnce(value(null))
      .mockResolvedValueOnce(value(null));
    mockConfirmWithCancel.mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockConfirmWithCancel).toHaveBeenCalledExactlyOnceWith('Auto-create PR?', true);
  });

  it('cancels at the draft confirmation after accepting auto-create PR', async () => {
    mockGetCurrentBranch.mockReturnValue('main');
    mockPromptInputWithCancel
      .mockResolvedValueOnce(value(null))
      .mockResolvedValueOnce(value(null));
    mockConfirmWithCancel
      .mockResolvedValueOnce(value(true))
      .mockResolvedValueOnce(cancelled);

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual(cancelled);

    expect(mockConfirmWithCancel.mock.calls).toEqual([
      ['Auto-create PR?', true],
      ['Create as draft?', true],
    ]);
  });

  it('uses existing defaults when cancellable prompts receive empty answers', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/work');
    mockBranchExists.mockReturnValue(true);
    mockPromptInputWithCancel
      .mockResolvedValueOnce(value(null))
      .mockResolvedValueOnce(value(null));
    mockConfirmWithCancel
      .mockResolvedValueOnce(value(true))
      .mockResolvedValueOnce(value(true))
      .mockResolvedValueOnce(value(true));

    await expect(promptWorktreeSettings('/project', { allowCancel: true })).resolves.toEqual({
      worktree: true,
      branch: undefined,
      baseBranch: 'feature/work',
      autoPr: true,
      draftPr: true,
    });
    expect(mockBranchExists).toHaveBeenCalledExactlyOnceWith('/project', 'feature/work');
  });
});
