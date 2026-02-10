/**
 * Integration test: SIGINT handler in executePiece().
 *
 * Verifies that:
 * - First Ctrl+C calls interruptAllQueries() AND engine.abort()
 * - EPIPE errors from SDK are suppressed during interrupt
 * - The piece execution terminates with abort status
 * - QueryRegistry correctly interrupts active queries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { QueryRegistry } from '../infra/claude/query-manager.js';

// --- Hoisted mocks (must be before vi.mock calls) ---

const { mockInterruptAllQueries, MockPieceEngine } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockInterruptAllQueries = vi.fn().mockReturnValue(0);

  // Create a mock PieceEngine class that simulates long-running execution
  class MockPieceEngine extends EE {
    private abortRequested = false;
    private runResolve: ((value: { status: string; iteration: number }) => void) | null = null;

    constructor(
      _config: unknown,
      _cwd: string,
      _task: string,
      _options: unknown,
    ) {
      super();
    }

    abort(): void {
      this.abortRequested = true;
      // When abort is called, emit piece:abort and resolve run()
      const state = { status: 'aborted', iteration: 1 };
      this.emit('piece:abort', state, 'user_interrupted');
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
        // Simulate starting first movement
        // The engine stays "running" until abort() is called
      });
    }
  }

  return { mockInterruptAllQueries, MockPieceEngine };
});

// --- Module mocks ---

vi.mock('../core/piece/index.js', () => ({
  PieceEngine: MockPieceEngine,
}));

vi.mock('../infra/claude/index.js', () => ({
  callAiJudge: vi.fn(),
  detectRuleIndex: vi.fn(),
  interruptAllQueries: mockInterruptAllQueries,
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  loadGlobalConfig: vi.fn().mockReturnValue({ provider: 'claude' }),
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
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, _status) => ({
    ...log,
    status: _status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
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
    writePromptLog: vi.fn(),
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

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import type { PieceConfig } from '../core/models/index.js';

// --- Tests ---

describe('executePiece: SIGINT handler integration', () => {
  let tmpDir: string;
  let savedSigintListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    vi.clearAllMocks();
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

  function makeConfig(): PieceConfig {
    return {
      name: 'test-sigint',
      maxIterations: 10,
      initialMovement: 'step1',
      movements: [
        {
          name: 'step1',
          persona: '../agents/coder.md',
          personaDisplayName: 'coder',
          instructionTemplate: 'Do something',
          passPreviousResponse: true,
          rules: [
            { condition: 'done', next: 'COMPLETE' },
            { condition: 'fail', next: 'ABORT' },
          ],
        },
      ],
    };
  }

  it('should call interruptAllQueries() on first SIGINT', async () => {
    const config = makeConfig();

    // Start piece execution (engine.run() will block until abort() is called)
    const resultPromise = executePiece(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    // Wait for SIGINT handler to be registered
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Find the SIGINT handler added by executePiece
    const allListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    const newListener = allListeners.find((l) => !savedSigintListeners.includes(l));
    expect(newListener).toBeDefined();

    // Simulate SIGINT
    newListener!();

    // Wait for piece to complete
    const result = await resultPromise;

    // Verify interruptAllQueries was called (twice: SIGINT handler + piece:abort handler)
    expect(mockInterruptAllQueries).toHaveBeenCalledTimes(2);

    // Verify abort result
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

    const resultPromise = executePiece(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const allListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    const newListener = allListeners.find((l) => !savedSigintListeners.includes(l));
    newListener!();

    await resultPromise;

    // EPIPE handler should have been registered before interruptAllQueries was called
    expect(callOrder).toContain('interrupt_with_epipe_handler');
  });

  it('should clean up EPIPE handler after execution completes', async () => {
    const config = makeConfig();

    const resultPromise = executePiece(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const allListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    const newListener = allListeners.find((l) => !savedSigintListeners.includes(l));
    newListener!();

    await resultPromise;

    // After executePiece completes, the EPIPE handler should be removed
    // (The finally block calls process.removeListener('uncaughtException', onEpipe))
    // Note: we remove all in afterEach, so check before cleanup
    const uncaughtListeners = process.rawListeners('uncaughtException');
    // The onEpipe handler should have been removed by the finally block
    expect(uncaughtListeners.length).toBe(0);
  });

  it('should suppress EPIPE errors during interrupt', async () => {
    const config = makeConfig();

    const resultPromise = executePiece(config, 'test task', tmpDir, {
      projectCwd: tmpDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const allListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    const newListener = allListeners.find((l) => !savedSigintListeners.includes(l));

    // Simulate SIGINT
    newListener!();

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
