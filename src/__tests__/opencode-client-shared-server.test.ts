import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/index.js';
import { createOpenCodeServerStartMock } from './helpers/opencode-server-process-test-helpers.js';
import {
  MockEventStream,
  deferred,
  sessionIdle,
  successfulSessionAbort,
  unavailableToolErrorEvent,
} from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock, streamDiagnostics } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  streamDiagnostics: [] as Array<{
    onConnected: ReturnType<typeof vi.fn>;
    onCompleted: ReturnType<typeof vi.fn>;
  }>,
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

vi.mock('../infra/opencode/server-process.js', () => ({
  startOpenCodeServer: createOpenCodeServerStartMock(createOpencodeMock),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createStreamDiagnostics: vi.fn((component: string, diagnosticContext: Record<string, unknown>) => {
      const diagnostics = actual.createStreamDiagnostics(component, diagnosticContext);
      const onConnected = vi.fn(diagnostics.onConnected);
      const onCompleted = vi.fn(diagnostics.onCompleted);
      streamDiagnostics.push({ onConnected, onCompleted });
      return { ...diagnostics, onConnected, onCompleted };
    }),
  };
});

describe('OpenCodeClient shared server', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    streamDiagnostics.splice(0);
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  it('should discard a server invalidated while its error listener is registered', async () => {
    const {
      acquireOpenCodeClient,
      OpenCodeSharedServerInvalidationError,
      resetSharedServerPool,
    } = await import('../infra/opencode/server-pool.js');
    const startupRuntimeError = new Error('server failed before listener registration');
    const firstServerClose = vi.fn();
    const secondServerClose = vi.fn();
    const secondClient = {};

    createOpencodeMock
      .mockResolvedValueOnce({
        client: {},
        server: {
          close: firstServerClose,
          onError: (listener: (error: Error) => void) => {
            listener(startupRuntimeError);
            return () => {};
          },
        },
      })
      .mockResolvedValueOnce({
        client: secondClient,
        server: { close: secondServerClose },
      });

    await expect(acquireOpenCodeClient('opencode/model', undefined, undefined))
      .rejects.toBeInstanceOf(OpenCodeSharedServerInvalidationError);

    const acquired = await acquireOpenCodeClient('opencode/model', undefined, undefined);

    expect(acquired.client).toBe(secondClient);
    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    acquired.release();
    resetSharedServerPool();
    expect(firstServerClose).toHaveBeenCalledOnce();
    expect(secondServerClose).toHaveBeenCalledOnce();
  });

  it('should release the shared OpenCode client once when session.create returns no id', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    let finishSecondPrompt!: () => void;
    const secondPrompt = new Promise<void>((resolve) => { finishSecondPrompt = resolve; });
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => secondPrompt)
      .mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { id: 'session-after-create-failure-2' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-create-failure-3' } });
    let subscribeCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscribeCount++;
      const sessionId = subscribeCount === 1
        ? 'session-after-create-failure-2'
        : 'session-after-create-failure-3';
      return Promise.resolve({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sessionId } },
        ], sessionId),
      });
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const failedPromise = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    const secondPromise = client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    const thirdPromise = client.call('coder', 'third', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    const failed = await failedPromise;

    expect(failed.status).toBe('error');
    expect(failed.content).toContain('Failed to create OpenCode session');
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    // With provisional keys, all 3 calls create sessions concurrently
    expect(sessionCreate).toHaveBeenCalledTimes(3);

    finishSecondPrompt!();
    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(second.status).toBe('done');
    expect(third.status).toBe('done');
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should keep the existing server open when model changes', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-1' } })
      .mockResolvedValueOnce({ data: { id: 'session-2' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const serverClose1 = vi.fn();
    const serverClose2 = vi.fn();

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-1' } }], 'session-1') }) },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose1 },
    }).mockResolvedValueOnce({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-2' } }], 'session-2') }) },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose2 },
    });

    const client = new OpenCodeClient();

    const result1 = await client.call('coder', 'task1', { cwd: '/tmp', model: 'opencode/model-a' });
    const result2 = await client.call('coder', 'task2', { cwd: '/tmp', model: 'opencode/model-b' });

    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(serverClose1).not.toHaveBeenCalled();
    expect(serverClose2).not.toHaveBeenCalled();
    expect(result1.status).toBe('done');
    expect(result2.status).toBe('done');
  });

  it('should log server close failures during shared server reset', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const serverClose = vi.fn(() => {
      throw new Error('close failed');
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-close-failure' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([
              { type: 'session.idle', properties: { sessionID: 'session-close-failure' } },
            ], 'session-close-failure'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      setVerboseConsole(true);
      const client = new OpenCodeClient();
      const result = await client.call('coder', 'task', { cwd: '/tmp', model: 'opencode/model-a' });
      expect(result.status).toBe('done');

      resetSharedServer();

      const stderrOutput = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(serverClose).toHaveBeenCalledTimes(1);
      expect(stderrOutput).toContain('[opencode-sdk] Failed to close OpenCode server: close failed');
    } finally {
      stderrSpy.mockRestore();
      resetDebugLogger();
    }
  });

  it('should run different model configs concurrently without closing active servers', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const firstPrompt = deferred();
    const firstServerClose = vi.fn();
    const secondServerClose = vi.fn();
    const firstPromptAsync = vi.fn().mockImplementation(() => firstPrompt.promise);
    const secondPromptAsync = vi.fn().mockResolvedValue(undefined);

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-model-a' } }),
          promptAsync: firstPromptAsync,
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-model-a' } }], 'session-model-a'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: firstServerClose },
    }).mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-model-b' } }),
          promptAsync: secondPromptAsync,
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-model-b' } }], 'session-model-b'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: secondServerClose },
    });

    const client = new OpenCodeClient();
    const firstCall = client.call('coder', 'task1', { cwd: '/tmp', model: 'opencode/model-a' });
    await vi.waitFor(() => {
      expect(firstPromptAsync).toHaveBeenCalledTimes(1);
    });

    const secondResult = await client.call('coder', 'task2', { cwd: '/tmp', model: 'opencode/model-b' });

    expect(secondResult.status).toBe('done');
    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(firstServerClose).not.toHaveBeenCalled();
    expect(secondServerClose).not.toHaveBeenCalled();

    firstPrompt.resolve();
    const firstResult = await firstCall;
    expect(firstResult.status).toBe('done');
  });

  it('should isolate concurrent calls that use different api keys', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const firstPrompt = deferred();
    const firstServerClose = vi.fn();
    const secondServerClose = vi.fn();
    const firstPromptAsync = vi.fn().mockImplementation(() => firstPrompt.promise);
    const secondPromptAsync = vi.fn().mockResolvedValue(undefined);

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-key-a' } }),
          promptAsync: firstPromptAsync,
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-key-a' } }], 'session-key-a'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: firstServerClose },
    }).mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-key-b' } }),
          promptAsync: secondPromptAsync,
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-key-b' } }], 'session-key-b'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: secondServerClose },
    });

    const client = new OpenCodeClient();
    const firstCall = client.call('coder', 'task1', {
      cwd: '/tmp',
      model: 'opencode/model-a',
      opencodeApiKey: 'key-a',
    });
    await vi.waitFor(() => {
      expect(firstPromptAsync).toHaveBeenCalledTimes(1);
    });

    const secondResult = await client.call('coder', 'task2', {
      cwd: '/tmp',
      model: 'opencode/model-a',
      opencodeApiKey: 'key-b',
    });

    expect(secondResult.status).toBe('done');
    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(firstServerClose).not.toHaveBeenCalled();
    expect(secondServerClose).not.toHaveBeenCalled();

    firstPrompt.resolve();
    const firstResult = await firstCall;
    expect(firstResult.status).toBe('done');
  });

  it('should not let an older release drain a newer server queue', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const promptA = deferred();
    const promptB1 = deferred();
    const promptB2 = deferred();
    const sharedSessionB = 'shared-session-b';
    const sessionCreateB = vi.fn();
    const promptAsyncB = vi.fn()
      .mockImplementationOnce(() => promptB1.promise)
      .mockImplementationOnce(() => promptB2.promise);

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-a' } }),
          promptAsync: vi.fn().mockImplementation(() => promptA.promise),
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-a' } }], 'session-a'),
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    }).mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: sessionCreateB,
          promptAsync: promptAsyncB,
          abort: successfulSessionAbort(),
        },
        event: {
          subscribe: vi.fn().mockImplementation(() => {
            return Promise.resolve({
              stream: new MockEventStream([
                { type: 'session.idle', properties: { sessionID: sharedSessionB } },
              ], sharedSessionB),
            });
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const callA = client.call('coder', 'task-a', { cwd: '/tmp', model: 'opencode/model-a' });
    await vi.waitFor(() => {
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    });

    const callB1 = client.call('coder', 'task-b-1', { cwd: '/tmp', model: 'opencode/model-b', sessionId: sharedSessionB });
    await vi.waitFor(() => {
      expect(promptAsyncB).toHaveBeenCalledTimes(1);
    });

    const callB2 = client.call('coder', 'task-b-2', { cwd: '/tmp', model: 'opencode/model-b', sessionId: sharedSessionB });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionCreateB).not.toHaveBeenCalled();
    expect(promptAsyncB).toHaveBeenCalledTimes(1);

    promptA.resolve();
    await callA;
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionCreateB).not.toHaveBeenCalled();
    expect(promptAsyncB).toHaveBeenCalledTimes(1);

    promptB1.resolve();
    await vi.waitFor(() => {
      expect(promptAsyncB).toHaveBeenCalledTimes(2);
    });
    promptB2.resolve();

    const [resultB1, resultB2] = await Promise.all([callB1, callB2]);
    expect(resultB1.status).toBe('done');
    expect(resultB2.status).toBe('done');
  });

  it('should not retry or release the lease until a deferred server-session abort succeeds', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const abortResult = deferred<{ data: true }>();
    const abort = vi.fn()
      .mockImplementationOnce(() => abortResult.promise)
      .mockResolvedValue({ data: true });
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-deferred-abort' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-deferred-abort' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
        ], 'session-deferred-abort'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          sessionIdle('session-deferred-abort'),
          sessionIdle('session-after-deferred-abort'),
        ], 'session-deferred-abort'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          sessionIdle('session-deferred-abort'),
          sessionIdle('session-after-deferred-abort'),
        ], 'session-after-deferred-abort'),
      });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const recoveringCall = client.call('coder', 'recover me', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);

    abortResult.resolve({ data: true });
    const recovered = await recoveringCall;

    expect(recovered.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should keep the production session-abort timeout fixed when interaction timeout is overridden', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const subscribe = vi.fn()
        .mockResolvedValueOnce({
          stream: new MockEventStream([
            unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
            unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
          ], 'session-fixed-abort-timeout'),
        })
        .mockResolvedValueOnce({
          stream: new MockEventStream([
            sessionIdle('session-fixed-abort-timeout'),
          ], 'session-fixed-abort-timeout'),
        });
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn() },
          session: {
            create: vi.fn().mockResolvedValue({ data: { id: 'session-fixed-abort-timeout' } }),
            promptAsync: vi.fn().mockResolvedValue(undefined),
            abort: successfulSessionAbort(),
          },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const result = await new OpenCodeClient().call('coder', 'recover me', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        interactionTimeoutMs: 17,
      });

      expect(result.status).toBe('done');
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each(['data-false', 'api-error', 'retryable-api-error'] as const)(
    'should invalidate the shared server and reject its queue when session abort fails via %s',
    async (mode) => {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const abortGate = deferred<{ data?: boolean }>();
      const abort = vi.fn().mockImplementation(() => abortGate.promise);
      const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-abort-failure' } });
      const promptAsync = vi.fn().mockResolvedValue(undefined);
      const subscribe = vi.fn().mockResolvedValue({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
        ], 'session-abort-failure'),
      });
      const serverClose = vi.fn();

      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn() },
          session: { create: sessionCreate, promptAsync, abort },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: serverClose },
      });

      const client = new OpenCodeClient();
      const queuedOnStream = vi.fn();
      const failingCall = client.call('coder', 'first', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: 'session-abort-failure',
        interactionTimeoutMs: 20,
      });
      while (promptAsync.mock.calls.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const queuedCall = client.call('coder', 'queued', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: 'session-abort-failure',
        interactionTimeoutMs: 20,
        onStream: queuedOnStream,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sessionCreate).not.toHaveBeenCalled();
      if (mode === 'data-false') {
        abortGate.resolve({ data: false });
      } else {
        const abortError = mode === 'retryable-api-error' ? 'fetch failed' : 'abort API unavailable';
        abortGate.reject(new Error(abortError));
      }

      const [failed, rejectedQueue] = await Promise.all([failingCall, queuedCall]);

      expect(failed.status).toBe('error');
      expect(failed.content).toContain('OpenCode server session abort failed');
      expect(rejectedQueue.status).toBe('error');
      expect(rejectedQueue.content).toContain('OpenCode server session abort failed');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(sessionCreate).not.toHaveBeenCalled();
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(serverClose).toHaveBeenCalledTimes(1);
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      const queuedDiagnostic = streamDiagnostics.find((diagnostic) => (
        diagnostic.onConnected.mock.calls.length === 0
      ));
      expect(queuedDiagnostic?.onCompleted).toHaveBeenCalledTimes(1);
      expect(queuedDiagnostic?.onCompleted).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('OpenCode server session abort failed'),
      );
      expect(queuedOnStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
        expect.objectContaining({
          type: 'result',
          data: expect.objectContaining({ success: false }),
        }),
      ]]);
    },
  );

  it('should fail active sibling and queued follow-up calls when a shared server is invalidated', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const abortGate = deferred<{ data?: boolean }>();
    const activeSiblingIdle = deferred<void>();
    const abort = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-invalidating'
          ? abortGate.promise
          : Promise.resolve({ data: true })
      ),
    );
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        return Promise.resolve({
          stream: (async function* () {
            await activeSiblingIdle.promise;
            yield sessionIdle('session-sibling');
          })(),
        });
      }
      return Promise.resolve({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
        ], 'session-invalidating'),
      });
    });
    const serverClose = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();
    const activeSibling = client.call('coder', 'active sibling', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-sibling',
    });
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1));

    const queuedFollowUp = client.call('coder', 'queued follow-up', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-sibling',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    const invalidatingCall = client.call('coder', 'invalidate server', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-invalidating',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    abortGate.resolve({ data: false });

    const [invalidatingResult, queuedResult] = await Promise.all([invalidatingCall, queuedFollowUp]);
    activeSiblingIdle.resolve();
    const activeResult = await activeSibling;

    for (const result of [invalidatingResult, queuedResult, activeResult]) {
      expect(result.status).toBe('error');
      expect(result.content).toContain('OpenCode server session abort failed');
    }
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(serverClose).toHaveBeenCalledTimes(1);
  });

  it('should finalize a completed call before releasing its same-session waiter', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sharedSessionId = 'session-linearized-release';
    const idleGate = deferred<void>();
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        return Promise.resolve({
          stream: (async function* () {
            await idleGate.promise;
            yield sessionIdle(sharedSessionId);
          })(),
        });
      }
      return Promise.resolve({
        stream: new MockEventStream([sessionIdle(sharedSessionId)], sharedSessionId),
      });
    });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const eventOrder: string[] = [];
    const waiterController = new AbortController();
    const originalRemoveEventListener = waiterController.signal.removeEventListener;
    let waiterAbortListenerRemoved = false;
    const removeEventListenerSpy = vi.spyOn(waiterController.signal, 'removeEventListener')
      .mockImplementation((...args: Parameters<AbortSignal['removeEventListener']>) => {
        if (args[0] === 'abort' && !waiterAbortListenerRemoved) {
          waiterAbortListenerRemoved = true;
          eventOrder.push('waiter-queue-listener-removed');
        }
        return originalRemoveEventListener.call(waiterController.signal, ...args);
      });

    try {
      const client = new OpenCodeClient();
      const completedCall = client.call('coder', 'first', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: sharedSessionId,
        onStream: (event) => {
          if (event.type === 'result') {
            eventOrder.push('first-result');
          }
        },
      });
      await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1));

      const waitingCall = client.call('coder', 'second', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: sharedSessionId,
        abortSignal: waiterController.signal,
      });
      idleGate.resolve();

      await expect(completedCall).resolves.toMatchObject({ status: 'done' });
      await expect(waitingCall).resolves.toMatchObject({ status: 'done' });
      expect(eventOrder).toEqual(['first-result', 'waiter-queue-listener-removed']);
    } finally {
      removeEventListenerSpy.mockRestore();
    }
  });

  it('should fail an active sibling invalidated after idle while prompt completion is pending', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const siblingPromptGate = deferred<void>();
    const abortGate = deferred<{ data?: boolean }>();
    const promptAsync = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-sibling-after-idle'
          ? siblingPromptGate.promise
          : Promise.resolve(undefined)
      ),
    );
    const abort = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-invalidating-after-idle'
          ? abortGate.promise
          : Promise.resolve({ data: true })
      ),
    );
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      return Promise.resolve({
        stream: subscriptionCount === 1
          ? new MockEventStream([sessionIdle('session-sibling-after-idle')], 'session-sibling-after-idle')
          : new MockEventStream([
              unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
              unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
            ], 'session-invalidating-after-idle'),
      });
    });
    const serverClose = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();
    const activeSibling = client.call('coder', 'wait after idle', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-sibling-after-idle',
    });
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1));

    const invalidatingCall = client.call('coder', 'invalidate server', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-invalidating-after-idle',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    abortGate.resolve({ data: false });
    await expect(invalidatingCall).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });

    siblingPromptGate.resolve();
    await expect(activeSibling).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
  });

  it('should not retry on a new server generation when invalidated during retry delay', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const invalidatingAbortGate = deferred<{ data?: boolean }>();
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-invalidating-during-delay'
          ? invalidatingAbortGate.promise
          : Promise.resolve({ data: true })
      ),
    );
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        return Promise.reject(new Error('fetch failed'));
      }
      return Promise.resolve({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
        ], 'session-invalidating-during-delay'),
      });
    });
    const serverClose = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();
    const retryingCall = client.call('coder', 'retry transient failure', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-retrying',
    });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const invalidatingCall = client.call('coder', 'invalidate during delay', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-invalidating-during-delay',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-invalidating-during-delay' }),
      expect.anything(),
    ));
    invalidatingAbortGate.resolve({ data: false });

    await expect(invalidatingCall).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });
    await expect(retryingCall).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(serverClose).toHaveBeenCalledTimes(1);
  });

  it('should fail success when invalidated during the final cleanup barrier', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const idleGate = deferred<void>();
    const invalidatingAbortGate = deferred<{ data?: boolean }>();
    let idleEmitted = false;
    const activeStream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<unknown, void>> {
        await idleGate.promise;
        if (idleEmitted) {
          return { done: true, value: undefined };
        }
        idleEmitted = true;
        return { done: false, value: sessionIdle('session-finalizing-success') };
      },
      return: vi.fn(() => {
        queueMicrotask(() => {
          queueMicrotask(() => invalidatingAbortGate.resolve({ data: false }));
        });
        return Promise.resolve({ done: true as const, value: undefined });
      }),
    };
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-invalidating-finalizer'
          ? invalidatingAbortGate.promise
          : Promise.resolve({ data: true })
      ),
    );
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      return Promise.resolve({
        stream: subscriptionCount === 1
          ? activeStream
          : new MockEventStream([
              unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
              unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
            ], 'session-invalidating-finalizer'),
      });
    });
    const serverClose = vi.fn();
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();
    const onStream = vi.fn();
    const finalizingCall = client.call('coder', 'finish successfully', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-finalizing-success',
      onStream,
    });
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1));
    const invalidatingCall = client.call('coder', 'invalidate finalizer', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-invalidating-finalizer',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    idleGate.resolve();

    await expect(invalidatingCall).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });
    await expect(finalizingCall).resolves.toMatchObject({
      status: 'error',
      content: expect.stringContaining('OpenCode server session abort failed'),
    });
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({ success: false }),
      }),
    ]]);
  });

  it('should not retry on a new server generation when invalidated during retry finalization', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const invalidatingAbortGate = deferred<{ data?: boolean }>();
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockImplementation(
      ({ sessionID }: { sessionID: string }) => (
        sessionID === 'session-invalidating-retry-finalizer'
          ? invalidatingAbortGate.promise
          : Promise.resolve({ data: true })
      ),
    );
    let subscriptionCount = 0;
    const subscribe = vi.fn().mockImplementation(() => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        return Promise.reject(new Error('fetch failed'));
      }
      return Promise.resolve({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
        ], 'session-invalidating-retry-finalizer'),
      });
    });
    const serverClose = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    let retryTimerWrapped = false;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 250 && !retryTimerWrapped) {
        retryTimerWrapped = true;
        return originalSetTimeout(() => {
          callback(...args);
          invalidatingAbortGate.resolve({ data: false });
        }, delay);
      }
      return originalSetTimeout(callback, delay, ...args);
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: vi.fn(), promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    try {
      const client = new OpenCodeClient();
      const onStream = vi.fn();
      const retryingCall = client.call('coder', 'retry transient failure', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: 'session-retrying-finalizer',
        onStream,
      });
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const invalidatingCall = client.call('coder', 'invalidate retry finalizer', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: 'session-invalidating-retry-finalizer',
      });
      await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));

      await expect(invalidatingCall).resolves.toMatchObject({
        status: 'error',
        content: expect.stringContaining('OpenCode server session abort failed'),
      });
      await expect(retryingCall).resolves.toMatchObject({
        status: 'error',
        content: expect.stringContaining('OpenCode server session abort failed'),
      });
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(serverClose).toHaveBeenCalledTimes(1);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
        expect.objectContaining({
          type: 'result',
          data: expect.objectContaining({ success: false }),
        }),
      ]]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('should not move a provisional lease to a new server generation after invalidation', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionCreateGate = deferred<{ data: { id: string } }>();
    const abortGate = deferred<{ data?: boolean }>();
    const sessionCreate = vi.fn().mockImplementation(() => sessionCreateGate.promise);
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockImplementation(() => abortGate.promise);
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
        unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
      ], 'session-invalidating-during-create'),
    });
    const serverClose = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();
    const freshCall = client.call('coder', 'create fresh session', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await vi.waitFor(() => expect(sessionCreate).toHaveBeenCalledTimes(1));

    const invalidatingCall = client.call('coder', 'invalidate during create', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-invalidating-during-create',
    });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    abortGate.resolve({ data: false });
    const invalidatingResult = await invalidatingCall;

    sessionCreateGate.resolve({ data: { id: 'session-created-on-invalidated-server' } });
    const freshResult = await freshCall;

    expect(invalidatingResult.status).toBe('error');
    expect(freshResult.status).toBe('error');
    expect(freshResult.content).toContain('OpenCode server session abort failed');
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
  });
});

