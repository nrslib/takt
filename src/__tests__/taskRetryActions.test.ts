import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockExistsSync,
  mockSelectPiece,
  mockSelectOptionWithDefault,
  mockResolvePieceConfigValue,
  mockLoadPieceByIdentifier,
  mockGetPieceDescription,
  mockRunRetryMode,
  mockFindRunForTask,
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockSelectPiece: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
  mockResolvePieceConfigValue: vi.fn(),
  mockLoadPieceByIdentifier: vi.fn(),
  mockGetPieceDescription: vi.fn(() => ({
    name: 'default',
    description: 'desc',
    pieceStructure: '',
    movementPreviews: [],
  })),
  mockRunRetryMode: vi.fn(),
  mockFindRunForTask: vi.fn(() => null),
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('../features/pieceSelection/index.js', () => ({
  selectPiece: (...args: unknown[]) => mockSelectPiece(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: (...args: unknown[]) => mockSelectOptionWithDefault(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  resolvePieceConfigValue: (...args: unknown[]) => mockResolvePieceConfigValue(...args),
  loadPieceByIdentifier: (...args: unknown[]) => mockLoadPieceByIdentifier(...args),
  getPieceDescription: (...args: unknown[]) => mockGetPieceDescription(...args),
}));

vi.mock('../features/interactive/index.js', () => ({
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  loadRunSessionContext: vi.fn(),
  getRunPaths: vi.fn(() => ({ logsDir: '/tmp/logs', reportsDir: '/tmp/reports' })),
  formatRunSessionForPrompt: vi.fn(() => ({
    runTask: '',
    runPiece: 'default',
    runStatus: '',
    runMovementLogs: '',
    runReports: '',
  })),
  runRetryMode: (...args: unknown[]) => mockRunRetryMode(...args),
  findPreviousOrderContent: vi.fn(() => null),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    startReExecution(...args: unknown[]) {
      return mockStartReExecution(...args);
    }
    requeueTask(...args: unknown[]) {
      return mockRequeueTask(...args);
    }
  },
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => {
    const labels: Record<string, string> = {
      'retry.workflowPrompt': 'Select workflow:',
      'retry.usePreviousWorkflow': 'Use previous',
      'retry.changeWorkflow': 'Change workflow',
    };
    return labels[key] ?? key;
  }),
}));

import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import type { TaskListItem } from '../infra/task/types.js';
import type { PieceConfig } from '../core/models/index.js';

const defaultPieceConfig: PieceConfig = {
  name: 'default',
  description: 'Default piece',
  initialMovement: 'plan',
  maxMovements: 30,
  movements: [
    { name: 'plan', persona: 'planner', instruction: '' },
    { name: 'implement', persona: 'coder', instruction: '' },
    { name: 'review', persona: 'reviewer', instruction: '' },
  ],
};

function makeFailedTask(overrides?: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'failed',
    name: 'my-task',
    createdAt: '2025-01-15T12:02:00.000Z',
    filePath: '/project/.takt/tasks.yaml',
    content: 'Do something',
    branch: 'takt/my-task',
    worktreePath: '/project/.takt/worktrees/my-task',
    data: { task: 'Do something', piece: 'default' },
    failure: { movement: 'review', error: 'Boom' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);

  mockSelectPiece.mockResolvedValue('default');
  mockResolvePieceConfigValue.mockReturnValue(3);
  mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
  mockSelectOptionWithDefault.mockResolvedValue('plan');
  mockRunRetryMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
  mockStartReExecution.mockReturnValue({
    name: 'my-task',
    content: 'Do something',
    data: { task: 'Do something', piece: 'default' },
  });
  mockExecuteAndCompleteTask.mockResolvedValue(true);
});

