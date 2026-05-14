import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockStreamEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockStreamEvent[] }
  | { type: 'stream'; createStream: (signal?: AbortSignal) => AsyncGenerator<MockStreamEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function createEvents(events: MockStreamEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('stream aborted'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

function installOpenCodeMock() {
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn().mockImplementation(async (_payload: unknown, options?: { signal?: AbortSignal }) => {
    const plan = runPlans[runPlanIndex];
    runPlanIndex += 1;
    if (!plan) {
      throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
    }
    if (plan.type === 'stream') {
      return { stream: plan.createStream(options?.signal) };
    }
    return { stream: createEvents(plan.events) };
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

  return { sessionCreate, promptAsync, subscribe };
}

describe('OpenCodeClient retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSharedServer();
    runPlans = [];
    runPlanIndex = 0;
  });

  it('session.error が HTTP 429 を示す場合は retry せず rate_limited を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          {
            type: 'session.error',
            properties: {
              sessionID: 'session-1',
              error: { name: 'RateLimitError', data: { message: 'HTTP 429: rate limit exceeded' } },
            },
          },
        ],
      },
    ];

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
  });

  it('ストリームの idle timeout を retry して成功を返す', async () => {
    vi.useFakeTimers();

    runPlans = [
      {
        type: 'stream',
        createStream: (signal?: AbortSignal) => (async function* () {
          await waitForAbort(signal);
        })(),
      },
      {
        type: 'events',
        events: [
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'p-1', type: 'text', text: 'timeout retry succeeded' },
              delta: 'timeout retry succeeded',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        ],
      },
    ];

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(sessionCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('done');
    expect(result.content).toBe('timeout retry succeeded');
  });

  it('ストリームの idle timeout は 2 回 retry 後に停止する', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 3 }, () => ({
      type: 'stream' as const,
      createStream: (signal?: AbortSignal) => (async function* () {
        await waitForAbort(signal);
      })(),
    }));

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS + 250);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS + 500);
    expect(sessionCreate).toHaveBeenCalledTimes(3);
    expect(promptAsync).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS);
    const result = await resultPromise;

    expect(sessionCreate).toHaveBeenCalledTimes(3);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('error');
    expect(result.content).toBe('OpenCode stream timed out after 10 minutes of inactivity');
  });

  it('external abort は retry せずに停止する', async () => {
    let notifyStreamReady!: () => void;
    const streamReady = new Promise<void>((resolve) => {
      notifyStreamReady = resolve;
    });

    runPlans = [
      {
        type: 'stream',
        createStream: (signal?: AbortSignal) => (async function* () {
          notifyStreamReady();
          await waitForAbort(signal);
        })(),
      },
    ];

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const controller = new AbortController();
    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      abortSignal: controller.signal,
    });

    await streamReady;
    controller.abort();
    const result = await resultPromise;

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(result.content).toBe('OpenCode execution aborted');
  });
});
