import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
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

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

function createEventStream(sessionId: string, content: string): AsyncIterable<unknown> {
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

function createClientMock(sessionId: string, responses: string[]) {
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
        return Promise.resolve({ stream: createEventStream(sessionId, content) });
      }),
    },
    permission: { reply: vi.fn() },
  };
}

describe('OpenCode shared server exit cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

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
    const client = createClientMock('exit-cleanup-session', ['second', 'third']);
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
