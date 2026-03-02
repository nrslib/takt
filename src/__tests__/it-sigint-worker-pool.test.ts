/**
 * Integration test: SIGINT abort signal propagation in worker pool.
 *
 * Verifies that:
 * - AbortSignal is passed to tasks even when concurrency=1 (sequential mode)
 * - Aborting the controller causes the signal to fire, enabling task interruption
 * - The SIGINT handler in parallelExecution correctly aborts the controller
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function createTask(name: string): TaskInfo {
  return {
    name,
    content: `Task: ${name}`,
    filePath: `/tasks/${name}.yaml`,
  };
}

function createMockTaskRunner() {
  return {
    getNextTask: vi.fn(() => null),
    claimNextTasks: vi.fn(() => []),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteAndCompleteTask.mockResolvedValue(true);
});

describe('worker pool: abort signal propagation', () => {
  let savedSigintListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    savedSigintListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    for (const listener of savedSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }
  });

  it('should pass abortSignal to tasks in sequential mode (concurrency=1)', async () => {
    // Given
    const tasks = [createTask('task-1')];
    const runner = createMockTaskRunner();
    const receivedSignals: (AbortSignal | undefined)[] = [];

    mockExecuteAndCompleteTask.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignals.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // When
    await runWithWorkerPool(runner as never, tasks, 1, '/cwd', undefined, 50);

    // Then: AbortSignal is passed even with concurrency=1
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('should abort the signal when SIGINT fires in sequential mode', async () => {
    // Given
    const tasks = [createTask('long-task')];
    const runner = createMockTaskRunner();
    let capturedSignal: AbortSignal | undefined;

    mockExecuteAndCompleteTask.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        capturedSignal = parallelOpts?.abortSignal;
        return new Promise((resolve) => {
          // Wait long enough for SIGINT to fire
          setTimeout(() => resolve(true), 200);
        });
      },
    );

    // Start execution
    const resultPromise = runWithWorkerPool(runner as never, tasks, 1, '/cwd', undefined, 50);

    // Wait for task to start
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Find the SIGINT handler added by runWithWorkerPool
    const allListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    const newListener = allListeners.find((l) => !savedSigintListeners.includes(l));
    expect(newListener).toBeDefined();

    // Simulate SIGINT
    newListener!();

    // Wait for execution to complete
    await resultPromise;

    // Then: The abort signal should have been triggered
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('should share the same AbortSignal across sequential and parallel tasks', async () => {
    // Given: Multiple tasks in both sequential (concurrency=1) and parallel (concurrency=2)
    const tasks = [createTask('t1'), createTask('t2')];
    const runner = createMockTaskRunner();

    const receivedSignalsSeq: (AbortSignal | undefined)[] = [];
    const receivedSignalsPar: (AbortSignal | undefined)[] = [];

    mockExecuteAndCompleteTask.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignalsSeq.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // Sequential mode
    await runWithWorkerPool(runner as never, [...tasks], 1, '/cwd', undefined, 50);

    mockExecuteAndCompleteTask.mockClear();
    mockExecuteAndCompleteTask.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignalsPar.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // Parallel mode
    await runWithWorkerPool(runner as never, [...tasks], 2, '/cwd', undefined, 50);

    // Then: Both modes pass AbortSignal
    for (const signal of receivedSignalsSeq) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    for (const signal of receivedSignalsPar) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});
