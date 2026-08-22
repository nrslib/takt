/**
 * Integration test: SIGINT handler in executeWorkflow().
 *
 * Verifies that:
 * - First Ctrl+C calls interruptAllQueries() AND engine.abort()
 * - EPIPE errors from SDK are suppressed during interrupt
 * - The workflow execution terminates with abort status
 * - QueryRegistry correctly interrupts active queries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { QueryRegistry } from '../infra/claude/query-manager.js';

// --- Hoisted mocks (must be before vi.mock calls) ---

const { disabledObservability, mockInterruptAllQueries, MockWorkflowEngine } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockInterruptAllQueries = vi.fn().mockReturnValue(0);

  // Create a mock WorkflowEngine class that simulates long-running execution
  class MockWorkflowEngine extends EE {
    private abortRequested = false;
    private runResolve: ((value: { status: string; iteration: number }) => void) | null = null;
    static lastOptions: { abortSignal?: AbortSignal } | null = null;

    constructor(
      _config: unknown,
      _cwd: string,
      _task: string,
      options: unknown,
    ) {
      super();
      if (options && typeof options === 'object') {
        MockWorkflowEngine.lastOptions = options as { abortSignal?: AbortSignal };
      }
    }

    abort(): void {
      this.abortRequested = true;
      // When abort is called, emit workflow:abort and resolve run()
      const state = { status: 'aborted', iteration: 1 };
      this.emit('workflow:abort', state, 'user_interrupted', 'interrupt', {
        kind: 'interrupt',
        step: 'step1',
        reason: 'user_interrupted',
        error: 'user_interrupted',
      });
      if (this.runResolve) {
        this.runResolve(state);
        this.runResolve = null;
      }
    }

    isAbortRequested(): boolean {
      return this.abortRequested;
    }

    async run(): Promise<{ status: string; iteration: number }> {
      return new Promise((resolve) => {
        this.runResolve = resolve;
        // Simulate starting the first step
        // The engine stays "running" until abort() is called
      });
    }
  }

  return {
    disabledObservability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
    mockInterruptAllQueries,
    MockWorkflowEngine,
  };
});

// --- Module mocks ---

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
    WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../features/tasks/execute/workflowRunLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/tasks/execute/workflowRunLifecycle.js')
  >();
  const { createWorkflowRunLifecycleCompositionTestDouble } = await import(
    './helpers/run-lifecycle.js'
  );
  return {
    ...actual,
    createWorkflowRunLifecycle: (
      input: Parameters<typeof actual.createWorkflowRunLifecycle>[0],
    ) => createWorkflowRunLifecycleCompositionTestDouble(
      actual.createWorkflowRunLifecycle,
      input,
      {
        sessionId: 'test-session-id',
        startedAt: '2026-02-07T00:00:00.000Z',
        projectTerminalArtifacts: false,
      },
    ),
  };
});

vi.mock('../infra/claude/query-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  interruptAllQueries: mockInterruptAllQueries,
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  loadGlobalConfig: vi.fn().mockReturnValue({ provider: 'claude' }),
  loadProjectConfig: vi.fn(() => ({})),
  loadConfig: vi.fn().mockReturnValue({
    global: { provider: 'claude' },
    project: {},
  }),
  resolveWorkflowConfigValues: (_projectDir: string, keys: readonly string[]) => {
    const config: Record<string, unknown> = {
      provider: 'claude',
      workflow: 'default',
      verbose: false,
      observability: disabledObservability,
    };
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = config[key];
    }
    return result;
  },
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockImplementation((
    task,
    projectDir,
    workflowName,
    options,
  ) => ({
    task,
    projectDir,
    workflowName,
    startTime: options.startTime,
    iterations: 0,
    status: 'running',
    history: [],
  })),
  finalizeSessionLog: vi.fn().mockImplementation((log, _status) => ({
    ...log,
    status: _status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn((
    sessionId: string,
    _task: string,
    _workflowName: string,
    options: { logsDir: string },
  ) => join(options.logsDir, `${sessionId}.jsonl`)),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    playWarningSound: vi.fn(),
    preventSleep: vi.fn(),
    isDebugEnabled: vi.fn().mockReturnValue(false),
    generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
    isValidReportDirName: vi.fn().mockImplementation((value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
  };
});

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

// --- Import under test (after mocks) ---

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

async function waitForSigintListener(
  savedListeners: readonly ((...args: unknown[]) => void)[],
): Promise<(...args: unknown[]) => void> {
  let listener: ((...args: unknown[]) => void) | undefined;
  await vi.waitFor(() => {
    listener = (
      process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[]
    ).find((candidate) => !savedListeners.includes(candidate));
    expect(listener).toBeDefined();
  });
  if (!listener) {
    throw new Error('Workflow SIGINT listener was not registered');
  }
  return listener;
}

// --- Tests ---

describe('executeWorkflow: SIGINT handler integration', () => {
  let tmpDir: string;
  let savedSigintListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    vi.clearAllMocks();
    MockWorkflowEngine.lastOptions = null;
    tmpDir = join(tmpdir(), `takt-sigint-it-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, '.takt', 'reports'), { recursive: true });

    // Save current SIGINT listeners to restore after each test
    savedSigintListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // Remove all SIGINT listeners, then restore originals
    process.removeAllListeners('SIGINT');
    for (const listener of savedSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }

    // Clean up any uncaughtException listeners from EPIPE handler
    process.removeAllListeners('uncaughtException');
  });

  function makeConfig(): WorkflowConfig {
    return {
      name: 'test-sigint',
      maxSteps: 10,
      initialStep: 'step1',
      steps: [
        {
          name: 'step1',
          persona: '../agents/coder.md',
          personaDisplayName: 'coder',
          instruction: 'Do something',
          passPreviousResponse: true,
          rules: [
            normalizeRule({ condition: 'done', next: 'COMPLETE' }),
            normalizeRule({ condition: 'fail', next: 'ABORT' }),
          ],
        },
      ],
    };
  }

  it('should call interruptAllQueries() on first SIGINT', async () => {
    const config = makeConfig();

    // Start workflow execution (engine.run() will block until abort() is called)
    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);

    // Simulate SIGINT
    newListener();

    // Wait for workflow to complete
    const result = await resultPromise;

    // Verify interruptAllQueries was called (twice: SIGINT handler + workflow:abort handler)
    expect(mockInterruptAllQueries).toHaveBeenCalledTimes(2);

    // Verify abort result
    expect(result.success).toBe(false);
  });

  it('should abort provider signal on first SIGINT', async () => {
    const config = makeConfig();

    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);

    const signal = MockWorkflowEngine.lastOptions?.abortSignal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    newListener();

    expect(signal!.aborted).toBe(true);

    const result = await resultPromise;
    expect(result.success).toBe(false);
  });

  it('should register EPIPE handler before calling interruptAllQueries', async () => {
    const config = makeConfig();

    // Track the order of operations
    const callOrder: string[] = [];

    // Override mock to record call order
    mockInterruptAllQueries.mockImplementation(() => {
      // At this point, uncaughtException handler should already be registered
      const hasEpipeHandler = process.listenerCount('uncaughtException') > 0;
      callOrder.push(hasEpipeHandler ? 'interrupt_with_epipe_handler' : 'interrupt_without_epipe_handler');
      return 0;
    });

    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);
    newListener();

    await resultPromise;

    // EPIPE handler should have been registered before interruptAllQueries was called
    expect(callOrder).toContain('interrupt_with_epipe_handler');
  });

  it('should clean up EPIPE handler after execution completes', async () => {
    const config = makeConfig();

    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);
    newListener();

    await resultPromise;

    // After executeWorkflow completes, the EPIPE handler should be removed
    // (The finally block calls process.removeListener('uncaughtException', onEpipe))
    // Note: we remove all in afterEach, so check before cleanup
    const uncaughtListeners = process.rawListeners('uncaughtException');
    // The onEpipe handler should have been removed by the finally block
    expect(uncaughtListeners.length).toBe(0);
  });

  it('should suppress EPIPE errors during interrupt', async () => {
    const config = makeConfig();

    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);

    // Simulate SIGINT
    newListener();

    // After SIGINT, EPIPE handler should be active
    const uncaughtListeners = process.rawListeners('uncaughtException') as ((err: Error) => void)[];
    expect(uncaughtListeners.length).toBeGreaterThan(0);

    // Simulate EPIPE error — should be suppressed (not thrown)
    const epipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => uncaughtListeners[0]!(epipeError)).not.toThrow();

    // Non-EPIPE errors should still throw
    const otherError = Object.assign(new Error('other error'), { code: 'ENOENT' });
    expect(() => uncaughtListeners[0]!(otherError)).toThrow('other error');

    await resultPromise;
  });

  it('Given a run is cancelled by SIGINT, When abort artifacts are finalized, Then analysis is scheduled once', async () => {
    const config = makeConfig();
    const loopAnalysisScheduler = vi.fn();
    const resultPromise = executeWorkflow(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
      loopAnalysisScheduler,
    });

    const newListener = await waitForSigintListener(savedSigintListeners);
    newListener();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(loopAnalysisScheduler).toHaveBeenCalledOnce();
    expect(loopAnalysisScheduler).toHaveBeenCalledWith(
      join(tmpDir, '.takt', 'runs', 'test-report-dir'),
    );
  });
});

describe('QueryRegistry: interruptAllQueries', () => {
  beforeEach(() => {
    QueryRegistry.resetInstance();
  });

  it('should interrupt all registered queries', () => {
    const registry = QueryRegistry.getInstance();
    const mockInterrupt1 = vi.fn();
    const mockInterrupt2 = vi.fn();

    registry.registerQuery('q1', { interrupt: mockInterrupt1 } as never);
    registry.registerQuery('q2', { interrupt: mockInterrupt2 } as never);

    expect(registry.getActiveQueryCount()).toBe(2);

    const count = registry.interruptAllQueries();

    expect(count).toBe(2);
    expect(mockInterrupt1).toHaveBeenCalledOnce();
    expect(mockInterrupt2).toHaveBeenCalledOnce();
    expect(registry.getActiveQueryCount()).toBe(0);
  });

  it('should return 0 when no queries are active', () => {
    const registry = QueryRegistry.getInstance();

    const count = registry.interruptAllQueries();

    expect(count).toBe(0);
  });

  it('should be idempotent — second call returns 0', () => {
    const registry = QueryRegistry.getInstance();
    const mockInterrupt = vi.fn();

    registry.registerQuery('q1', { interrupt: mockInterrupt } as never);
    registry.interruptAllQueries();

    const count = registry.interruptAllQueries();
    expect(count).toBe(0);
    expect(mockInterrupt).toHaveBeenCalledOnce();
  });

  it('should catch EPIPE rejection from interrupt()', async () => {
    const registry = QueryRegistry.getInstance();
    const mockInterrupt = vi.fn().mockRejectedValue(new Error('write EPIPE'));

    registry.registerQuery('q1', { interrupt: mockInterrupt } as never);

    // Should not throw despite interrupt() rejecting
    const count = registry.interruptAllQueries();
    expect(count).toBe(1);
    expect(mockInterrupt).toHaveBeenCalledOnce();

    // Wait for the async rejection to be caught
    await new Promise((resolve) => setTimeout(resolve, 10));
    // If the catch didn't work, vitest would report an unhandled rejection
  });
});
