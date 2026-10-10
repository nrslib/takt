import { EventEmitter } from 'node:events';
import type { Instance } from 'ink';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountInk } from '../features/tui/inkMount.js';
import { KITTY_KEYBOARD_DISABLE, KITTY_KEYBOARD_ENABLE } from '../features/tui/keyProtocol.js';
import type { TerminalOwnership } from '../features/tui/terminalOwnership.js';

const { mockRender, mockTakeTerminalOwnership } = vi.hoisted(() => ({
  mockRender: vi.fn<typeof import('ink').render>(),
  mockTakeTerminalOwnership: vi.fn<() => TerminalOwnership>(),
}));

vi.mock('ink', () => ({ render: mockRender }));
vi.mock('../features/tui/terminalOwnership.js', () => ({
  takeTerminalOwnership: mockTakeTerminalOwnership,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInkDouble(listeners: EventEmitter, completeExitOnUnmount: boolean) {
  const exit = deferred<void>();
  const unmounted = deferred<void>();
  let isUnmounted = false;
  let beforeExitHandler: (() => void) | undefined;
  const unmount = vi.fn(() => {
    if (isUnmounted) return;
    isUnmounted = true;
    if (beforeExitHandler) {
      listeners.off('beforeExit', beforeExitHandler);
      beforeExitHandler = undefined;
    }
    unmounted.resolve();
    if (completeExitOnUnmount) exit.resolve();
  });
  const instance: Instance = {
    rerender: vi.fn(),
    cleanup: unmount,
    clear: vi.fn(),
    unmount,
    waitUntilRenderFlush: vi.fn(async () => undefined),
    // Ink 7.1.1 registers again after unmount cleared its handler, even though
    // the exit promise is already settled and another unmount does nothing.
    waitUntilExit: async () => {
      if (!beforeExitHandler) {
        beforeExitHandler = () => unmount();
        listeners.once('beforeExit', beforeExitHandler);
      }
      return exit.promise;
    },
  };
  return { instance, exit, unmounted: unmounted.promise };
}

describe('mountInk', () => {
  beforeEach(() => {
    mockRender.mockReset();
    mockTakeTerminalOwnership.mockReset();
    const stdout = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
    const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
    mockTakeTerminalOwnership.mockReturnValue({ stdout, stderr, release: vi.fn() });
    vi.spyOn(process.stdin, 'isPaused').mockReturnValue(false);
    vi.spyOn(process.stdin, 'ref').mockReturnValue(process.stdin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([0, 1])(
    'should restore listeners without warnings over twelve mounts with %i existing listeners',
    async (existingCount) => {
      const listeners = new EventEmitter();
      const existingListener = vi.fn();
      if (existingCount === 1) listeners.on('beforeExit', existingListener);
      const baseline = listeners.listenerCount('beforeExit');
      const limit = listeners.getMaxListeners();
      const emitterSetMaxListeners = vi.spyOn(listeners, 'setMaxListeners');
      const processSetMaxListeners = vi.spyOn(process, 'setMaxListeners');
      const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const mountedCounts: number[] = [];
      const completedCounts: number[] = [];
      mockRender.mockImplementation(() => createInkDouble(listeners, true).instance);

      for (let cycle = 0; cycle < 12; cycle += 1) {
        let settle!: (value: number) => void;
        const run = mountInk<number>((handlers) => {
          settle = handlers.settle;
          return createElement('test-view');
        }, 'view exited early');
        mountedCounts.push(listeners.listenerCount('beforeExit'));
        settle(cycle);
        await run;
        completedCounts.push(listeners.listenerCount('beforeExit'));
      }

      const listenerWarnings = emitWarning.mock.calls.map(([warning]) => warning)
        .filter((warning) => warning instanceof Error && warning.name === 'MaxListenersExceededWarning');
      expect.soft(listenerWarnings).toEqual([]);
      expect.soft(mountedCounts).toEqual(Array.from({ length: 12 }, () => baseline + 1));
      expect.soft(completedCounts).toEqual(Array.from({ length: 12 }, () => baseline));
      expect.soft(listeners.getMaxListeners()).toBe(limit);
      expect.soft(emitterSetMaxListeners).not.toHaveBeenCalled();
      expect.soft(processSetMaxListeners).not.toHaveBeenCalled();
      listeners.emit('beforeExit');
      expect(existingListener).toHaveBeenCalledTimes(existingCount);
    },
  );

  it('should return the value supplied by the view', async () => {
    const ink = createInkDouble(new EventEmitter(), true);
    mockRender.mockReturnValue(ink.instance);
    const result = { action: 'continue', task: 'next task' };

    const run = mountInk((handlers) => {
      handlers.settle(result);
      return createElement('test-view');
    }, 'view exited early');

    await expect(run).resolves.toEqual(result);
  });

  it('should remove its listener and propagate a view failure', async () => {
    const listeners = new EventEmitter();
    const ink = createInkDouble(listeners, true);
    mockRender.mockReturnValue(ink.instance);
    const failure = new Error('view failed');

    const run = mountInk((handlers) => {
      handlers.fail(failure);
      return createElement('test-view');
    }, 'view exited early');

    await expect(run).rejects.toBe(failure);
    expect(listeners.listenerCount('beforeExit')).toBe(0);
  });

  it('should remove its listener and reject when Ink exits before the view settles', async () => {
    const listeners = new EventEmitter();
    const ink = createInkDouble(listeners, true);
    mockRender.mockReturnValue(ink.instance);
    const run = mountInk(() => createElement('test-view'), 'view exited early');
    const rejection = expect(run).rejects.toThrow('view exited early');

    ink.instance.unmount();

    await rejection;
    expect(listeners.listenerCount('beforeExit')).toBe(0);
  });

  it('should remove its listener and propagate an exit rejection before the view settles', async () => {
    const listeners = new EventEmitter();
    const ink = createInkDouble(listeners, false);
    mockRender.mockReturnValue(ink.instance);
    const failure = new Error('Ink exit failed');
    const run = mountInk(() => createElement('test-view'), 'view exited early');
    const rejection = expect(run).rejects.toBe(failure);

    ink.instance.unmount();
    ink.exit.reject(failure);

    await rejection;
    expect(listeners.listenerCount('beforeExit')).toBe(0);
  });

  it('should flush and unmount before waiting for exit and returning the terminal', async () => {
    const ink = createInkDouble(new EventEmitter(), false);
    const flush = deferred<void>();
    ink.instance.waitUntilRenderFlush = vi.fn(() => flush.promise);
    mockRender.mockReturnValue(ink.instance);
    const terminal = mockTakeTerminalOwnership();
    const guard = { attach: vi.fn(), detach: vi.fn() };
    const inputRef = vi.spyOn(process.stdin, 'ref');
    vi.stubGlobal('process', new Proxy(process, {
      get(target, key) {
        if (key === 'stdin') return new Proxy(target.stdin, {
          get(input, property) {
            return property === 'isTTY' ? true : Reflect.get(input, property);
          },
        });
        return Reflect.get(target, key);
      },
    }));
    const run = mountInk((handlers) => {
      handlers.settle('done');
      return createElement('test-view');
    }, 'view exited early', guard);

    await vi.waitFor(() => expect(ink.instance.waitUntilRenderFlush).toHaveBeenCalled());
    expect(ink.instance.clear).not.toHaveBeenCalled();
    expect(ink.instance.unmount).not.toHaveBeenCalled();
    expect(terminal.release).not.toHaveBeenCalled();

    flush.resolve();
    await ink.unmounted;
    // Let the teardown awaiting unmount advance to the separate exit barrier.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ink.instance.clear).toHaveBeenCalledBefore(vi.mocked(ink.instance.unmount));
    expect(terminal.stdout.write).toHaveBeenCalledWith(KITTY_KEYBOARD_ENABLE);
    expect(terminal.stdout.write).not.toHaveBeenCalledWith(KITTY_KEYBOARD_DISABLE);
    expect(inputRef).not.toHaveBeenCalled();
    expect(guard.detach).not.toHaveBeenCalled();
    expect(terminal.release).not.toHaveBeenCalled();

    ink.exit.resolve();
    await expect(run).resolves.toBe('done');
    expect(terminal.stdout.write).toHaveBeenCalledWith(KITTY_KEYBOARD_DISABLE);
    expect(inputRef).toHaveBeenCalled();
    expect(guard.detach).toHaveBeenCalledBefore(vi.mocked(terminal.release));
    expect(terminal.release).toHaveBeenCalledOnce();
  });

  it('should propagate an exit rejection after the view settles and still return the terminal', async () => {
    const ink = createInkDouble(new EventEmitter(), false);
    mockRender.mockReturnValue(ink.instance);
    const terminal = mockTakeTerminalOwnership();
    const run = mountInk((handlers) => {
      handlers.settle('done');
      return createElement('test-view');
    }, 'view exited early');
    const failure = new Error('exit flush failed');
    const rejection = expect(run).rejects.toBe(failure);

    await ink.unmounted;
    expect(terminal.release).not.toHaveBeenCalled();
    ink.exit.reject(failure);

    await rejection;
    expect(terminal.release).toHaveBeenCalledOnce();
  });
});
