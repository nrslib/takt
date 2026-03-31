import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockExistsSync,
  mockSelectPiece,
  mockSelectOptionWithDefault,
  mockConfirm,
  mockResolvePieceConfigValue,
  mockLoadPieceByIdentifier,
  mockGetPieceDescription,
  mockRunRetryMode,
  mockFindRunForTask,
  mockFindPreviousOrderContent,
  mockLoadRunSessionContext,
  mockFormatRunSessionForPrompt,
  mockStartReExecution,
  mockRequeueTask,
  mockExecuteAndCompleteTask,
  mockWarn,
  mockInfo,
  mockHeader,
  mockStatus,
  mockIsPiecePath,
  mockLoadAllPiecesWithSources,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockSelectPiece: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
  mockConfirm: vi.fn(),
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
  mockFindPreviousOrderContent: vi.fn(() => null),
  mockLoadRunSessionContext: vi.fn(),
  mockFormatRunSessionForPrompt: vi.fn((sessionContext?: { piece?: string }) => ({
    runTask: '',
    runPiece: sessionContext?.piece ?? '',
    runStatus: '',
    runMovementLogs: '',
    runReports: '',
  })),
  mockStartReExecution: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockStatus: vi.fn(),
  mockIsPiecePath: vi.fn(() => false),
  mockLoadAllPiecesWithSources: vi.fn(() => new Map<string, unknown>([['default', {}]])),
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
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  header: (...args: unknown[]) => mockHeader(...args),
  blankLine: vi.fn(),
  status: (...args: unknown[]) => mockStatus(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
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
  isPiecePath: (...args: unknown[]) => mockIsPiecePath(...args),
  loadAllPiecesWithSources: (...args: unknown[]) => mockLoadAllPiecesWithSources(...args),
}));

