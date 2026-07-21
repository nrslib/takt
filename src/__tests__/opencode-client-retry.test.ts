import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';

type MockStreamEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockStreamEvent[] }
  | { type: 'stream'; createStream: (signal?: AbortSignal) => AsyncGenerator<MockStreamEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function createEvents(events: MockStreamEvent[], sessionId: string) {
  return (async function* () {
    for (const event of events) {
      const properties = event.properties;
      if (typeof properties !== 'object' || properties === null) {
        throw new Error('Session event properties are required');
      }
      yield {
        ...event,
        properties: { ...properties, sessionID: sessionId },
      };
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
  let activeSessionId: string | undefined;
  const sessionCreate = vi.fn().mockImplementation(() => {
    activeSessionId = 'session-1';
    return Promise.resolve({ data: { id: activeSessionId } });
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue({ data: true });
  const subscribe = vi.fn().mockImplementation(async (_payload: unknown, options?: { signal?: AbortSignal }) => {
    const plan = runPlans[runPlanIndex];
    runPlanIndex += 1;
    if (!plan) {
      throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
    }
    if (plan.type === 'stream') {
      return { stream: plan.createStream(options?.signal) };
    }
    if (activeSessionId === undefined) {
      throw new Error('Session must be created before subscribing');
    }
    return { stream: createEvents(plan.events, activeSessionId) };
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

  return {
    sessionCreate,
    promptAsync,
    subscribe,
    setActiveSessionId: (sessionId: string) => {
      activeSessionId = sessionId;
    },
  };
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

  it('session.error が RateLimitError 名だけを示す場合は retry せず rate_limited を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          {
            type: 'session.error',
            properties: {
              sessionID: 'session-1',
              error: { name: 'RateLimitError' },
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
    expect(result.error).toBe('RateLimitError');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
  });

  it('ストリームの idle timeout を retry して成功を返す', async () => {
    vi.useFakeTimers();

    runPlans = [
      {
        type: 'stream',
        createStream: (signal?: AbortSignal) => (async function* () {
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'timeout-tool',
                sessionID: 'session-timeout-retry-1',
                type: 'tool',
                callID: 'call-timeout-tool',
                tool: 'remote',
                state: { status: 'running', input: { token: 'timeout-secret' } },
              },
            },
          };
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'timeout-tail',
                sessionID: 'session-timeout-retry-1',
                type: 'text',
                text: 'exception retry tail',
              },
              delta: 'exception retry tail',
            },
          };
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'timeout-reasoning',
                sessionID: 'session-timeout-retry-1',
                type: 'reasoning',
                text: 'exception reasoning tail',
              },
              delta: 'exception reasoning tail',
            },
          };
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
          { type: 'session.idle', properties: { sessionID: 'session-timeout-retry-2' } },
        ],
      },
    ];

    const { sessionCreate, promptAsync, subscribe, setActiveSessionId } = installOpenCodeMock();
    sessionCreate
      .mockReset()
      .mockImplementationOnce(() => {
        setActiveSessionId('session-timeout-retry-1');
        return Promise.resolve({ data: { id: 'session-timeout-retry-1' } });
      })
      .mockImplementationOnce(() => {
        setActiveSessionId('session-timeout-retry-2');
        return Promise.resolve({ data: { id: 'session-timeout-retry-2' } });
      });
    const client = new OpenCodeClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    await vi.waitFor(() => {
      expect(sessionCreate).toHaveBeenCalledTimes(1);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(249);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('timeout retry succeeded');
    expect(promptAsync.mock.calls[0][0].sessionID).toBe('session-timeout-retry-1');
    expect(promptAsync.mock.calls[1][0].sessionID).toBe('session-timeout-retry-2');
    expect(promptAsync.mock.calls[0][0].sessionID).not.toBe(promptAsync.mock.calls[1][0].sessionID);
    expect(onStream.mock.calls.filter(([event]) => (
      event.type === 'text' && event.data.text === 'exception retry tail'
    ))).toHaveLength(1);
    expect(onStream.mock.calls.filter(([event]) => (
      event.type === 'thinking' && event.data.thinking === 'exception reasoning tail'
    ))).toHaveLength(1);
    expect(JSON.stringify(onStream.mock.calls)).not.toContain('timeout-secret');
  });

  it('flushes pending text before retrying a transient stream error', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'transient-tool',
                sessionID: 'session-1',
                type: 'tool',
                callID: 'call-transient-tool',
                tool: 'remote',
                state: { status: 'running', input: { token: 'transient-secret' } },
              },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'transient-tail',
                sessionID: 'session-1',
                type: 'text',
                text: 'transient retry tail',
              },
              delta: 'transient retry tail',
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'transient-reasoning',
                sessionID: 'session-1',
                type: 'reasoning',
                text: 'transient reasoning tail',
              },
              delta: 'transient reasoning tail',
            },
          },
          {
            type: 'session.error',
            properties: {
              sessionID: 'session-1',
              error: { name: 'RequestError', data: { message: 'fetch failed' } },
            },
          },
        ],
      },
      {
        type: 'events',
        events: [
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'recovered', sessionID: 'session-1', type: 'text', text: 'recovered' },
              delta: 'recovered',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        ],
      },
    ];
    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const onStream = vi.fn();
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-retry-thinking-'));
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'retry-thinking',
      runId: 'retry-thinking-run',
      provider: 'opencode',
      step: 'implement',
      enabled: true,
    });
    const client = new OpenCodeClient();
    const logContext = {
      provider: 'opencode' as const,
      providerModel: 'opencode/big-pickle',
      step: 'implement',
    };

    try {
      const result = await client.call('coder', 'prompt', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        onStream: (event) => {
          providerLogger.logEvent(logContext, event);
          onStream(event);
        },
      });

      expect(result.status, JSON.stringify(result)).toBe('done');
      expect(sessionCreate).toHaveBeenCalledTimes(2);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(onStream.mock.calls.filter(([event]) => (
        event.type === 'text' && event.data.text === 'transient retry tail'
      ))).toHaveLength(1);
      expect(onStream.mock.calls.filter(([event]) => (
        event.type === 'thinking' && event.data.thinking === 'transient reasoning tail'
      ))).toHaveLength(1);
      expect(JSON.stringify(onStream.mock.calls)).not.toContain('transient-secret');

      const records = readFileSync(providerLogger.filepath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event_type: string; data: Record<string, unknown> });
      expect(records.filter((record) => (
        record.event_type === 'thinking'
        && record.data['thinking'] === 'transient reasoning tail'
      ))).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain('transient-secret');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
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
    sessionCreate
      .mockReset()
      .mockResolvedValueOnce({ data: { id: 'session-fail-1' } })
      .mockResolvedValueOnce({ data: { id: 'session-fail-2' } })
      .mockResolvedValueOnce({ data: { id: 'session-fail-3' } });
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
    expect(promptAsync.mock.calls[0][0].sessionID).toBe('session-fail-1');
    expect(promptAsync.mock.calls[1][0].sessionID).toBe('session-fail-2');
    expect(promptAsync.mock.calls[2][0].sessionID).toBe('session-fail-3');
    expect(promptAsync.mock.calls[0][0].sessionID).not.toBe(promptAsync.mock.calls[1][0].sessionID);
    expect(promptAsync.mock.calls[1][0].sessionID).not.toBe(promptAsync.mock.calls[2][0].sessionID);
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
