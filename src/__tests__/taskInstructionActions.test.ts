import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddTask,
  mockCompleteTask,
  mockFailTask,
  mockExecuteTask,
  mockRunInstructMode,
  mockDispatchConversationAction,
  mockSelectPiece,
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
  mockRunInstructMode: vi.fn(),
  mockDispatchConversationAction: vi.fn(),
  mockSelectPiece: vi.fn(),
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

vi.mock('../features/tasks/list/instructMode.js', () => ({
  runInstructMode: (...args: unknown[]) => mockRunInstructMode(...args),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  saveTaskFile: vi.fn(),
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
    mockRunInstructMode.mockResolvedValue({ type: 'execute', task: '追加して' });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.execute({ task: '追加して' }));
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
