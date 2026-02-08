/**
 * Unit tests for runWithWorkerPool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn((key: string) => key),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockExecuteAndCompleteTask = vi.fn();

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { info } from '../shared/ui/index.js';

const mockInfo = vi.mocked(info);

const TEST_POLL_INTERVAL_MS = 50;

function createTask(name: string): TaskInfo {
  return {
    name,
    content: `Task: ${name}`,
    filePath: `/tasks/${name}.yaml`,
  };
}

function createMockTaskRunner(taskBatches: TaskInfo[][]) {
  let batchIndex = 0;
  return {
    getNextTask: vi.fn(() => null),
    claimNextTasks: vi.fn(() => {
      const batch = taskBatches[batchIndex] ?? [];
      batchIndex++;
      return batch;
    }),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteAndCompleteTask.mockResolvedValue(true);
});

describe('runWithWorkerPool', () => {
  it('should return correct counts for all successful tasks', async () => {
    // Given
    const tasks = [createTask('a'), createTask('b')];
    const runner = createMockTaskRunner([]);

    // When
    const result = await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(result).toEqual({ success: 2, fail: 0 });
  });

  it('should return correct counts when some tasks fail', async () => {
    // Given
    const tasks = [createTask('pass'), createTask('fail'), createTask('pass2')];
    let callIdx = 0;
    mockExecuteAndCompleteTask.mockImplementation(() => {
      callIdx++;
      return Promise.resolve(callIdx !== 2);
    });
    const runner = createMockTaskRunner([]);

    // When
    const result = await runWithWorkerPool(runner as never, tasks, 3, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(result).toEqual({ success: 2, fail: 1 });
  });

  it('should display task name for each task via prefix writer in parallel mode', async () => {
    // Given
    const tasks = [createTask('alpha'), createTask('beta')];
    const runner = createMockTaskRunner([]);
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    // When
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then: Task names appear in prefixed stdout output
    writeSpy.mockRestore();
    const allOutput = stdoutChunks.join('');
    expect(allOutput).toContain('[alpha]');
    expect(allOutput).toContain('=== Task: alpha ===');
    expect(allOutput).toContain('[beta]');
    expect(allOutput).toContain('=== Task: beta ===');
  });

  it('should pass taskPrefix for parallel execution (concurrency > 1)', async () => {
    // Given
    const tasks = [createTask('my-task')];
    const runner = createMockTaskRunner([]);

    // When
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledTimes(1);
    const parallelOpts = mockExecuteAndCompleteTask.mock.calls[0]?.[5];
    expect(parallelOpts).toEqual({
      abortSignal: expect.any(AbortSignal),
      taskPrefix: 'my-task',
      taskColorIndex: 0,
    });
  });

  it('should not pass taskPrefix or abortSignal for sequential execution (concurrency = 1)', async () => {
    // Given
    const tasks = [createTask('seq-task')];
    const runner = createMockTaskRunner([]);

    // When
    await runWithWorkerPool(runner as never, tasks, 1, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledTimes(1);
    const parallelOpts = mockExecuteAndCompleteTask.mock.calls[0]?.[5];
    expect(parallelOpts).toEqual({
      abortSignal: undefined,
      taskPrefix: undefined,
      taskColorIndex: undefined,
    });
  });

  it('should fetch more tasks when slots become available', async () => {
    // Given: 1 initial task, runner provides 1 more after
    const task1 = createTask('first');
    const task2 = createTask('second');
    const runner = createMockTaskRunner([[task2]]);

    // When
    await runWithWorkerPool(runner as never, [task1], 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledTimes(2);
    expect(runner.claimNextTasks).toHaveBeenCalled();
  });

  it('should respect concurrency limit', async () => {
    // Given: 4 tasks, concurrency=2
    const tasks = Array.from({ length: 4 }, (_, i) => createTask(`task-${i}`));

    let activeCount = 0;
    let maxActive = 0;

    mockExecuteAndCompleteTask.mockImplementation(() => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      return new Promise((resolve) => {
        setTimeout(() => {
          activeCount--;
          resolve(true);
        }, 20);
      });
    });

    const runner = createMockTaskRunner([]);

    // When
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then: Never exceeded concurrency of 2
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(mockExecuteAndCompleteTask).toHaveBeenCalledTimes(4);
  });

  it('should pass abortSignal to all parallel tasks', async () => {
    // Given: Multiple tasks in parallel mode
    const tasks = [createTask('task-1'), createTask('task-2'), createTask('task-3')];
    const runner = createMockTaskRunner([]);

    const receivedSignals: (AbortSignal | undefined)[] = [];
    mockExecuteAndCompleteTask.mockImplementation((_task, _runner, _cwd, _piece, _opts, parallelOpts) => {
      receivedSignals.push(parallelOpts?.abortSignal);
      return Promise.resolve(true);
    });

    // When
    await runWithWorkerPool(runner as never, tasks, 3, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then: All tasks received the same AbortSignal
    expect(receivedSignals).toHaveLength(3);
    const firstSignal = receivedSignals[0];
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    for (const signal of receivedSignals) {
      expect(signal).toBe(firstSignal);
    }
  });

  it('should handle empty initial tasks', async () => {
    // Given: No tasks
    const runner = createMockTaskRunner([]);

    // When
    const result = await runWithWorkerPool(runner as never, [], 2, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then
    expect(result).toEqual({ success: 0, fail: 0 });
    expect(mockExecuteAndCompleteTask).not.toHaveBeenCalled();
  });

  it('should handle task promise rejection gracefully', async () => {
    // Given: Task that throws
    const tasks = [createTask('throws')];
    mockExecuteAndCompleteTask.mockRejectedValue(new Error('boom'));
    const runner = createMockTaskRunner([]);

    // When
    const result = await runWithWorkerPool(runner as never, tasks, 1, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS);

    // Then: Treated as failure
    expect(result).toEqual({ success: 0, fail: 1 });
  });

  describe('polling', () => {
    it('should pick up tasks added during execution via polling', async () => {
      // Given: 1 initial task running with concurrency=2, a second task appears via poll
      const task1 = createTask('initial');
      const task2 = createTask('added-later');

      const executionOrder: string[] = [];

      mockExecuteAndCompleteTask.mockImplementation((task: TaskInfo) => {
        executionOrder.push(`start:${task.name}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end:${task.name}`);
            resolve(true);
          }, 80);
        });
      });

      let claimCallCount = 0;
      const runner = {
        getNextTask: vi.fn(() => null),
        claimNextTasks: vi.fn(() => {
          claimCallCount++;
          // Return the new task on the second call (triggered by polling)
          if (claimCallCount === 2) return [task2];
          return [];
        }),
        completeTask: vi.fn(),
        failTask: vi.fn(),
      };

      // When: pollIntervalMs=30 so polling fires before task1 completes (80ms)
      const result = await runWithWorkerPool(
        runner as never, [task1], 2, '/cwd', 'default', undefined, 30,
      );

      // Then: Both tasks were executed
      expect(result).toEqual({ success: 2, fail: 0 });
      expect(executionOrder).toContain('start:initial');
      expect(executionOrder).toContain('start:added-later');
      // task2 started before task1 ended (picked up by polling, not by task completion)
      const task2Start = executionOrder.indexOf('start:added-later');
      const task1End = executionOrder.indexOf('end:initial');
      expect(task2Start).toBeLessThan(task1End);
    });

    it('should work correctly with concurrency=1 (sequential behavior preserved)', async () => {
      // Given: concurrency=1, tasks claimed sequentially
      const task1 = createTask('seq-1');
      const task2 = createTask('seq-2');

      const executionOrder: string[] = [];
      mockExecuteAndCompleteTask.mockImplementation((task: TaskInfo) => {
        executionOrder.push(`start:${task.name}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end:${task.name}`);
            resolve(true);
          }, 20);
        });
      });

      const runner = createMockTaskRunner([[task2]]);

      // When
      const result = await runWithWorkerPool(
        runner as never, [task1], 1, '/cwd', 'default', undefined, TEST_POLL_INTERVAL_MS,
      );

      // Then: Tasks executed sequentially — task2 starts after task1 ends
      expect(result).toEqual({ success: 2, fail: 0 });
      const task2Start = executionOrder.indexOf('start:seq-2');
      const task1End = executionOrder.indexOf('end:seq-1');
      expect(task2Start).toBeGreaterThan(task1End);
    });

    it('should not leak poll timer when task completes before poll fires', async () => {
      // Given: A task that completes in 200ms, poll interval is 5000ms
      const task1 = createTask('fast-task');

      mockExecuteAndCompleteTask.mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(true), 200);
        });
      });

      const runner = createMockTaskRunner([]);

      // When: Task completes before poll timer fires; cancel() cleans up timer
      const result = await runWithWorkerPool(
        runner as never, [task1], 1, '/cwd', 'default', undefined, 5000,
      );

      // Then: Result is returned without hanging (timer was cleaned up by cancel())
      expect(result).toEqual({ success: 1, fail: 0 });
    });
  });
});