describe('retryFailedTask', () => {
  it('should run retry mode in existing worktree and execute directly', async () => {
    const task = makeFailedTask();

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
    expect(mockRunRetryMode).toHaveBeenCalledWith(
      '/project/.takt/worktrees/my-task',
      expect.objectContaining({
        failure: expect.objectContaining({ taskName: 'my-task', taskContent: 'Do something' }),
      }),
      null,
    );
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should pass failed movement as default to selectOptionWithDefault', async () => {
    const task = makeFailedTask(); // failure.movement = 'review'

    await retryFailedTask(task, '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from movement:',
      expect.arrayContaining([
        expect.objectContaining({ value: 'plan' }),
        expect.objectContaining({ value: 'implement' }),
        expect.objectContaining({ value: 'review' }),
      ]),
      'review',
    );
  });

  it('should pass non-initial movement as startMovement', async () => {
    const task = makeFailedTask();
    mockSelectOptionWithDefault.mockResolvedValue('implement');

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], 'implement', '追加指示A');
  });

  it('should not pass startMovement when initial movement is selected', async () => {
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
  });

  it('should append instruction to existing retry note', async () => {
    const task = makeFailedTask({ data: { task: 'Do something', piece: 'default', retry_note: '既存ノート' } });

    await retryFailedTask(task, '/project');

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task', ['failed'], undefined, '既存ノート\n\n追加指示A',
    );
  });

  it('should search runs in worktree, not projectDir', async () => {
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    expect(mockFindRunForTask).toHaveBeenCalledWith('/project/.takt/worktrees/my-task', 'Do something');
  });

  it('should throw when worktree path is not set', async () => {
    const task = makeFailedTask({ worktreePath: undefined });

    await expect(retryFailedTask(task, '/project')).rejects.toThrow('Worktree path is not set');
  });

  it('should throw when worktree directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const task = makeFailedTask();

    await expect(retryFailedTask(task, '/project')).rejects.toThrow('Worktree directory does not exist');
  });

  it('should return false when piece selection is cancelled', async () => {
    const task = makeFailedTask();
    mockSelectPiece.mockResolvedValue(null);

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(false);
    expect(mockLoadPieceByIdentifier).not.toHaveBeenCalled();
  });

  it('should return false when retry mode is cancelled', async () => {
    const task = makeFailedTask();
    mockRunRetryMode.mockResolvedValue({ action: 'cancel', task: '' });

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(false);
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should requeue task via requeueTask when save_task action', async () => {
    const task = makeFailedTask();
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '追加指示A');
    expect(mockStartReExecution).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should requeue task with existing retry note appended when save_task', async () => {
    const task = makeFailedTask({ data: { task: 'Do something', piece: 'default', retry_note: '既存ノート' } });
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    await retryFailedTask(task, '/project');

    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '既存ノート\n\n追加指示A');
  });

  describe('when previous workflow exists', () => {
    beforeEach(() => {
      mockFindRunForTask.mockReturnValue('run-123');
    });

    it('should show workflow selection prompt when runInfo.piece exists', async () => {
      const task = makeFailedTask();

      await retryFailedTask(task, '/project');

      expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
        'Select workflow:',
        expect.arrayContaining([
          expect.objectContaining({ value: 'use_previous' }),
          expect.objectContaining({ value: 'change' }),
        ]),
        'use_previous',
      );
    });

    it('should use previous workflow when use_previous is selected', async () => {
      const task = makeFailedTask();
      mockSelectOptionWithDefault.mockResolvedValue('use_previous');

      await retryFailedTask(task, '/project');

      expect(mockSelectPiece).not.toHaveBeenCalled();
      expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('default', '/project');
    });

    it('should call selectPiece when change is selected', async () => {
      const task = makeFailedTask();
      mockSelectOptionWithDefault.mockResolvedValue('change');

      await retryFailedTask(task, '/project');

      expect(mockSelectPiece).toHaveBeenCalledWith('/project');
    });

    it('should return false when workflow selection is cancelled', async () => {
      const task = makeFailedTask();
      mockSelectOptionWithDefault.mockResolvedValue(null);

      const result = await retryFailedTask(task, '/project');

      expect(result).toBe(false);
      expect(mockLoadPieceByIdentifier).not.toHaveBeenCalled();
    });
  });
});
