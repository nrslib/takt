import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExistsSync,
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
  mockRunInstructMode,
  mockDispatchConversationAction,
  mockSelectPiece,
  mockConfirm,
  mockGetLabel,
  mockResolveLanguage,
  mockListRecentRuns,
  mockSelectRun,
  mockLoadRunSessionContext,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockRunInstructMode: vi.fn(),
  mockDispatchConversationAction: vi.fn(),
  mockSelectPiece: vi.fn(),
  mockConfirm: vi.fn(),
  mockGetLabel: vi.fn(),
  mockResolveLanguage: vi.fn(() => 'en'),
  mockListRecentRuns: vi.fn(() => []),
  mockSelectRun: vi.fn(() => null),
  mockLoadRunSessionContext: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  detectDefaultBranch: vi.fn(() => 'main'),
  TaskRunner: class {
    startReExecution(...args: unknown[]) {
      return mockStartReExecution(...args);
    }
    requeueTask(...args: unknown[]) {
      return mockRequeueTask(...args);
    }
  },
}));

vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ interactivePreviewMovements: 3, language: 'en' })),
  getPieceDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    pieceStructure: [],
    movementPreviews: [],
  })),
}));

vi.mock('../features/tasks/list/instructMode.js', () => ({
  runInstructMode: (...args: unknown[]) => mockRunInstructMode(...args),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  selectPiece: (...args: unknown[]) => mockSelectPiece(...args),
}));

vi.mock('../features/interactive/actionDispatcher.js', () => ({
  dispatchConversationAction: (...args: unknown[]) => mockDispatchConversationAction(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (...args: unknown[]) => mockGetLabel(...args),
}));

vi.mock('../features/interactive/index.js', () => ({
  resolveLanguage: (...args: unknown[]) => mockResolveLanguage(...args),
  listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
  selectRun: (...args: unknown[]) => mockSelectRun(...args),
  loadRunSessionContext: (...args: unknown[]) => mockLoadRunSessionContext(...args),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
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
import { error as logError } from '../shared/ui/index.js';

const mockLogError = vi.mocked(logError);

describe('instructBranch direct execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);

    mockSelectPiece.mockResolvedValue('default');
    mockRunInstructMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.execute({ task: '追加指示A' }));
    mockConfirm.mockResolvedValue(true);
    mockGetLabel.mockReturnValue("Reference a previous run's results?");
    mockResolveLanguage.mockReturnValue('en');
    mockListRecentRuns.mockReturnValue([]);
    mockSelectRun.mockResolvedValue(null);
    mockStartReExecution.mockReturnValue({
      name: 'done-task',
      content: 'done',
      data: { task: 'done' },
    });
    mockExecuteAndCompleteTask.mockResolvedValue(true);
  });

  it('should execute directly via startReExecution instead of requeuing', async () => {
    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', retry_note: '既存ノート' },
    });

    expect(result).toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '既存ノート\n\n追加指示A',
    );
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should set generated instruction as retry note when no existing note', async () => {
    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'done-task',
      ['completed', 'failed'],
      undefined,
      '追加指示A',
    );
  });

  it('should run instruct mode in existing worktree', async () => {
    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/done-task',
      expect.any(String),
      'takt/done-task',
      'done-task',
      'done',
      '',
      expect.anything(),
      undefined,
    );
  });

  it('should search runs in worktree for run session context', async () => {
    mockListRecentRuns.mockReturnValue([
      { slug: 'run-1', task: 'fix', piece: 'default', status: 'completed', startTime: '2026-02-18T00:00:00Z' },
    ]);
    mockSelectRun.mockResolvedValue('run-1');
    const runContext = { task: 'fix', piece: 'default', status: 'completed', movementLogs: [], reports: [] };
    mockLoadRunSessionContext.mockReturnValue(runContext);

    await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(mockConfirm).toHaveBeenCalledWith("Reference a previous run's results?", false);
    // selectRunSessionContext uses worktreePath for run data
    expect(mockListRecentRuns).toHaveBeenCalledWith('/project/.takt/worktrees/done-task');
    expect(mockSelectRun).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'en');
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith('/project/.takt/worktrees/done-task', 'run-1');
    expect(mockRunInstructMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/done-task',
      expect.any(String),
      'takt/done-task',
      'done-task',
      'done',
      '',
      expect.anything(),
      runContext,
    );
  });

  it('should return false when worktree does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith('Worktree directory does not exist for task: done-task');
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should requeue task via requeueTask when save_task action', async () => {
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.save_task({ task: '追加指示A' }));

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done' },
    });

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('done-task', ['completed', 'failed'], undefined, '追加指示A');
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should requeue task with existing retry note appended when save_task', async () => {
    mockDispatchConversationAction.mockImplementation(async (_result, handlers) => handlers.save_task({ task: '追加指示A' }));

    const result = await instructBranch('/project', {
      kind: 'completed',
      name: 'done-task',
      createdAt: '2026-02-14T00:00:00.000Z',
      filePath: '/project/.takt/tasks.yaml',
      content: 'done',
      branch: 'takt/done-task',
      worktreePath: '/project/.takt/worktrees/done-task',
      data: { task: 'done', retry_note: '既存ノート' },
    });

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('done-task', ['completed', 'failed'], undefined, '既存ノート\n\n追加指示A');
  });
});
