import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import {
  OPENCODE_STREAM_EVENT_LIMIT,
  OPENCODE_STREAM_REASONING_BYTE_LIMIT,
  OPENCODE_STREAM_TEXT_BYTE_LIMIT,
} from '../infra/opencode/OpenCodeStreamHandler.js';

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

function textPartUpdated(sessionID: string, id: string, text: string): MockStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: { id, sessionID, type: 'text', text },
    },
  };
}

function reasoningPartUpdated(sessionID: string, id: string, thinking: string): MockStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: { id, sessionID, type: 'reasoning', text: thinking },
    },
  };
}

class MockEventStream implements AsyncGenerator<MockStreamEvent, void, unknown> {
  private index = 0;
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(private readonly events: MockStreamEvent[], private readonly sessionID: string) {}

  [Symbol.asyncIterator](): AsyncGenerator<MockStreamEvent, void, unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<MockStreamEvent, void>> {
    if (this.index >= this.events.length) {
      return { done: true, value: undefined };
    }
    const event = this.events[this.index];
    if (event === undefined) {
      return { done: true, value: undefined };
    }
    this.index += 1;
    return {
      done: false,
      value: {
        ...event,
        properties: {
          ...(event.properties as Record<string, unknown>),
          sessionID: this.sessionID,
        },
      },
    };
  }

  async return(): Promise<IteratorResult<MockStreamEvent, void>> {
    return this.returnSpy();
  }

  async throw(error?: unknown): Promise<IteratorResult<MockStreamEvent, void>> {
    throw error;
  }
}

