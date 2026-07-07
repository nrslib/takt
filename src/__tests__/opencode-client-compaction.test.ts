import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('OpenCodeClient compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSharedServer();
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
      signal: abortController.signal,
    });
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
});