describe('OpenCode conversation via provider (E2E)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  function makeClientMock(sessionId: string, responses: string[]) {
    let turnIndex = 0;
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
    const sessionUpdate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn().mockImplementation(() => {
      const text = responses[turnIndex] ?? '';
      const events: unknown[] = [];
      if (text) {
        events.push({
          type: 'message.part.updated',
          properties: { part: { id: `p-${turnIndex}`, sessionID: sessionId, type: 'text', text }, delta: text },
        });
      }
      events.push({ type: 'session.idle', properties: { sessionID: sessionId } });
      turnIndex += 1;
      return Promise.resolve({ stream: new MockEventStream(events, sessionId) });
    });
    return { sessionCreate, sessionUpdate, promptAsync, subscribe };
  }

  it('should carry sessionId across turns and reuse server', async () => {
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const { sessionCreate, sessionUpdate, promptAsync, subscribe } = makeClientMock('conv-session', [
      'Hello!',
      'I remember our conversation.',
    ]);

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder', systemPrompt: 'You are a helpful assistant.' });

    // 1ターン目
    const result1 = await agent.call('Hi', { cwd: '/tmp', model: 'opencode/big-pickle' });
    expect(result1.status).toBe('done');
    expect(result1.content).toBe('Hello!');
    expect(result1.sessionId).toBe('conv-session');

    // 2ターン目: conversationLoop と同様に前ターンの sessionId を引き継ぐ
    const result2 = await agent.call('Do you remember me?', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: result1.sessionId,
    });
    expect(result2.status).toBe('done');
    expect(result2.content).toBe('I remember our conversation.');
    expect(result2.sessionId).toBe('conv-session');

    // サーバーは1回だけ起動（再利用）
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    // sessionId を引き継いだので session.create は1回だけ
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).not.toHaveBeenCalled();
    // 両ターンでプロンプトが送られた
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should carry sessionId across three turns (multi-turn conversation)', async () => {
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const { sessionCreate, sessionUpdate, promptAsync, subscribe } = makeClientMock('multi-session', [
      'Turn 1 response',
      'Turn 2 response',
      'Turn 3 response',
    ]);

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    const results = [];
    let prevSessionId: string | undefined;

    for (let i = 0; i < 3; i++) {
      const result = await agent.call(`message ${i + 1}`, {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        sessionId: prevSessionId,
      });
      results.push(result);
      prevSessionId = result.sessionId;
    }

    expect(results[0].status).toBe('done');
    expect(results[1].status).toBe('done');
    expect(results[2].status).toBe('done');
    expect(results[0].content).toBe('Turn 1 response');
    expect(results[1].content).toBe('Turn 2 response');
    expect(results[2].content).toBe('Turn 3 response');

    // サーバーは1回だけ起動
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    // sessionId を引き継いでいるので session.create は1回のみ
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).not.toHaveBeenCalled();
    // 3ターン分のプロンプトが送られた
    expect(promptAsync).toHaveBeenCalledTimes(3);
    // すべてのターンで同じ sessionId
    expect(results[0].sessionId).toBe('multi-session');
    expect(results[1].sessionId).toBe('multi-session');
    expect(results[2].sessionId).toBe('multi-session');
  });
});