vi.mock('../features/interactive/index.js', () => ({
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  loadRunSessionContext: (...args: unknown[]) => mockLoadRunSessionContext(...args),
  getRunPaths: vi.fn(() => ({ logsDir: '/tmp/logs', reportsDir: '/tmp/reports' })),
  formatRunSessionForPrompt: (...args: unknown[]) => mockFormatRunSessionForPrompt(...args),
  runRetryMode: (...args: unknown[]) => mockRunRetryMode(...args),
  findPreviousOrderContent: (...args: unknown[]) => mockFindPreviousOrderContent(...args),
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
  resolveTaskWorkflowValue: vi.fn((data?: Record<string, unknown>) => {
    if (!data) {
      return undefined;
    }
    const workflow = typeof data.workflow === 'string' ? data.workflow : undefined;
    const piece = typeof data.piece === 'string' ? data.piece : undefined;
    if (workflow !== undefined && piece !== undefined && workflow !== piece) {
      throw new Error("Task configuration conflict: 'workflow' and 'piece' must match when both are set.");
    }
    return workflow ?? piece;
  }),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string, _lang?: string, vars?: Record<string, string>) => {
    if (vars?.piece) {
      return `Use previous workflow "${vars.piece}"?`;
    }
    return key;
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

  mockConfirm.mockResolvedValue(true);
  mockSelectPiece.mockResolvedValue('default');
  mockResolvePieceConfigValue.mockReturnValue(3);
  mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
  mockIsPiecePath.mockImplementation((piece: string) => piece.startsWith('/') || piece.startsWith('~') || piece.startsWith('./') || piece.startsWith('../') || piece.endsWith('.yaml') || piece.endsWith('.yml'));
  mockLoadAllPiecesWithSources.mockReturnValue(new Map<string, unknown>([['default', {}], ['selected-piece', {}]]));
  mockSelectOptionWithDefault.mockResolvedValue('plan');
  mockRunRetryMode.mockResolvedValue({ action: 'execute', task: '追加指示A' });
  mockFindPreviousOrderContent.mockReturnValue(null);
  mockLoadRunSessionContext.mockReturnValue({
    task: 'Do something',
    piece: 'default',
    status: 'failed',
    movementLogs: [],
    reports: [],
  });
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
    mockConfirm.mockResolvedValue(true);

    const result = await retryFailedTask(task, '/project');

    expect(result).toBe(true);
    expect(mockSelectPiece).not.toHaveBeenCalled();
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

  it('should execute with selected piece without mutating taskInfo', async () => {
    mockConfirm.mockResolvedValue(false);
    mockSelectPiece.mockResolvedValue('selected-piece');
    const originalTaskInfo = {
      name: 'my-task',
      content: 'Do something',
      data: { task: 'Do something', piece: 'original-piece' },
    };
    mockStartReExecution.mockReturnValue(originalTaskInfo);
    const task = makeFailedTask();

    await retryFailedTask(task, '/project');

    const executeArg = mockExecuteAndCompleteTask.mock.calls[0]?.[0];
    expect(executeArg).not.toBe(originalTaskInfo);
    expect(executeArg.data).not.toBe(originalTaskInfo.data);
    expect(executeArg.data.piece).toBe('selected-piece');
    expect(originalTaskInfo.data.piece).toBe('original-piece');
  });

  it('should pass failed step as default to selectOptionWithDefault', async () => {
    const task = makeFailedTask(); // failure.movement = 'review'

    await retryFailedTask(task, '/project');

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      'Start from step:',
      expect.arrayContaining([
        expect.objectContaining({ value: 'plan', description: 'Initial step' }),
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

  it('should show deprecated config warning when selected run order uses legacy provider fields', async () => {
    const task = makeFailedTask();
    mockFindPreviousOrderContent.mockReturnValue([
      'movements:',
      '  - name: review',
      '    provider: codex',
      '    model: gpt-5.3',
      '    provider_options:',
      '      codex:',
      '        network_access: true',
    ].join('\n'));

    await retryFailedTask(task, '/project');

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('should sanitize failure details before printing to terminal', async () => {
    const task = makeFailedTask({
      name: 'bad\x1b[31m-task\n',
      failure: {
        movement: 'review\x1b[2J',
        error: 'Boom\r',
        last_message: 'last\tmessage',
      },
    });

    await retryFailedTask(task, '/project');

    expect(mockHeader).toHaveBeenCalledWith('Failed Task: bad-task\\n');
    expect(mockStatus).toHaveBeenCalledWith('Failed at', 'review', 'red');
    expect(mockStatus).toHaveBeenCalledWith('Error', 'Boom\\r', 'red');
    expect(mockStatus).toHaveBeenCalledWith('Last message', 'last\\tmessage');
  });

  it('should not warn when selected run order uses provider block format', async () => {
    const task = makeFailedTask();
    mockFindPreviousOrderContent.mockReturnValue([
      'movements:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
    ].join('\n'));

    await retryFailedTask(task, '/project');

    expect(mockWarn).not.toHaveBeenCalled();
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
    mockConfirm.mockResolvedValue(false);
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

  it('should sanitize task name in requeue confirmation', async () => {
    const task = makeFailedTask({ name: 'bad\x1b[31m-task\n' });
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    await retryFailedTask(task, '/project');

    expect(mockInfo).toHaveBeenCalledWith('Task "bad-task\\n" has been requeued.');
  });

  it('should requeue task with existing retry note appended when save_task', async () => {
    const task = makeFailedTask({ data: { task: 'Do something', piece: 'default', retry_note: '既存ノート' } });
    mockRunRetryMode.mockResolvedValue({ action: 'save_task', task: '追加指示A' });

    await retryFailedTask(task, '/project');

    expect(mockRequeueTask).toHaveBeenCalledWith('my-task', ['failed'], undefined, '既存ノート\n\n追加指示A');
  });

  describe('when previous piece exists in task data', () => {
    it('should ask whether to reuse previous piece with default yes', async () => {
      const task = makeFailedTask();

      await retryFailedTask(task, '/project');

      const [message, defaultYes] = mockConfirm.mock.calls[0] ?? [];
      expect(message).toEqual(expect.stringContaining('"default"'));
      expect(defaultYes ?? true).toBe(true);
    });

    it('should use previous piece when reuse is confirmed', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(true);

      await retryFailedTask(task, '/project');

      expect(mockSelectPiece).not.toHaveBeenCalled();
      expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('default', '/project');
    });

    it('should reuse previous workflow when only workflow alias is stored', async () => {
      const task = makeFailedTask({ data: { task: 'Do something', workflow: 'default' } });
      mockConfirm.mockResolvedValue(true);

      await retryFailedTask(task, '/project');

      const [message] = mockConfirm.mock.calls[0] ?? [];
      expect(message).toEqual(expect.stringContaining('"default"'));
      expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('default', '/project');
    });

    it('should fail fast when workflow and piece conflict in retry data', async () => {
      const task = makeFailedTask({ data: { task: 'Do something', workflow: 'a', piece: 'b' } });

      await expect(retryFailedTask(task, '/project')).rejects.toThrow(
        "Task configuration conflict: 'workflow' and 'piece' must match when both are set.",
      );
    });

    it('should call selectPiece when reuse is declined', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(false);

      await retryFailedTask(task, '/project');

      expect(mockSelectPiece).toHaveBeenCalledWith('/project');
    });

    it('should return false when selecting replacement piece is cancelled after declining reuse', async () => {
      const task = makeFailedTask();
      mockConfirm.mockResolvedValue(false);
      mockSelectPiece.mockResolvedValue(null);

      const result = await retryFailedTask(task, '/project');

      expect(result).toBe(false);
      expect(mockLoadPieceByIdentifier).not.toHaveBeenCalled();
    });

    it('should skip reuse prompt when task data has no piece', async () => {
      const task = makeFailedTask({ data: { task: 'Do something' } });

      await retryFailedTask(task, '/project');

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSelectPiece).toHaveBeenCalledWith('/project');
    });
  });
});
