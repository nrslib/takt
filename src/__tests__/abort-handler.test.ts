import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';

const mocks = vi.hoisted(() => ({
  interruptAllQueries: vi.fn(),
  installShutdown: vi.fn(),
  cleanupShutdown: vi.fn(),
  shutdownCallbacks: undefined as {
    onGraceful: () => void;
    onForceKill: () => void;
  } | undefined,
}));

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: mocks.interruptAllQueries,
}));

vi.mock('../features/tasks/execute/shutdownManager.js', () => ({
  ShutdownManager: class {
    constructor(options: { callbacks: { onGraceful: () => void; onForceKill: () => void } }) {
      mocks.shutdownCallbacks = options.callbacks;
    }

    install(): void {
      mocks.installShutdown();
    }

    cleanup(): void {
      mocks.cleanupShutdown();
    }
  },
}));

import { AbortHandler } from '../features/tasks/execute/abortHandler.js';

function mockEngine(): { engine: WorkflowEngine; abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn();
  return {
    engine: { abort } as unknown as WorkflowEngine,
    abort,
  };
}

describe('AbortHandler', () => {
  let handler: AbortHandler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shutdownCallbacks = undefined;
    handler = undefined;
  });

  afterEach(() => {
    handler?.cleanup();
  });

  it('外部AbortSignalではengine.abortを呼ばず外部中断原因を維持する', () => {
    const externalController = new AbortController();
    const internalController = new AbortController();
    const { engine, abort } = mockEngine();
    handler = new AbortHandler({
      externalSignal: externalController.signal,
      internalController,
      getEngine: () => engine,
    });
    handler.install();

    externalController.abort(new Error('orchestrator timeout'));

    expect(internalController.signal.aborted).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    expect(mocks.interruptAllQueries).toHaveBeenCalledOnce();
  });

  it('SIGINTではengine.abortを呼びユーザー中断として通知する', () => {
    const internalController = new AbortController();
    const { engine, abort } = mockEngine();
    handler = new AbortHandler({
      internalController,
      getEngine: () => engine,
    });
    handler.install();

    expect(mocks.shutdownCallbacks).toBeDefined();
    mocks.shutdownCallbacks!.onGraceful();

    expect(internalController.signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(mocks.interruptAllQueries).toHaveBeenCalledOnce();
  });
});