describe('OpenCode shared server exit cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // exit リスナー登録はモジュールインスタンス単位のため、毎回新しい
    // モジュールを読み込んで登録経路を再現する。
    vi.resetModules();
  });

  function createExitCleanupEventStream(sessionId: string, content: string): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'message.part.updated',
          properties: {
            part: { id: `part-${content}`, type: 'text', text: content },
            delta: content,
          },
        };
        yield { type: 'session.idle', properties: { sessionID: sessionId } };
      },
    };
  }

  function createExitCleanupClientMock(sessionId: string, responses: string[]) {
    let responseIndex = 0;
    return {
      instance: { dispose: vi.fn() },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: sessionId } }),
        promptAsync: vi.fn().mockResolvedValue(undefined),
      },
      event: {
        subscribe: vi.fn().mockImplementation(() => {
          const content = responses[responseIndex];
          if (content === undefined) {
            throw new Error(`Missing OpenCode mock response at index ${responseIndex}`);
          }
          responseIndex += 1;
          return Promise.resolve({ stream: createExitCleanupEventStream(sessionId, content) });
        }),
      },
      permission: { reply: vi.fn() },
    };
  }

  it('should register one process exit cleanup only after a failed startup is retried successfully', async () => {
    const registeredExitListeners: Array<() => void> = [];
    const originalOnce = process.once.bind(process);
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((event, listener) => {
      if (event === 'exit') {
        registeredExitListeners.push(listener as () => void);
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once);
    const serverClose = vi.fn();
    const client = createExitCleanupClientMock('exit-cleanup-session', ['second', 'third']);
    createOpencodeMock
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ client, server: { close: serverClose } });

    let resetSharedServer: (() => void) | undefined;
    try {
      const clientModule = await import('../infra/opencode/client.js');
      resetSharedServer = clientModule.resetSharedServer;
      const openCodeClient = new clientModule.OpenCodeClient();
      const registeredOpenCodeExitListeners = (): Array<() => void> => (
        registeredExitListeners.filter((listener) => listener === clientModule.resetSharedServer)
      );

      const failed = await openCodeClient.call('coder', 'first', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });
      expect(failed).toMatchObject({ status: 'error', content: 'startup failed' });
      expect(registeredOpenCodeExitListeners()).toHaveLength(0);

      const succeeded = await openCodeClient.call('coder', 'second', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });
      const reused = await openCodeClient.call('coder', 'third', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });

      expect(succeeded.status).toBe('done');
      expect(reused.status).toBe('done');
      expect(registeredOpenCodeExitListeners()).toHaveLength(1);

      registeredOpenCodeExitListeners()[0]?.();

      expect(createOpencodeMock).toHaveBeenCalledTimes(2);
      expect(serverClose).toHaveBeenCalledTimes(1);
    } finally {
      resetSharedServer?.();
      onceSpy.mockRestore();
    }
  });
});