function successfulSessionAbort() {
  return vi.fn().mockResolvedValue({ data: true });
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
  const messages = vi.fn().mockResolvedValue({ data: [] });
  const permissionReply = vi.fn().mockResolvedValue({ data: {} });
  const questionReply = vi.fn().mockResolvedValue({ data: {} });
  const questionReject = vi.fn().mockResolvedValue({ data: {} });
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
      session: { create: sessionCreate, promptAsync, abort, messages },
      event: { subscribe },
      permission: { reply: permissionReply },
      question: { reply: questionReply, reject: questionReject },
    },
    server: { close: vi.fn() },
  });

  return {
    sessionCreate,
    promptAsync,
    subscribe,
    abort,
    messages,
    permissionReply,
    questionReply,
    questionReject,
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

  it('call wall-clock timeout は全体を abort し retry しない', async () => {
    vi.useFakeTimers();
    runPlans = [{
      type: 'stream',
      createStream: (signal?: AbortSignal) => (async function* () {
        await waitForAbort(signal);
      })(),
    }];
    const { sessionCreate, promptAsync, subscribe, abort } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { callTimeoutMs: 60_000 },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(promptAsync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('wall-clock timeout exceeded');
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('wall-clock signal は未完了の prompt 待ちと iterator close を打ち切る', async () => {
    vi.useFakeTimers();
    const iteratorReturn = vi.fn(() => new Promise<IteratorResult<MockStreamEvent>>(() => {}));
    runPlans = [{
      type: 'stream',
      createStream: (signal?: AbortSignal) => ({
        [Symbol.asyncIterator]() { return this; },
        next: vi.fn(() => waitForAbort(signal)),
        return: iteratorReturn,
      } as AsyncGenerator<MockStreamEvent, void, unknown>),
    }];
    const { promptAsync } = installOpenCodeMock();
    promptAsync.mockImplementation(() => new Promise(() => {}));
    const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { callTimeoutMs: 60_000 },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('wall-clock timeout exceeded');
    expect(iteratorReturn).toHaveBeenCalledOnce();
  });

  it('deadline と event が同時に ready でも以後の callback と reply を実行しない', async () => {
    vi.useFakeTimers();
    runPlans = [{
      type: 'stream',
      createStream: () => ({
        [Symbol.asyncIterator]() { return this; },
        next: vi.fn(() => new Promise<IteratorResult<MockStreamEvent>>((resolve) => {
          setTimeout(() => resolve({
            done: false,
            value: {
              type: 'permission.asked',
              properties: {
                id: 'permission-at-deadline',
                sessionID: 'session-1',
                permission: 'read',
                patterns: ['**'],
                always: [],
              },
            },
          }), 60_000);
        })),
        return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      } as AsyncGenerator<MockStreamEvent, void, unknown>),
    }];
    const {
      promptAsync,
      permissionReply,
      questionReply,
      questionReject,
    } = installOpenCodeMock();
    const onStream = vi.fn();
    const onAskUserQuestion = vi.fn().mockResolvedValue({});
    const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { callTimeoutMs: 60_000 },
      onStream,
      onAskUserQuestion,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    const streamCallsBeforeDeadline = onStream.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('wall-clock timeout exceeded');
    expect(onStream).toHaveBeenCalledTimes(streamCallsBeforeDeadline);
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(onAskUserQuestion).not.toHaveBeenCalled();
    expect(permissionReply).not.toHaveBeenCalled();
    expect(questionReply).not.toHaveBeenCalled();
    expect(questionReject).not.toHaveBeenCalled();
  });

  it('call deadline は進行中の rate-limit 検死 RPC を即座に打ち切る', async () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '1000';
    process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS = '120000';
    try {
      runPlans = [{
        type: 'stream',
        createStream: (signal?: AbortSignal) => (async function* () {
          await waitForAbort(signal);
        })(),
      }];
      const { sessionCreate, messages } = installOpenCodeMock();
      let postmortemSignal: AbortSignal | undefined;
      messages.mockImplementation((_input: unknown, options?: { signal?: AbortSignal }) => {
        postmortemSignal = options?.signal;
        return new Promise(() => {});
      });

      const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        guards: { callTimeoutMs: 60_000 },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(messages).toHaveBeenCalledOnce();
      expect(postmortemSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(59_000);
      const result = await resultPromise;

      expect(result.status).toBe('error');
      expect(result.error).toContain('wall-clock timeout exceeded');
      expect(postmortemSignal?.aborted).toBe(true);
      expect(sessionCreate).toHaveBeenCalledOnce();
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
      delete process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS;
    }
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

  it('replays the OpenCode event order from issue #1130 without mixing reasoning and text', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const reasoningPartOne = 'Reasoning '.repeat(6_600);
    const reasoningPartTwo = 'tail';
    const textPartOne = 'text delta one ';
    const textPartTwo = 'text delta two';
    const reasoning = `${reasoningPartOne}${reasoningPartTwo}`;
    const content = `${textPartOne}${textPartTwo}`;
    const stream = new MockEventStream([
      reasoningPartUpdated('session-reasoning-delta', 'reasoning-1', ''),
      textPartUpdated('session-reasoning-delta', 'text-1', ''),
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta',
          partID: 'reasoning-1',
          field: 'text',
          delta: reasoningPartOne,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta',
          partID: 'text-1',
          field: 'text',
          delta: textPartOne,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta',
          partID: 'reasoning-1',
          field: 'text',
          delta: reasoningPartTwo,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta',
          partID: 'text-1',
          field: 'text',
          delta: textPartTwo,
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta',
          part: {
            id: 'reasoning-1',
            sessionID: 'session-reasoning-delta',
            type: 'reasoning',
            text: reasoning,
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta',
          part: {
            id: 'text-1',
            sessionID: 'session-reasoning-delta',
            type: 'text',
            text: content,
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-reasoning-delta' } },
    ], 'session-reasoning-delta');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-reasoning-delta' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.content).toBe(content);
    const streamEvents = onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { thinking?: string; text?: string } })
      .filter((event) => event.type === 'thinking' || event.type === 'text');
    expect(streamEvents).toHaveLength(4);
    const thinkingOutput = streamEvents
      .filter((event) => event.type === 'thinking')
      .map((event) => event.data?.thinking ?? '')
      .join('');
    expect(thinkingOutput).toBe(reasoning);
    const textOutput = streamEvents
      .filter((event) => event.type === 'text')
      .map((event) => event.data?.text ?? '')
      .join('');
    expect(textOutput).toBe(content);
    expect(thinkingOutput).not.toContain(content);
    expect(textOutput).not.toContain(reasoning);
    expect(streamEvents.filter((event) => event.type === 'thinking')).toHaveLength(2);
    expect(streamEvents.filter((event) => event.type === 'text')).toHaveLength(2);
  });

  it('handles large reasoning delta after the part type is known without applying the text byte limit', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const reasoningPartOne = 'Reasoning '.repeat(6_600);
    const reasoningPartTwo = 'tail';
    const textPart = 'short body';
    const reasoning = `${reasoningPartOne}${reasoningPartTwo}`;
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          part: {
            id: 'reasoning-1',
            sessionID: 'session-reasoning-delta-first',
            type: 'reasoning',
            text: '',
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          part: {
            id: 'text-1',
            sessionID: 'session-reasoning-delta-first',
            type: 'text',
            text: '',
          },
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          partID: 'reasoning-1',
          field: 'text',
          delta: reasoningPartOne,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          partID: 'text-1',
          field: 'text',
          delta: textPart,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          partID: 'reasoning-1',
          field: 'text',
          delta: reasoningPartTwo,
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          part: {
            id: 'text-1',
            sessionID: 'session-reasoning-delta-first',
            type: 'text',
            text: textPart,
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-reasoning-delta-first',
          part: {
            id: 'reasoning-1',
            sessionID: 'session-reasoning-delta-first',
            type: 'reasoning',
            text: reasoning,
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-reasoning-delta-first' } },
    ], 'session-reasoning-delta-first');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-reasoning-delta-first' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.content).toBe(textPart);
    expect(result.content).not.toContain(reasoningPartOne.slice(0, 16));
    const thinkingOutput = onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { thinking?: string; text?: string } })
      .filter((event) => event.type === 'thinking')
      .map((event) => event.data?.thinking ?? '')
      .join('');
    expect(thinkingOutput).toBe(reasoning);
    expect(thinkingOutput).not.toContain(textPart);
  });
  it('ignores empty reasoning and text parts without emitting stream content', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      textPartUpdated('session-empty-parts', 'text-1', ''),
      reasoningPartUpdated('session-empty-parts', 'reasoning-1', ''),
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-empty-parts',
          partID: 'text-1',
          field: 'text',
          delta: '',
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-empty-parts',
          partID: 'reasoning-1',
          field: 'text',
          delta: '',
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-empty-parts' } },
    ], 'session-empty-parts');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-empty-parts' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.content).toBe('');
    expect(onStream.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === 'text' || event.type === 'thinking'))
      .toHaveLength(0);
  });

  it('fails the protocol when a part delta remains unresolved at session end', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-undefined-part-type';
    const delta = 'plain delta text';
    const stream = new MockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'text-undefined',
          field: 'text',
          delta,
        },
      },
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('error');
    expect(result.error).toContain('protocol failure: unresolved part type');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'text')).toEqual([]);
  });

  it('fails the protocol when one-byte unresolved deltas exceed the structural event limit', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-excessive-unresolved-deltas';
    const events = Array.from({ length: OPENCODE_STREAM_EVENT_LIMIT + 1 }, () => ({
      type: 'message.part.delta',
      properties: {
        sessionID: sessionId,
        partID: 'unresolved-1',
        field: 'text',
        delta: 'x',
      },
    }));
    const stream = new MockEventStream(events, sessionId);
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: sessionId } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('error');
    expect(result.error).toContain('protocol failure: unresolved part delta count exceeded');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'text')).toEqual([]);
  });

  it('flushes unresolved parts in original delta arrival order when types resolve in reverse order', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-reverse-part-types';
    const reasoningDelta = 'reasoning arrived first z';
    const textDelta = 'text arrived second z';
    const stream = new MockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'reasoning-first',
          field: 'text',
          delta: reasoningDelta,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'text-second',
          field: 'text',
          delta: textDelta,
        },
      },
      textPartUpdated(sessionId, 'text-second', textDelta),
      reasoningPartUpdated(sessionId, 'reasoning-first', reasoningDelta),
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: sessionId } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.content).toBe(textDelta);
    expect(onStream.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => event.type === 'thinking' || event.type === 'text')
      .map((event) => event.type))
      .toEqual(['thinking', 'text']);
  });

  it('holds a reasoning-first delta until the authoritative part type arrives', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-unknown-delta-reasoning';
    const reasoningPrefix = 'x'.repeat(40_000);
    const reasoningSuffix = 'tail';
    const reasoningText = `${reasoningPrefix}${reasoningSuffix}`;
    const stream = new MockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'reasoning-1',
          field: 'text',
          delta: reasoningPrefix,
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: sessionId,
          part: {
            id: 'reasoning-1',
            sessionID: sessionId,
            type: 'reasoning',
            text: reasoningText,
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.content).toBe('');
    const textOutput = onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { text?: string; thinking?: string } })
      .filter((event) => event.type === 'text')
      .map((event) => event.data?.text ?? '')
      .join('');
    const thinkingOutput = onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { text?: string; thinking?: string } })
      .filter((event) => event.type === 'thinking')
      .map((event) => event.data?.thinking ?? '')
      .join('');
    expect(textOutput).toBe('');
    expect(thinkingOutput).toBe(reasoningText);
  });

  it('reasoning-first buffering accepts exactly 4MiB and rejects 4MiB + 1', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const exact = 'x'.repeat(OPENCODE_STREAM_REASONING_BYTE_LIMIT);
    const makeEvents = (sessionId: string, delta: string): MockStreamEvent[] => [
      {
        type: 'message.part.delta',
        properties: { sessionID: sessionId, partID: 'reasoning-1', field: 'text', delta },
      },
      reasoningPartUpdated(sessionId, 'reasoning-1', delta),
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ];
    runPlans = [
      { type: 'events', events: makeEvents('session-reasoning-exact', exact) },
      { type: 'events', events: makeEvents('session-reasoning-over', `${exact}x`) },
    ];
    let sessionIndex = 0;
    const sessionCreate = vi.fn().mockImplementation(async () => ({
      data: { id: sessionIndex++ === 0 ? 'session-reasoning-exact' : 'session-reasoning-over' },
    }));
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync: vi.fn().mockResolvedValue(undefined), abort: successfulSessionAbort() },
        event: {
          subscribe: vi.fn().mockImplementation(async () => {
            const plan = runPlans[runPlanIndex++]!;
            const sessionId = runPlanIndex === 1 ? 'session-reasoning-exact' : 'session-reasoning-over';
            return { stream: createEvents(plan.type === 'events' ? plan.events : [], sessionId) };
          }),
        },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const exactResult = await client.call('interactive', 'hello', {
      cwd: '/tmp', model: 'opencode/big-pickle', onStream: vi.fn(),
    });
    const overStream = vi.fn();
    const overResult = await client.call('interactive', 'hello', {
      cwd: '/tmp', model: 'opencode/big-pickle', onStream: overStream,
    });

    expect(exactResult.status).toBe('done');
    expect(overResult.status).toBe('error');
    expect(overResult.error).toContain('reasoning_bytes');
    expect(overStream.mock.calls.filter(([event]) => event.type === 'text' || event.type === 'thinking'))
      .toHaveLength(0);
  });

  it('main reasoning update path rejects output above the 4MiB limit before emitting it', async () => {
    const overLimit = 'x'.repeat(OPENCODE_STREAM_REASONING_BYTE_LIMIT + 1);
    runPlans = [{
      type: 'events',
      events: [
        reasoningPartUpdated('session-1', 'reasoning-main', overLimit),
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ],
    }];
    installOpenCodeMock();
    const onStream = vi.fn();

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('reasoning_bytes');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'thinking')).toHaveLength(0);
  });

  it('fails text byte tracking with a reason that identifies text_bytes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      textPartUpdated('session-text-bytes', 'text-1', 'x'.repeat(OPENCODE_STREAM_TEXT_BYTE_LIMIT + 1)),
      { type: 'session.idle', properties: { sessionID: 'session-text-bytes' } },
    ], 'session-text-bytes');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-text-bytes' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('text_bytes');
    expect(result.content).toContain('text_bytes');
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
