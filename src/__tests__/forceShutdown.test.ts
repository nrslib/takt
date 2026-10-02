import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preparePoolForForcedShutdown } = vi.hoisted(() => ({
  preparePoolForForcedShutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock('../infra/opencode/server-pool.js', () => ({
  prepareSharedServerPoolForForcedShutdown: preparePoolForForcedShutdown,
}));

async function getForceExitAfterOpenCodeCleanup(): Promise<
  typeof import('../features/tasks/execute/forceShutdown.js').forceExitAfterOpenCodeCleanup
> {
  const module = await import('../features/tasks/execute/forceShutdown.js');
  return module.forceExitAfterOpenCodeCleanup;
}

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

describe('forceExitAfterOpenCodeCleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    preparePoolForForcedShutdown.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for OpenCode resource cleanup before exiting with SIGINT status', async () => {
    const events: string[] = [];
    preparePoolForForcedShutdown.mockImplementation(async () => {
      events.push('cleanup');
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      events.push(`exit:${code}`);
      return undefined as never;
    }) as never);

    const forceExitAfterOpenCodeCleanup = await getForceExitAfterOpenCodeCleanup();
    await forceExitAfterOpenCodeCleanup();

    expect(events).toEqual(['cleanup', 'exit:130']);
  });

  it('does not exit when an OpenCode server stop cannot be confirmed', async () => {
    preparePoolForForcedShutdown.mockRejectedValueOnce(new Error('server stop not confirmed'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const forceExitAfterOpenCodeCleanup = await getForceExitAfterOpenCodeCleanup();
    await forceExitAfterOpenCodeCleanup();

    expect(exit).not.toHaveBeenCalled();
  });

  it('shares duplicate forced exit requests and exits only after cleanup completes', async () => {
    const cleanup = deferred<void>();
    preparePoolForForcedShutdown.mockReturnValueOnce(cleanup.promise);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const forceExitAfterOpenCodeCleanup = await getForceExitAfterOpenCodeCleanup();

    const firstRequest = forceExitAfterOpenCodeCleanup();
    const duplicateRequest = forceExitAfterOpenCodeCleanup();

    expect(preparePoolForForcedShutdown).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    await expectPromisePending(firstRequest);
    await expectPromisePending(duplicateRequest);

    cleanup.resolve();
    await Promise.all([firstRequest, duplicateRequest]);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
  });
});
