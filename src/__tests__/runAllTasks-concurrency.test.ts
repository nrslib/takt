/**
 * Tests for runAllTasks concurrency support
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

// Mock dependencies before importing the module under test
vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: vi.fn(),
  isPiecePath: vi.fn(() => false),
  loadGlobalConfig: vi.fn(() => ({
    language: 'en',
    defaultPiece: 'default',
    logLevel: 'info',
    concurrency: 1,
  })),
}));

import { loadGlobalConfig } from '../infra/config/index.js';
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);

const mockGetNextTask = vi.fn();
const mockGetNextTasks = vi.fn();
const mockCompleteTask = vi.fn();
const mockFailTask = vi.fn();

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TaskRunner: vi.fn().mockImplementation(() => ({
    getNextTask: mockGetNextTask,
    getNextTasks: mockGetNextTasks,
    completeTask: mockCompleteTask,
    failTask: mockFailTask,
  })),
}));

vi.mock('../infra/task/clone.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
}));

vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentBranch: vi.fn(() => 'main'),
}));

vi.mock('../infra/task/autoCommit.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: vi.fn((e) => e.message),
}));

vi.mock('../features/tasks/execute/pieceExecution.js', () => ({
  executePiece: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn(() => false),
}));

vi.mock('../shared/constants.js', () => ({
  DEFAULT_PIECE_NAME: 'default',
  DEFAULT_LANGUAGE: 'en',
}));

vi.mock('../infra/github/index.js', () => ({
  createPullRequest: vi.fn(),
  buildPrBody: vi.fn(),
  pushBranch: vi.fn(),
}));

vi.mock('../infra/claude/index.js', () => ({
  interruptAllQueries: vi.fn(),
  callAiJudge: vi.fn(),
  detectRuleIndex: vi.fn(),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => key),
}));

import { info, header, status, success, error as errorFn } from '../shared/ui/index.js';
import { runAllTasks } from '../features/tasks/index.js';
import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import { loadPieceByIdentifier } from '../infra/config/index.js';

const mockInfo = vi.mocked(info);
const mockHeader = vi.mocked(header);
const mockStatus = vi.mocked(status);
const mockSuccess = vi.mocked(success);
const mockError = vi.mocked(errorFn);
const mockExecutePiece = vi.mocked(executePiece);
const mockLoadPieceByIdentifier = vi.mocked(loadPieceByIdentifier);

function createTask(name: string): TaskInfo {
  return {
    name,
    content: `Task: ${name}`,
    filePath: `/tasks/${name}.yaml`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAllTasks concurrency', () => {
  describe('sequential execution (concurrency=1)', () => {
    beforeEach(() => {
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 1,
      });
    });

    it('should show no-tasks message when no tasks exist', async () => {
      // Given: No pending tasks
      mockGetNextTasks.mockReturnValue([]);

      // When
      await runAllTasks('/project');

      // Then
      expect(mockInfo).toHaveBeenCalledWith('No pending tasks in .takt/tasks/');
    });

    it('should execute tasks sequentially when concurrency is 1', async () => {
      // Given: Two tasks available sequentially
      const task1 = createTask('task-1');
      const task2 = createTask('task-2');

      mockGetNextTasks.mockReturnValueOnce([task1]);
      mockGetNextTask
        .mockReturnValueOnce(task2)
        .mockReturnValueOnce(null);

      // When
      await runAllTasks('/project');

      // Then: Sequential execution uses getNextTask in the while loop
      expect(mockGetNextTask).toHaveBeenCalled();
      expect(mockStatus).toHaveBeenCalledWith('Total', '2');
    });
  });

  describe('parallel execution (concurrency>1)', () => {
    beforeEach(() => {
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 3,
      });
    });

    it('should display concurrency info when concurrency > 1', async () => {
      // Given: Tasks available
      const task1 = createTask('task-1');
      mockGetNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then
      expect(mockInfo).toHaveBeenCalledWith('Concurrency: 3');
    });

    it('should execute tasks in batch when concurrency > 1', async () => {
      // Given: 3 tasks available in first batch
      const task1 = createTask('task-1');
      const task2 = createTask('task-2');
      const task3 = createTask('task-3');

      mockGetNextTasks
        .mockReturnValueOnce([task1, task2, task3])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: Batch info shown
      expect(mockInfo).toHaveBeenCalledWith('=== Running batch of 3 task(s) ===');
      expect(mockStatus).toHaveBeenCalledWith('Total', '3');
    });

    it('should process multiple batches', async () => {
      // Given: 5 tasks, concurrency=3 → batch1 (3 tasks), batch2 (2 tasks)
      const tasks = Array.from({ length: 5 }, (_, i) => createTask(`task-${i + 1}`));

      mockGetNextTasks
        .mockReturnValueOnce(tasks.slice(0, 3))
        .mockReturnValueOnce(tasks.slice(3, 5))
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: Both batches shown
      expect(mockInfo).toHaveBeenCalledWith('=== Running batch of 3 task(s) ===');
      expect(mockInfo).toHaveBeenCalledWith('=== Running batch of 2 task(s) ===');
      expect(mockStatus).toHaveBeenCalledWith('Total', '5');
    });

    it('should not use getNextTask in parallel mode', async () => {
      // Given: Tasks in parallel mode
      const task1 = createTask('task-1');
      mockGetNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: getNextTask should not be called (parallel uses getNextTasks)
      expect(mockGetNextTask).not.toHaveBeenCalled();
    });

    it('should list task names in batch output', async () => {
      // Given: Tasks with specific names
      const task1 = createTask('auth-feature');
      const task2 = createTask('db-migration');

      mockGetNextTasks
        .mockReturnValueOnce([task1, task2])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then
      expect(mockInfo).toHaveBeenCalledWith('  - auth-feature');
      expect(mockInfo).toHaveBeenCalledWith('  - db-migration');
    });
  });

  describe('default concurrency', () => {
    it('should default to sequential when concurrency is not set', async () => {
      // Given: Config without explicit concurrency (defaults to 1)
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 1,
      });

      const task1 = createTask('task-1');
      mockGetNextTasks.mockReturnValueOnce([task1]);
      mockGetNextTask.mockReturnValueOnce(null);

      // When
      await runAllTasks('/project');

      // Then: No concurrency info displayed
      const concurrencyInfoCalls = mockInfo.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('Concurrency:')
      );
      expect(concurrencyInfoCalls).toHaveLength(0);
    });
  });

  describe('parallel execution behavior', () => {
    const fakePieceConfig = {
      name: 'default',
      movements: [{ name: 'implement', personaDisplayName: 'coder' }],
      initialMovement: 'implement',
      maxIterations: 10,
    };

    beforeEach(() => {
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 3,
      });
      // Return a valid piece config so executeTask reaches executePiece
      mockLoadPieceByIdentifier.mockReturnValue(fakePieceConfig as never);
    });

    it('should run batch tasks concurrently, not sequentially', async () => {
      // Given: 2 tasks with delayed execution to verify concurrency
      const task1 = createTask('slow-1');
      const task2 = createTask('slow-2');

      const executionOrder: string[] = [];

      // Each task takes 50ms — if sequential, total > 100ms; if parallel, total ~50ms
      mockExecutePiece.mockImplementation((_config, task) => {
        executionOrder.push(`start:${task}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end:${task}`);
            resolve({ success: true });
          }, 50);
        });
      });

      mockGetNextTasks
        .mockReturnValueOnce([task1, task2])
        .mockReturnValueOnce([]);

      // When
      const startTime = Date.now();
      await runAllTasks('/project');
      const elapsed = Date.now() - startTime;

      // Then: Both tasks started before either completed (concurrent execution)
      expect(executionOrder[0]).toBe('start:Task: slow-1');
      expect(executionOrder[1]).toBe('start:Task: slow-2');
      // Elapsed time should be closer to 50ms than 100ms (allowing margin for CI)
      expect(elapsed).toBeLessThan(150);
    });

    it('should count partial failures correctly in a batch', async () => {
      // Given: 3 tasks, 1 fails, 2 succeed
      const task1 = createTask('pass-1');
      const task2 = createTask('fail-1');
      const task3 = createTask('pass-2');

      let callIndex = 0;
      mockExecutePiece.mockImplementation(() => {
        callIndex++;
        // Second call fails
        return Promise.resolve({ success: callIndex !== 2 });
      });

      mockGetNextTasks
        .mockReturnValueOnce([task1, task2, task3])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: Correct success/fail counts
      expect(mockStatus).toHaveBeenCalledWith('Total', '3');
      expect(mockStatus).toHaveBeenCalledWith('Success', '2', undefined);
      expect(mockStatus).toHaveBeenCalledWith('Failed', '1', 'red');
    });

    it('should pass abortSignal and quiet=true to executePiece in parallel mode', async () => {
      // Given: One task in parallel mode
      const task1 = createTask('parallel-task');

      mockExecutePiece.mockResolvedValue({ success: true });

      mockGetNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: executePiece received abortSignal and quiet options
      expect(mockExecutePiece).toHaveBeenCalledTimes(1);
      const callArgs = mockExecutePiece.mock.calls[0];
      const pieceOptions = callArgs?.[3]; // 4th argument is options
      expect(pieceOptions).toHaveProperty('abortSignal');
      expect(pieceOptions?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(pieceOptions).toHaveProperty('quiet', true);
    });

    it('should not pass abortSignal or quiet in sequential mode', async () => {
      // Given: Sequential mode
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 1,
      });

      const task1 = createTask('sequential-task');
      mockExecutePiece.mockResolvedValue({ success: true });
      mockLoadPieceByIdentifier.mockReturnValue(fakePieceConfig as never);

      mockGetNextTasks.mockReturnValueOnce([task1]);
      mockGetNextTask.mockReturnValueOnce(null);

      // When
      await runAllTasks('/project');

      // Then: executePiece should not have abortSignal or quiet
      expect(mockExecutePiece).toHaveBeenCalledTimes(1);
      const callArgs = mockExecutePiece.mock.calls[0];
      const pieceOptions = callArgs?.[3];
      expect(pieceOptions?.abortSignal).toBeUndefined();
      expect(pieceOptions?.quiet).toBeFalsy();
    });
  });
});
