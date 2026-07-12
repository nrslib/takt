import { describe, it, expect, vi, beforeEach } from 'vitest';

class MockEventStream implements AsyncGenerator<unknown, void, unknown> {
  private index = 0;
  private readonly events: unknown[];
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(events: unknown[]) {
    this.events = events;
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    if (this.index >= this.events.length) {
      return { done: true, value: undefined };
    }
    const value = this.events[this.index];
    this.index += 1;
    return { done: false, value };
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    return this.returnSpy();
  }

  async throw(e?: unknown): Promise<IteratorResult<unknown, void>> {
    throw e;
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

describe('OpenCodeClient session queue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  it('should run two new sessions (no sessionId) concurrently', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-concurrent-1' } })
      .mockResolvedValueOnce({ data: { id: 'session-concurrent-2' } });
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    let subCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subCount += 1;
      const sid = subCount === 1 ? 'session-concurrent-1' : 'session-concurrent-2';
      return Promise.resolve({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sid } },
        ]),
      });
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'task1', { cwd: '/tmp', model: 'opencode/test-model' });
    const call2 = client.call('coder', 'task2', { cwd: '/tmp', model: 'opencode/test-model' });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();
    secondPrompt.resolve();
    const [r1, r2] = await Promise.all([call1, call2]);
    expect(r1.status).toBe('done');
    expect(r2.status).toBe('done');
  });

  it('should run two calls with different sessionIds in parallel', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const promptAsync = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const sessionCreate = vi.fn();
    let subCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subCount += 1;
      return Promise.resolve({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: `session-diff-${subCount}` } },
        ]),
      });
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'first', { cwd: '/tmp', model: 'opencode/test-model', sessionId: 'session-diff-a' });
    const call2 = client.call('coder', 'second', { cwd: '/tmp', model: 'opencode/test-model', sessionId: 'session-diff-b' });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    expect(sessionCreate).not.toHaveBeenCalled();
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
  });

  it('should serialize same-session calls in FIFO order', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const sessionId = 'fifo-session';
    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    let callCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? firstPrompt.promise : secondPrompt.promise;
    });
    const sessionCreate = vi.fn();
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'first', { cwd: '/tmp', model: 'opencode/test-model', sessionId });
    const call2 = client.call('coder', 'second', { cwd: '/tmp', model: 'opencode/test-model', sessionId });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    expect(sessionCreate).not.toHaveBeenCalled();

    firstPrompt.resolve();
    await call1;

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve();
    await call2;
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it('should release queue after normal completion, allowing subsequent same-session call', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const sessionId = 'release-normal-session';
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn();
    let subCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subCount++;
      return Promise.resolve({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sessionId } },
        ]),
      });
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'first', { cwd: '/tmp', model: 'opencode/test-model', sessionId });
    const call2 = client.call('coder', 'second', { cwd: '/tmp', model: 'opencode/test-model', sessionId });

    const result1 = await call1;
    expect(result1.status).toBe('done');

    const result2 = await call2;
    expect(result2.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should release queue after error, allowing subsequent same-session call', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const sessionId = 'release-error-session';
    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    let callCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('first call failed'));
      return secondPrompt.promise;
    });
    const sessionCreate = vi.fn();
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'first', { cwd: '/tmp', model: 'opencode/test-model', sessionId });
    const call2 = client.call('coder', 'second', { cwd: '/tmp', model: 'opencode/test-model', sessionId });

    const result1 = await call1;
    expect(result1.status).toBe('error');

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve();
    const result2 = await call2;
    expect(result2.status).toBe('done');
  });

  it('should release queue after abort, allowing subsequent same-session call', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const sessionId = 'release-abort-session';
    const abortController = new AbortController();
    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);
    const sessionCreate = vi.fn();
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'first', {
      cwd: '/tmp', model: 'opencode/test-model', sessionId,
      abortSignal: abortController.signal,
    });
    const call2 = client.call('coder', 'second', {
      cwd: '/tmp', model: 'opencode/test-model', sessionId,
    });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    abortController.abort();
    const result1 = await call1;
    expect(result1.status).toBe('error');

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve();
    const result2 = await call2;
    expect(result2.status).toBe('done');
  });

  it('should use acquired session ID as queue key on retry', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const retryHeld = deferred<void>();
    const call2Held = deferred<void>();
    const sessionCreate = vi.fn()
      .mockResolvedValue({ data: { id: 'session-retry-key' } });

    let promptCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      promptCount++;
      if (promptCount === 1) return Promise.reject(new Error('transport error'));
      if (promptCount === 2) return retryHeld.promise;
      return call2Held.promise;
    });
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: 'session-retry-key' } },
      ]),
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const call1 = client.call('coder', 'task1', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });
    expect(sessionCreate).toHaveBeenCalledTimes(1);

    const call2 = client.call('coder', 'task2', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-retry-key',
    });

    // Yield to microtask queue; call2 must NOT start promptAsync
    // while retry is still pending — otherwise the queue key didn't switch.
    await new Promise(resolve => setImmediate(resolve));
    expect(promptAsync).toHaveBeenCalledTimes(2);

    retryHeld.resolve();
    const result1 = await call1;
    expect(result1.status).toBe('done');

    // Yield to microtask queue; after retry completes, call2 should start.
    await new Promise(resolve => setImmediate(resolve));
    expect(promptAsync).toHaveBeenCalledTimes(3);

    call2Held.resolve();
    const result2 = await call2;
    expect(result2.status).toBe('done');

    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });
});
