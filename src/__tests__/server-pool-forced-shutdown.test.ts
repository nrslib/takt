import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanupPendingSessionsMock, startServerMock } = vi.hoisted(() => ({
  cleanupPendingSessionsMock: vi.fn<() => Promise<void>>(),
  startServerMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => ({
    unref: vi.fn(),
    on: vi.fn(),
    listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    address: vi.fn(() => ({ port: 62000 })),
    close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
  }),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn(() => ''),
}));

vi.mock('../infra/opencode/model-selection-session-cleanup.js', () => ({
  cleanupPendingModelSelectionSessions: cleanupPendingSessionsMock,
}));

vi.mock('../infra/opencode/runtime.js', () => ({
  openCodeRuntimeSelection: vi.fn(() => ({ generation: 'v1', command: 'opencode' })),
  resolveOpenCodeRuntime: vi.fn(async () => ({ generation: 'v1', command: 'opencode', version: '1.18.2' })),
}));

vi.mock('../infra/opencode/server-process.js', () => ({
  startOpenCodeServer: startServerMock,
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

async function loadServerPool(): Promise<typeof import('../infra/opencode/server-pool.js')> {
  return import('../infra/opencode/server-pool.js');
}

function serverStartResult(close: () => Promise<void> = async () => undefined) {
  return {
    client: { sdkState: { directory: '/test/managed/opencode', stale: false } },
    close,
    onError: vi.fn(() => () => undefined),
  };
}

describe('OpenCode server pool forced shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    cleanupPendingSessionsMock.mockReset().mockResolvedValue(undefined);
    startServerMock.mockReset();
  });

  it('waits for a workspace acquisition probing model metadata before completing owner cleanup', async () => {
    const { acquireOpenCodeClient, closeOpenCodeWorkspaceServers } = await loadServerPool();
    const outputLimit = deferred<number>();
    const probing = deferred<void>();
    const probeClose = vi.fn(async () => undefined);
    const workspaceClose = vi.fn(async () => undefined);
    startServerMock.mockResolvedValueOnce({ ...serverStartResult(probeClose), client: {
      sdkState: { directory: '/test/managed/opencode', stale: false },
      getModelOutputLimit: async () => { probing.resolve(); return outputLimit.promise; },
    } }).mockResolvedValueOnce(serverStartResult(workspaceClose));
    const acquisition = acquireOpenCodeClient('probe/model', undefined, undefined, undefined,
      'workspace-session', undefined, false, undefined, undefined, 32000, '/tmp',
      { ownerId: 'probing-manager', directories: ['/tmp'] });
    await probing.promise;
    const closing = closeOpenCodeWorkspaceServers('probing-manager');
    await expectPromisePending(closing);
    outputLimit.resolve(4096);
    const acquired = await acquisition;
    expect(probeClose).toHaveBeenCalledOnce();
    expect(workspaceClose).not.toHaveBeenCalled();
    await expectPromisePending(closing);
    acquired.release();
    await closing;
    expect(workspaceClose).toHaveBeenCalledOnce();
  });

  it('waits for temporary-session cleanup and child exit and shares overlapping shutdown requests', async () => {
    const cleanup = deferred<void>();
    const childExit = deferred<void>();
    const closeStarted = deferred<void>();
    cleanupPendingSessionsMock.mockReturnValue(cleanup.promise);
    const close = vi.fn(() => {
      closeStarted.resolve();
      return childExit.promise;
    });
    startServerMock.mockResolvedValue(serverStartResult(close));
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();

    await acquireOpenCodeClient('opencode/model', undefined, undefined);
    const shutdown = prepareSharedServerPoolForForcedShutdown();
    const duplicateShutdown = prepareSharedServerPoolForForcedShutdown();

    expect(cleanupPendingSessionsMock).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await expectPromisePending(shutdown);
    await expectPromisePending(duplicateShutdown);

    cleanup.resolve();
    await closeStarted.promise;
    await expectPromisePending(shutdown);
    await expectPromisePending(duplicateShutdown);
    childExit.resolve();
    await Promise.all([shutdown, duplicateShutdown]);

    expect(close).toHaveBeenCalledOnce();
  });

  it('tracks server initialization that is already in flight and rejects new acquisitions', async () => {
    const startStarted = deferred<void>();
    const finishStart = deferred<void>();
    const childExit = deferred<void>();
    const closeStarted = deferred<void>();
    const close = vi.fn(() => {
      closeStarted.resolve();
      return childExit.promise;
    });
    startServerMock.mockImplementation(async () => {
      startStarted.resolve();
      await finishStart.promise;
      return serverStartResult(close);
    });
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();

    const acquisition = acquireOpenCodeClient('opencode/model', undefined, undefined)
      .catch((error: unknown) => error);
    await startStarted.promise;
    const shutdown = prepareSharedServerPoolForForcedShutdown();

    await expectPromisePending(shutdown);
    await expect(acquireOpenCodeClient('opencode/other', undefined, undefined))
      .rejects.toThrow('pool is shutting down');

    finishStart.resolve();
    await closeStarted.promise;
    await expect(acquisition).resolves.toMatchObject({ message: 'OpenCode shared server pool is shutting down' });
    await expectPromisePending(shutdown);
    childExit.resolve();
    await shutdown;

    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight v1 output probe to close before shutdown completes', async () => {
    const lookupStarted = deferred<void>();
    const output = deferred<number>();
    const childExit = deferred<void>();
    const closeStarted = deferred<void>();
    const close = vi.fn(() => {
      closeStarted.resolve();
      return childExit.promise;
    });
    startServerMock.mockResolvedValue({
      ...serverStartResult(close),
      client: {
        sdkState: { directory: '/test/managed/opencode', stale: false },
        getModelOutputLimit: vi.fn(() => {
          lookupStarted.resolve();
          return output.promise;
        }),
      },
    });
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();
    const acquisition = acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/project',
    ).catch((error: unknown) => error);
    await lookupStarted.promise;
    const shutdown = prepareSharedServerPoolForForcedShutdown();
    await expectPromisePending(shutdown);
    output.resolve(32_000);
    await closeStarted.promise;
    await expectPromisePending(shutdown);
    childExit.resolve();
    await shutdown;
    await expect(acquisition).resolves.toMatchObject({ message: 'OpenCode shared server pool is shutting down' });
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a v1 probe stop failure during forced shutdown', async () => {
    const stopFailure = Object.assign(new Error('v1 probe child did not stop'), { name: 'OpenCodeServerStopError' });
    const close = vi.fn().mockRejectedValue(stopFailure);
    startServerMock.mockResolvedValue({
      ...serverStartResult(close),
      client: {
        sdkState: { directory: '/test/managed/opencode', stale: false },
        getModelOutputLimit: vi.fn(async () => 32_000),
      },
    });
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();
    await expect(acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/project',
    )).rejects.toBe(stopFailure);
    const shutdown = await prepareSharedServerPoolForForcedShutdown().catch((error: unknown) => error);
    expect(shutdown).toBeInstanceOf(AggregateError);
    expect((shutdown as AggregateError).errors).toContain(stopFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for an invalidated server that was removed from the lookup map', async () => {
    const childExit = deferred<void>();
    const closeStarted = deferred<void>();
    const close = vi.fn(() => {
      closeStarted.resolve();
      return childExit.promise;
    });
    startServerMock.mockResolvedValue(serverStartResult(close));
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();

    const acquired = await acquireOpenCodeClient('opencode/model', undefined, undefined);
    acquired.invalidate(new Error('server invalidated'));
    await closeStarted.promise;
    const shutdown = prepareSharedServerPoolForForcedShutdown();

    await expectPromisePending(shutdown);
    childExit.resolve();
    await shutdown;

    expect(close).toHaveBeenCalledOnce();
  });

  it('aggregates a server stop failure so forced shutdown cannot treat it as success', async () => {
    const stopFailure = new Error('child process stop was not confirmed');
    const close = vi.fn().mockRejectedValue(stopFailure);
    startServerMock.mockResolvedValue(serverStartResult(close));
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();

    await acquireOpenCodeClient('opencode/model', undefined, undefined);
    const shutdown = await prepareSharedServerPoolForForcedShutdown().catch((error: unknown) => error);

    expect(shutdown).toBeInstanceOf(AggregateError);
    expect((shutdown as AggregateError).errors).toContain(stopFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('still stops owned servers if temporary-session cleanup fails', async () => {
    cleanupPendingSessionsMock.mockRejectedValueOnce(new Error('session cleanup failed'));
    const close = vi.fn(async () => undefined);
    startServerMock.mockResolvedValue(serverStartResult(close));
    const { acquireOpenCodeClient, prepareSharedServerPoolForForcedShutdown } = await loadServerPool();

    await acquireOpenCodeClient('opencode/model', undefined, undefined);
    await expect(prepareSharedServerPoolForForcedShutdown()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
  });
});
