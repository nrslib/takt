/**
 * Tests for runAllTasks concurrency support (worker pool)
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
    taskPollIntervalMs: 500,
  })),
}));

import { loadGlobalConfig } from '../infra/config/index.js';
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);

const mockGetNextTask = vi.fn();
const mockClaimNextTasks = vi.fn();
const mockCompleteTask = vi.fn();
const mockFailTask = vi.fn();

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TaskRunner: vi.fn().mockImplementation(() => ({
    getNextTask: mockGetNextTask,
    claimNextTasks: mockClaimNextTasks,
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
        taskPollIntervalMs: 500,
      });
    });

    it('should show no-tasks message when no tasks exist', async () => {
      // Given: No pending tasks
      mockClaimNextTasks.mockReturnValue([]);

      // When
      await runAllTasks('/project');

      // Then
      expect(mockInfo).toHaveBeenCalledWith('No pending tasks in .takt/tasks/');
    });

    it('should execute tasks sequentially via worker pool when concurrency is 1', async () => {
      // Given: Two tasks available sequentially
      const task1 = createTask('task-1');
      const task2 = createTask('task-2');

      mockClaimNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([task2])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: Worker pool uses claimNextTasks for fetching more tasks
      expect(mockClaimNextTasks).toHaveBeenCalled();
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
        taskPollIntervalMs: 500,
      });
    });

    it('should display concurrency info when concurrency > 1', async () => {
      // Given: Tasks available
      const task1 = createTask('task-1');
      mockClaimNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then
      expect(mockInfo).toHaveBeenCalledWith('Concurrency: 3');
    });

    it('should execute tasks using worker pool when concurrency > 1', async () => {
      // Given: 3 tasks available
      const task1 = createTask('task-1');
      const task2 = createTask('task-2');
      const task3 = createTask('task-3');

      mockClaimNextTasks
        .mockReturnValueOnce([task1, task2, task3])
        .mockReturnValueOnce([]);

      // In parallel mode, task start messages go through TaskPrefixWriter → process.stdout.write
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });

      // When
      await runAllTasks('/project');
      writeSpy.mockRestore();

      // Then: Task names displayed with prefix in stdout
      const allOutput = stdoutChunks.join('');
      expect(allOutput).toContain('[task-1]');
      expect(allOutput).toContain('=== Task: task-1 ===');
      expect(allOutput).toContain('[task-2]');
      expect(allOutput).toContain('=== Task: task-2 ===');
      expect(allOutput).toContain('[task-3]');
      expect(allOutput).toContain('=== Task: task-3 ===');
      expect(mockStatus).toHaveBeenCalledWith('Total', '3');
    });

    it('should fill slots as tasks complete (worker pool behavior)', async () => {
      // Given: 5 tasks, concurrency=3
      // Worker pool should start 3, then fill slots as tasks complete
      const tasks = Array.from({ length: 5 }, (_, i) => createTask(`task-${i + 1}`));

      mockClaimNextTasks
        .mockReturnValueOnce(tasks.slice(0, 3))
        .mockReturnValueOnce(tasks.slice(3, 5))
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: All 5 tasks executed
      expect(mockStatus).toHaveBeenCalledWith('Total', '5');
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
        taskPollIntervalMs: 500,
      });

      const task1 = createTask('task-1');
      mockClaimNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

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
        taskPollIntervalMs: 500,
      });
      // Return a valid piece config so executeTask reaches executePiece
      mockLoadPieceByIdentifier.mockReturnValue(fakePieceConfig as never);
    });

    it('should run tasks concurrently, not sequentially', async () => {
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

      mockClaimNextTasks
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

    it('should fill slots immediately when a task completes (no batch waiting)', async () => {
      // Given: 3 tasks, concurrency=2, task1 finishes quickly, task2 takes longer
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 2,
        taskPollIntervalMs: 500,
      });

      const task1 = createTask('fast');
      const task2 = createTask('slow');
      const task3 = createTask('after-fast');

      const executionOrder: string[] = [];

      mockExecutePiece.mockImplementation((_config, task) => {
        executionOrder.push(`start:${task}`);
        const delay = (task as string).includes('slow') ? 80 : 20;
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end:${task}`);
            resolve({ success: true });
          }, delay);
        });
      });

      mockClaimNextTasks
        .mockReturnValueOnce([task1, task2])
        .mockReturnValueOnce([task3])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: task3 starts before task2 finishes (slot filled immediately)
      const task3StartIdx = executionOrder.indexOf('start:Task: after-fast');
      const task2EndIdx = executionOrder.indexOf('end:Task: slow');
      expect(task3StartIdx).toBeLessThan(task2EndIdx);
      expect(mockStatus).toHaveBeenCalledWith('Total', '3');
    });

    it('should count partial failures correctly', async () => {
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

      mockClaimNextTasks
        .mockReturnValueOnce([task1, task2, task3])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: Correct success/fail counts
      expect(mockStatus).toHaveBeenCalledWith('Total', '3');
      expect(mockStatus).toHaveBeenCalledWith('Success', '2', undefined);
      expect(mockStatus).toHaveBeenCalledWith('Failed', '1', 'red');
    });

    it('should pass abortSignal and taskPrefix to executePiece in parallel mode', async () => {
      // Given: One task in parallel mode
      const task1 = createTask('parallel-task');

      mockExecutePiece.mockResolvedValue({ success: true });

      mockClaimNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: executePiece received abortSignal and taskPrefix options
      expect(mockExecutePiece).toHaveBeenCalledTimes(1);
      const callArgs = mockExecutePiece.mock.calls[0];
      const pieceOptions = callArgs?.[3]; // 4th argument is options
      expect(pieceOptions).toHaveProperty('abortSignal');
      expect(pieceOptions?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(pieceOptions).toHaveProperty('taskPrefix', 'parallel-task');
    });

    it('should not pass abortSignal or taskPrefix in sequential mode', async () => {
      // Given: Sequential mode
      mockLoadGlobalConfig.mockReturnValue({
        language: 'en',
        defaultPiece: 'default',
        logLevel: 'info',
        concurrency: 1,
        taskPollIntervalMs: 500,
      });

      const task1 = createTask('sequential-task');
      mockExecutePiece.mockResolvedValue({ success: true });
      mockLoadPieceByIdentifier.mockReturnValue(fakePieceConfig as never);

      mockClaimNextTasks
        .mockReturnValueOnce([task1])
        .mockReturnValueOnce([]);

      // When
      await runAllTasks('/project');

      // Then: executePiece should not have abortSignal or taskPrefix
      expect(mockExecutePiece).toHaveBeenCalledTimes(1);
      const callArgs = mockExecutePiece.mock.calls[0];
      const pieceOptions = callArgs?.[3];
      expect(pieceOptions?.abortSignal).toBeUndefined();
      expect(pieceOptions?.taskPrefix).toBeUndefined();
    });
  });
});
