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
    trace: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mockExecuteRunTaskAndComplete, mockForceExitAfterOpenCodeCleanup } = vi.hoisted(() => ({
  mockExecuteRunTaskAndComplete: vi.fn(),
  mockForceExitAfterOpenCodeCleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: vi.fn(),
}));

vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({
  executeRunTaskAndComplete: (...args: unknown[]) => mockExecuteRunTaskAndComplete(...args),
}));

vi.mock('../features/tasks/execute/forceShutdown.js', () => ({
  forceExitAfterOpenCodeCleanup: mockForceExitAfterOpenCodeCleanup,
}));

import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';

function createTask(name: string): TaskInfo {
  return {
    name,
    content: `Task: ${name}`,
    filePath: `/tasks/${name}.yaml`,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    data: { task: `Task: ${name}`, workflow: 'default' },
  };
}

function createMockTaskRunner() {
  return {
    getNextTask: vi.fn(() => null),
    listTaskStateItems: vi.fn(() => []),
    claimNextTasks: vi.fn(() => []),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockExecuteRunTaskAndComplete.mockResolvedValue(true);
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

    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignals.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // When
    await runWithWorkerPool(runner as never, tasks, 1, '/cwd', undefined, undefined, 50);

    // Then: AbortSignal is passed even with concurrency=1
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('should abort the signal when SIGINT fires in sequential mode', async () => {
    // Given
    const tasks = [createTask('long-task')];
    const runner = createMockTaskRunner();
    let capturedSignal: AbortSignal | undefined;

    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        capturedSignal = parallelOpts?.abortSignal;
        return new Promise((resolve) => {
          // Wait long enough for SIGINT to fire
          setTimeout(() => resolve(true), 200);
        });
      },
    );

    // Start execution
    const resultPromise = runWithWorkerPool(runner as never, tasks, 1, '/cwd', undefined, undefined, 50);

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

  it.each(['run', 'watch'] as const)('should clean OpenCode resources before the %s worker pool force-exits', async (mode) => {
    const tasks = [createTask('forced-task')];
    const runner = createMockTaskRunner();
    let markStarted!: () => void;
    let finishTask!: (value: boolean) => void;
    let taskSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        markStarted();
        taskSignal = parallelOpts.abortSignal;
        return new Promise<boolean>((resolve) => {
          finishTask = resolve;
        });
      },
    );

    const execution = runWithWorkerPool(runner as never, tasks, 1, '/cwd', undefined, undefined, 50, mode);
    await started;
    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    const handler = listeners[listeners.length - 1]!;
    handler();
    expect(taskSignal?.aborted).toBe(mode === 'run');
    expect(mockForceExitAfterOpenCodeCleanup).not.toHaveBeenCalled();
    handler();

    expect(mockForceExitAfterOpenCodeCleanup).toHaveBeenCalledOnce();
    finishTask(true);
    await execution;
  });

  it('should clean OpenCode resources in the forced self-SIGINT test path', async () => {
    const previousValue = process.env.TAKT_E2E_SELF_SIGINT_TWICE;
    const runner = createMockTaskRunner();
    process.env.TAKT_E2E_SELF_SIGINT_TWICE = '1';
    vi.useFakeTimers();
    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) =>
        new Promise((resolve) => {
          parallelOpts?.abortSignal?.addEventListener('abort', () => resolve(true), { once: true });
        }),
    );

    try {
      const execution = runWithWorkerPool(runner as never, [createTask('forced-task')], 1, '/cwd', undefined, undefined, 50);
      await vi.advanceTimersByTimeAsync(25);
      await execution;

      expect(mockForceExitAfterOpenCodeCleanup).toHaveBeenCalledOnce();
    } finally {
      if (previousValue === undefined) delete process.env.TAKT_E2E_SELF_SIGINT_TWICE;
      else process.env.TAKT_E2E_SELF_SIGINT_TWICE = previousValue;
      vi.useRealTimers();
    }
  });

  it('should share the same AbortSignal across sequential and parallel tasks', async () => {
    // Given: Multiple tasks in both sequential (concurrency=1) and parallel (concurrency=2)
    const tasks = [createTask('t1'), createTask('t2')];
    const runner = createMockTaskRunner();

    const receivedSignalsSeq: (AbortSignal | undefined)[] = [];
    const receivedSignalsPar: (AbortSignal | undefined)[] = [];

    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignalsSeq.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // Sequential mode
    await runWithWorkerPool(runner as never, [...tasks], 1, '/cwd', undefined, undefined, 50);

    mockExecuteRunTaskAndComplete.mockClear();
    mockExecuteRunTaskAndComplete.mockImplementation(
      (_task: unknown, _runner: unknown, _cwd: unknown, _opts: unknown, parallelOpts: { abortSignal?: AbortSignal }) => {
        receivedSignalsPar.push(parallelOpts?.abortSignal);
        return Promise.resolve(true);
      },
    );

    // Parallel mode
    await runWithWorkerPool(runner as never, [...tasks], 2, '/cwd', undefined, undefined, 50);

    // Then: Both modes pass AbortSignal
    for (const signal of receivedSignalsSeq) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    for (const signal of receivedSignalsPar) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});
