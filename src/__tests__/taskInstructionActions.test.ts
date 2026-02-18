import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddTask,
  mockCompleteTask,
  mockFailTask,
  mockExecuteTask,
  mockRunInstructMode,
  mockDispatchConversationAction,
  mockSelectPiece,
  mockExecFileSync,
  mockSaveTaskFile,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn(() => ({
    name: 'instruction-task',
    content: 'instruction',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'instruction' },
  })),
  mockCompleteTask: vi.fn(),
  mockFailTask: vi.fn(),
  mockExecuteTask: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockRunInstructMode: vi.fn(),
  mockDispatchConversationAction: vi.fn(),
  mockSelectPiece: vi.fn(),
  mockSaveTaskFile: vi.fn(),
}));

vi.mock('../infra/task/index.js', () => ({
  createTempCloneForBranch: vi.fn(() => ({ path: '/tmp/clone', branch: 'takt/sample' })),
  removeClone: vi.fn(),
  removeCloneMeta: vi.fn(),
  detectDefaultBranch: vi.fn(() => 'main'),
  autoCommitAndPush: vi.fn(() => ({ success: false, message: 'no changes' })),
  TaskRunner: class {
    addTask(...args: unknown[]) {
      return mockAddTask(...args);
    }
    completeTask(...args: unknown[]) {
      return mockCompleteTask(...args);
    }
    failTask(...args: unknown[]) {
      return mockFailTask(...args);
    }
  },
}));

vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ interactivePreviewMovements: false })),
  getPieceDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    pieceStructure: [],
    movementPreviews: [],
  })),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../features/tasks/list/instructMode.js', () => ({
  runInstructMode: (...args: unknown[]) => mockRunInstructMode(...args),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  saveTaskFile: (...args: unknown[]) => mockSaveTaskFile(...args),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  selectPiece: (...args: unknown[]) => mockSelectPiece(...args),
}));

vi.mock('../features/interactive/actionDispatcher.js', () => ({
  dispatchConversationAction: (...args: unknown[]) => mockDispatchConversationAction(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { instructBranch } from '../features/tasks/list/taskActions.js';

describe('instructBranch execute flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectPiece.mockResolvedValue('default');
    mockRunInstructMode.mockResolvedValue({ action: 'execute', task: '追加して' });
    mockDispatchConversationAction.mockImplementation(async (result, handlers) => {
      const conversationResult = result as { action: 'execute' | 'save_task' | 'cancel'; task: string };
      return handlers[conversationResult.action](conversationResult);
    });
    mockExecFileSync.mockReturnValue('');
  });

  it('should record addTask and completeTask on success', async () => {
    mockExecuteTask.mockResolvedValue(true);

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    });

    expect(result).toBe(true);
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).not.toHaveBeenCalled();
  });

  it('should record addTask and failTask on failure', async () => {
    mockExecuteTask.mockResolvedValue(false);

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    });

    expect(result).toBe(false);
    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });

  it('should pass branch context to instruction and execute flow', async () => {
    mockExecuteTask.mockResolvedValue(true);
    mockExecFileSync
      .mockReturnValueOnce('file.ts | 1 +-\n')
      .mockReturnValueOnce('abc123 add branch changes');

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    });

    const executedTask = mockExecuteTask.mock.calls[0]?.[0] as { task: string };
    expect(executedTask).toBeDefined();
    expect(executedTask.task).toContain('## 現在の変更内容（mainからの差分）');
    expect(executedTask.task).toContain('file.ts | 1 +-');
    expect(executedTask.task).toContain('## コミット履歴');
    expect(executedTask.task).toContain('abc123 add branch changes');
    expect(executedTask.task).toContain('## 追加指示');
    expect(executedTask.task).toContain('追加して');
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project',
      expect.stringContaining('## 現在の変更内容（mainからの差分）'),
      'takt/done-task',
      expect.any(Object),
    );
  });

  it('should save task when runInstructMode returns save_task', async () => {
    mockRunInstructMode.mockResolvedValue({ action: 'save_task', task: '保存して' });
    mockSaveTaskFile.mockResolvedValue({ taskName: 'instruction-task' });

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    });

    expect(result).toBe(true);
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project',
      expect.any(String),
      'takt/done-task',
      expect.any(Object),
    );
    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'save_task', task: '保存して' },
      expect.any(Object),
    );
    expect(mockSaveTaskFile).toHaveBeenCalledTimes(1);
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('should return false when runInstructMode returns cancel', async () => {
    mockRunInstructMode.mockResolvedValue({ action: 'cancel', task: '' });

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    });

    expect(result).toBe(false);
    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'cancel', task: '' },
      expect.any(Object),
    );
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('should record failTask when executeTask throws', async () => {
    mockExecuteTask.mockRejectedValue(new Error('crashed'));

    await expect(instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
    })).rejects.toThrow('crashed');

    expect(mockAddTask).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).not.toHaveBeenCalled();
  });
});
