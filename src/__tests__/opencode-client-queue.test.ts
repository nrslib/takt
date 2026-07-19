import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentResponse } from '../core/models/response.js';

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

const ASYNC_START_TIMEOUT_MS = 5_000;

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
    }, { timeout: ASYNC_START_TIMEOUT_MS });

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

    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    let promptCallCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      promptCallCount++;
      return promptCallCount === 1 ? firstPrompt.promise : secondPrompt.promise;
    });
    const sessionCreate = vi.fn();
    const subscribe = vi.fn().mockImplementation(() => Promise.resolve({
      // event.subscribe は共有サーバのバスを返す。各呼び出しは自分の
      // sessionID のイベントだけを採用するため、両方を同じ順序で流す。
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: 'session-diff-a' } },
        { type: 'session.idle', properties: { sessionID: 'session-diff-b' } },
      ]),
    }));

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
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    expect(sessionCreate).not.toHaveBeenCalled();
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();
    secondPrompt.resolve();
    const [r1, r2] = await Promise.all([call1, call2]);
    expect(r1.status).toBe('done');
    expect(r2.status).toBe('done');
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
    const subscribe = vi.fn().mockImplementation(() => Promise.resolve({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    }));

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
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    expect(sessionCreate).not.toHaveBeenCalled();

    firstPrompt.resolve();
    await call1;

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

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
    const subscribe = vi.fn().mockImplementation(() => Promise.resolve({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    }));

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
    }, { timeout: ASYNC_START_TIMEOUT_MS });

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
    const subscribe = vi.fn().mockImplementation(() => Promise.resolve({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: sessionId } },
      ]),
    }));

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
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    abortController.abort();
    const result1 = await call1;
    expect(result1.status).toBe('error');

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    secondPrompt.resolve();
    const result2 = await call2;
    expect(result2.status).toBe('done');
  });

  it('should create new session on each retry when no explicit sessionId', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-retry-1' } })
      .mockResolvedValueOnce({ data: { id: 'session-retry-2' } });
    let promptCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      promptCount++;
      if (promptCount === 1) return Promise.reject(new Error('transport error'));
      return Promise.resolve(undefined);
    });
    let subCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subCount++;
      const sid = subCount === 1 ? 'session-retry-1' : 'session-retry-2';
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
    const result = await client.call('coder', 'task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[0][0].sessionID).toBe('session-retry-1');
    expect(promptAsync.mock.calls[1][0].sessionID).toBe('session-retry-2');
    expect(promptAsync.mock.calls[0][0].sessionID).not.toBe(promptAsync.mock.calls[1][0].sessionID);
  });

  it('should queue second call started from init behind the first (same session follow-up)', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    const SID = 'session-init-followup';
    const sessionCreate = vi.fn().mockResolvedValueOnce({ data: { id: SID } });
    let promptCallCount = 0;
    const promptAsync = vi.fn().mockImplementation(() => {
      promptCallCount++;
      return promptCallCount === 1 ? firstPrompt.promise : secondPrompt.promise;
    });
    const subscribe = vi.fn().mockImplementation(() => Promise.resolve({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: SID } },
      ]),
    }));

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

    let call2Promise: Promise<AgentResponse> | undefined;
    const ac2 = new AbortController();
    const registerAbortSpy = vi.spyOn(ac2.signal, 'addEventListener');
    const onStream = vi.fn((event) => {
      if (event.type === 'init' && event.data.sessionId === SID) {
        call2Promise = client.call('coder', 'second', {
          cwd: '/tmp',
          model: 'opencode/test-model',
          sessionId: SID,
          abortSignal: ac2.signal,
        });
      }
    });

    const call1 = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/test-model',
      onStream,
    });

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptCallCount).toBe(1);

    await vi.waitFor(() => {
      expect(call2Promise).toBeDefined();
      expect(registerAbortSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    expect(registerAbortSpy.mock.calls[1]).toEqual([
      'abort',
      expect.any(Function),
      { once: true },
    ]);

    expect(promptCallCount).toBe(1);

    firstPrompt.resolve();

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    expect(promptAsync.mock.calls[0][0].sessionID).toBe(SID);
    expect(promptAsync.mock.calls[1][0].sessionID).toBe(SID);

    secondPrompt.resolve();

    const [r1, r2] = await Promise.all([call1, call2Promise!]);
    expect(r1.status).toBe('done');
    expect(r2.status).toBe('done');
  });

  it('should queue a fresh-session follow-up started from stale-resume recovery init', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');

    const recoveredPrompt = deferred<void>();
    const followUpPrompt = deferred<void>();
    const resumedSessionId = 'session-stale-resume';
    const recoveredSessionId = 'session-recovered-from-resume';
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: recoveredSessionId } });
    const promptAsync = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => recoveredPrompt.promise)
      .mockImplementationOnce(() => followUpPrompt.promise);
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'stale-tool-1',
                sessionID: resumedSessionId,
                type: 'tool',
                callID: 'stale-call-1',
                tool: 'StructuredOutput',
                state: {
                  status: 'error',
                  input: {},
                  error: "Model tried to call unavailable tool 'StructuredOutput'. Available tools: bash, read.",
                },
              },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'stale-tool-2',
                sessionID: resumedSessionId,
                type: 'tool',
                callID: 'stale-call-2',
                tool: 'StructuredOutput',
                state: {
                  status: 'error',
                  input: {},
                  error: "Model tried to call unavailable tool 'StructuredOutput'. Available tools: bash, read.",
                },
              },
            },
          },
        ]),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: recoveredSessionId } },
        ]),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: recoveredSessionId } },
        ]),
      });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: vi.fn().mockResolvedValue({ data: true }) },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    let followUpCall: Promise<AgentResponse> | undefined;
    const recoveredCall = client.call('reviewer', 'recover stale resume', {
      cwd: '/tmp',
      model: 'opencode/test-model',
      sessionId: resumedSessionId,
      onStream: (event) => {
        if (event.type === 'init' && event.data.sessionId === recoveredSessionId) {
          followUpCall = client.call('reviewer', 'follow up', {
            cwd: '/tmp',
            model: 'opencode/test-model',
            sessionId: recoveredSessionId,
          });
        }
      },
    });

    await vi.waitFor(() => {
      expect(sessionCreate).toHaveBeenCalledTimes(1);
      expect(followUpCall).toBeDefined();
      expect(promptAsync).toHaveBeenCalledTimes(2);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    recoveredPrompt.resolve();

    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(3);
    }, { timeout: ASYNC_START_TIMEOUT_MS });

    followUpPrompt.resolve();
    const [recoveredResult, followUpResult] = await Promise.all([recoveredCall, followUpCall!]);
    expect(recoveredResult).toMatchObject({ status: 'done', sessionId: recoveredSessionId });
    expect(followUpResult).toMatchObject({ status: 'done', sessionId: recoveredSessionId });
  });
});
