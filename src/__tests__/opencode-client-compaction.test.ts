import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        callback();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

type SummarizeRequestOptions = {
  signal?: AbortSignal;
};

describe('OpenCodeClient compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSharedServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given an existing session When compactSession runs Then it calls session.summarize with the SDK payload and abort signal', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'new-session' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: sessionCreate,
          promptAsync,
          summarize,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      opencodeApiKey: 'test-key',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
    });

    expect(summarize).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/repo',
      providerID: 'opencode',
      modelID: 'big-pickle',
      auto: false,
    }, {
      signal: expect.any(AbortSignal),
    });
    const requestOptions = summarize.mock.calls[0]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('Given an invalid OpenCode model When compactSession runs Then it fails before calling the SDK', async () => {
    const summarize = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();

    await expect(client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'big-pickle',
    })).rejects.toThrow("OpenCode model must be in 'provider/model' format");

    expect(summarize).not.toHaveBeenCalled();
  });

  it('Given external abort while summarize is running When compactSession runs Then it aborts the SDK signal immediately', async () => {
    const summarize = vi.fn()
      .mockImplementation((_payload: unknown, requestOptions: SummarizeRequestOptions) => {
        return new Promise<never>((_resolve, reject) => {
          requestOptions.signal?.addEventListener('abort', () => {
            reject(new Error('SDK summarize aborted'));
          });
        });
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    const compactPromise = client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(summarize).toHaveBeenCalledTimes(1);
    });
    const requestOptions = summarize.mock.calls[0]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).toBeDefined();
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(requestOptions.signal?.aborted).toBe(false);

    const compactRejection = expect(compactPromise).rejects.toThrow('OpenCode execution aborted');
    abortController.abort();

    expect(requestOptions.signal?.aborted).toBe(true);
    await compactRejection;
  });

  it('Given session summarize throws synchronously When compactSession fails Then it removes the external abort listener', async () => {
    const summarize = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('SDK summarize failed synchronously');
      })
      .mockResolvedValueOnce({ data: { id: 'session-2' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();
    const addAbortListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');

    await expect(client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    })).rejects.toThrow('SDK summarize failed synchronously');

    expect(addAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      addAbortListener.mock.calls[0]?.[1],
    );

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-2',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
  });

  it('Given session summarize does not settle When compactSession runs Then the SDK call receives an interaction timeout signal', async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-0' } })
      .mockImplementationOnce((_payload: unknown, requestOptions: SummarizeRequestOptions) => {
        return new Promise<never>((_resolve, reject) => {
          requestOptions.signal?.addEventListener('abort', () => {
            reject(new Error('SDK summarize aborted'));
          });
        });
      });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn(),
          promptAsync: vi.fn(),
          summarize,
        },
        event: { subscribe: vi.fn() },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    const abortController = new AbortController();

    await client.compactSession({
      cwd: '/repo',
      sessionId: 'session-0',
      model: 'opencode/big-pickle',
    });

    vi.useFakeTimers();
    const compactPromise = client.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(summarize).toHaveBeenCalledTimes(2);
    const requestOptions = summarize.mock.calls[1]?.[1] as SummarizeRequestOptions;
    expect(requestOptions.signal).toBeDefined();
    expect(requestOptions.signal).not.toBe(abortController.signal);
    expect(requestOptions.signal?.aborted).toBe(false);

    const compactRejection = expect(compactPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);

    expect(requestOptions.signal?.aborted).toBe(true);
    await compactRejection;
  });
});
