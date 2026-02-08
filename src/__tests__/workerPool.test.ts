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

const mockExecuteAndCompleteTask = vi.fn();

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { info } from '../shared/ui/index.js';

const mockInfo = vi.mocked(info);

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
    const result = await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default');

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
    const result = await runWithWorkerPool(runner as never, tasks, 3, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, tasks, 1, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, [task1], 2, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, tasks, 2, '/cwd', 'default');

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
    await runWithWorkerPool(runner as never, tasks, 3, '/cwd', 'default');

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
    const result = await runWithWorkerPool(runner as never, [], 2, '/cwd', 'default');

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
    const result = await runWithWorkerPool(runner as never, tasks, 1, '/cwd', 'default');

    // Then: Treated as failure
    expect(result).toEqual({ success: 0, fail: 1 });
  });
});
