import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type Span,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskUserQuestionDeniedError } from '../core/workflow/ask-user-question-error.js';
import { resetDebugLogger, setVerboseConsole } from '../shared/utils/index.js';

/**
 * 自セッションの進捗が止まったまま、サーバ全体のバスに無関係イベントが
 * 流れ続ける状況を再現するストリーム。旧実装はこれで永遠に延命していた。
 */
class ChatterOnlyEventStream implements AsyncIterable<unknown> {
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  readonly returnSpy = vi.fn(async (): Promise<IteratorResult<unknown, void>> => {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer);
    }
    return { done: true, value: undefined };
  });

  constructor(private readonly chatterIntervalMs: number) {}

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown, void>> => {
        await new Promise((resolvePromise) => {
          this.pendingTimer = setTimeout(resolvePromise, this.chatterIntervalMs);
        });
        return {
          done: false,
          value: {
            type: 'message.part.updated',
            properties: { part: { id: 'p-x', type: 'text', text: 'sibling', sessionID: 'other-session' } },
          },
        };
      },
      return: this.returnSpy,
    };
  }
}

class MockEventStream implements AsyncGenerator<unknown, void, unknown> {
  private index = 0;
  private readonly events: unknown[];
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(events: unknown[], sessionID: string | undefined) {
    this.events = sessionID === undefined ? events : events.map((event) => withEventSessionId(event, sessionID));
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

function withEventSessionId(event: unknown, sessionID: string): unknown {
  if (typeof event !== 'object' || event === null) {
    return event;
  }
  const streamEvent = event as { type?: unknown; properties?: unknown };
  if (typeof streamEvent.properties !== 'object' || streamEvent.properties === null) {
    return event;
  }
  const properties = streamEvent.properties as Record<string, unknown>;
  if (typeof properties.sessionID === 'string') {
    return event;
  }
  if (streamEvent.type === 'message.part.updated') {
    const part = properties.part;
    if (typeof part === 'object' && part !== null) {
      if (typeof (part as { sessionID?: unknown }).sessionID === 'string') {
        return event;
      }
      return { ...streamEvent, properties: { ...properties, part: { ...part, sessionID } } };
    }
  }
  if (streamEvent.type === 'message.updated' || streamEvent.type === 'message.completed' || streamEvent.type === 'message.failed') {
    const info = properties.info;
    if (typeof info === 'object' && info !== null) {
      if (typeof (info as { sessionID?: unknown }).sessionID === 'string') {
        return event;
      }
      return { ...streamEvent, properties: { ...properties, info: { ...info, sessionID } } };
    }
  }
  return { ...streamEvent, properties: { ...properties, sessionID } };
}

class StallingEventStream implements AsyncGenerator<unknown, void, unknown> {
  private emitted = false;
  private readonly firstEvent: unknown;
  private readonly signal?: AbortSignal;
  readonly returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));

  constructor(firstEvent: unknown, signal?: AbortSignal) {
    this.firstEvent = firstEvent;
    this.signal = signal;
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown, void, unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    if (!this.emitted) {
      this.emitted = true;
      return { done: false, value: this.firstEvent };
    }
    if (this.signal?.aborted) {
      return { done: true, value: undefined };
    }
    if (this.signal) {
      return new Promise<IteratorResult<unknown, void>>((resolve) => {
        const onAbort = (): void => {
          this.signal?.removeEventListener('abort', onAbort);
          resolve({ done: true, value: undefined });
        };
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return new Promise<IteratorResult<unknown, void>>(() => {});
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    return this.returnSpy();
  }

  async throw(e?: unknown): Promise<IteratorResult<unknown, void>> {
    throw e;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { finally?: unknown }).finally === 'function';
}

function createTestContextManager(): ContextManager {
  let activeContext: Context = ROOT_CONTEXT;
  return {
    active: () => activeContext,
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      nextContext: Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      const previousContext = activeContext;
      activeContext = nextContext;
      const restore = (): void => {
        activeContext = previousContext;
      };
      try {
        const result = fn.apply(thisArg, args);
        if (isPromiseLike(result)) {
          return result.finally(restore) as ReturnType<F>;
        }
        restore();
        return result;
      } catch (error) {
        restore();
        throw error;
      }
    },
    bind: <T>(_nextContext: Context, target: T): T => target,
    enable() {
      return this;
    },
    disable() {
      activeContext = ROOT_CONTEXT;
      return this;
    },
  };
}

function createTestTraceContextPropagator(): TextMapPropagator<Record<string, string>> {
  return {
    inject: (nextContext, carrier, setter) => {
      const span = trace.getSpan(nextContext);
      if (!span) {
        return;
      }
      const spanContext = span.spanContext();
      const sampledFlag = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? '01' : '00';
      setter.set(carrier, 'traceparent', `00-${spanContext.traceId}-${spanContext.spanId}-${sampledFlag}`);
    },
    extract: (nextContext) => nextContext,
    fields: () => ['traceparent'],
  };
}

function createTestSpan(traceId: string, spanId: string): Span {
  return {
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    }),
  } as unknown as Span;
}

const { createOpencodeMock, streamDiagnostics } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  streamDiagnostics: [] as Array<{
    onConnected: ReturnType<typeof vi.fn>;
    onCompleted: ReturnType<typeof vi.fn>;
  }>,
}));

// セッションの deny は後から昇格できないため、edit/write はセッションスコープで
// 常に許可される（フェーズごとの制限は per-prompt tools マップが担う）
const EMPTY_TOOLS_SESSION_PERMISSION_RULESET = [
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'edit', pattern: '*', action: 'allow' },
  { permission: 'write', pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'deny' },
];

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

function textPartUpdated(sessionID: string, id: string, text: string): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id, sessionID, type: 'text', text },
      delta: text,
    },
  };
}

function sessionIdle(sessionID: string): unknown {
  return { type: 'session.idle', properties: { sessionID } };
}

function successfulSessionAbort(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ data: true });
}

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

function makeOpenCodeClientMock(sessionId: string, responses: string[]) {
  let turnIndex = 0;
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const abort = successfulSessionAbort();
  const subscribe = vi.fn().mockImplementation(() => {
    const text = responses[turnIndex] ?? '';
    const events: unknown[] = [];
    if (text) {
      events.push(textPartUpdated(sessionId, `p-${turnIndex}`, text));
    }
    events.push(sessionIdle(sessionId));
    turnIndex += 1;
    return Promise.resolve({ stream: new MockEventStream(events, sessionId) });
  });
  return { sessionCreate, promptAsync, abort, subscribe };
}

/**
 * UnavailableToolLoopDetector が拾う「unavailable tool」形式のツールエラーイベントを作る。
 * Available tools はサーバ申告の実測形（opencode 1.17.18 の既定有効集合 +
 * 内部擬似ツール 'invalid'）を既定とする。recovery 前置文の有効ツール一覧は
 * この申告を正とするため、テストごとに上書きできる。
 */
function unavailableToolErrorEvent(
  partId: string,
  callID: string,
  tool: string,
  availableTools = 'bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write',
  errorOverride?: string,
) {
  const error = errorOverride
    ?? `Model tried to call unavailable tool '${tool}'. Available tools: ${availableTools}.`;
  return {
    type: 'message.part.updated',
    properties: {
      part: { id: partId, type: 'tool', callID, tool, state: { status: 'error', input: {}, error } },
    },
  };
}

/** promptAsync の n 回目の呼び出しで送られたプロンプト本文を取り出す。 */
function promptTextOfCall(promptAsync: ReturnType<typeof vi.fn>, index: number): string {
  const payload = promptAsync.mock.calls[index]?.[0] as { parts?: Array<{ text?: string }> } | undefined;
  return payload?.parts?.[0]?.text ?? '';
}

describe('OpenCodeClient stream cleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    streamDiagnostics.splice(0);
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  it('should close SSE stream when session.idle is received', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    ], 'session-1');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(stream.returnSpy).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      { directory: '/tmp' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should consume stream events while promptAsync is still pending', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-pending-prompt', sessionID: 'session-pending-prompt', type: 'text', text: 'done' },
          delta: 'done',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-pending-prompt' },
      },
    ], 'session-pending-prompt');

    const prompt = deferred();
    const promptAsync = vi.fn().mockImplementation(() => prompt.promise);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-pending-prompt' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

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
    const call = client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    await vi.waitFor(() => {
      expect(stream.returnSpy).toHaveBeenCalled();
    });

    prompt.resolve();
    const result = await call;
    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
  });

  it('should release same config queue when promptAsync never settles after idle', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-prompt-timeout' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-prompt-timeout' } });
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined);
    const subscribe = vi.fn().mockImplementation(() => {
      const sessionID = sessionCreate.mock.calls.length === 1
        ? 'session-prompt-timeout'
        : 'session-after-prompt-timeout';
      return Promise.resolve({
        stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID } }], sessionID),
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
    const firstResult = await client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      interactionTimeoutMs: 1,
    });

    expect(firstResult.status).toBe('error');
    expect(firstResult.content).toContain('OpenCode prompt completion timed out');

    const secondResult = await client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      interactionTimeoutMs: 1,
    });

    expect(secondResult.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should close SSE stream when session.error is received', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'session-2',
          error: { name: 'Error', data: { message: 'boom' } },
        },
      },
    ], 'session-2');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-2' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('boom');
    expect(stream.returnSpy).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      { directory: '/tmp' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should continue after assistant message completed and finish on session.idle', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-1', sessionID: 'session-3', type: 'text', text: 'done' },
          delta: 'done',
        },
      },
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-3',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-1', sessionID: 'session-3', type: 'text', text: 'done more' },
          delta: ' more',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-3' },
      },
    ], 'session-3');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-3' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await Promise.race([
      client.call('interactive', 'hello', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(result.status).toBe('done');
    expect(result.content).toBe('done more');
    expect(subscribe).toHaveBeenCalledWith(
      { directory: '/tmp' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should not duplicate text when part.delta is followed by a full-snapshot part.updated', async () => {
    // Reproduces the OpenAI (codex OAuth) streaming pattern observed via opencode:
    // an empty text part is created, content arrives as a `message.part.delta`,
    // then the same part is re-sent as a full-snapshot `message.part.updated`.
    // Both paths must share the offset so content is "apple", not "appleapple".
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', sessionID: 'session-dup', type: 'text', text: '' } },
      },
      {
        type: 'message.part.delta',
        properties: { sessionID: 'session-dup', partID: 'p-1', field: 'text', delta: 'apple' },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', sessionID: 'session-dup', type: 'text', text: 'apple' } },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-dup' },
      },
    ], 'session-dup');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-dup' } });
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

    const client = new OpenCodeClient();
    const result = await Promise.race([
      client.call('interactive', 'hello', { cwd: '/tmp', model: 'openai/gpt-5.5' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(result.status).toBe('done');
    expect(result.content).toBe('apple');
  });

  it('should accumulate incremental part.delta chunks before a full snapshot without duplication', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-2', sessionID: 'session-dup2', type: 'text', text: '' } },
      },
      {
        type: 'message.part.delta',
        properties: { sessionID: 'session-dup2', partID: 'p-2', field: 'text', delta: 'ap' },
      },
      {
        type: 'message.part.delta',
        properties: { sessionID: 'session-dup2', partID: 'p-2', field: 'text', delta: 'ple' },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-2', sessionID: 'session-dup2', type: 'text', text: 'apple' } },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-dup2' },
      },
    ], 'session-dup2');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-dup2' } });
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

    const client = new OpenCodeClient();
    const result = await Promise.race([
      client.call('interactive', 'hello', { cwd: '/tmp', model: 'openai/gpt-5.5' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(result.status).toBe('done');
    expect(result.content).toBe('apple');
  });

  it('should reject question.asked without handler and continue processing', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'question.asked',
        properties: {
          id: 'q-1',
          sessionID: 'session-4',
          questions: [
            {
              question: 'Select one',
              header: 'Question',
              options: [{ label: 'A', description: 'A desc' }],
            },
          ],
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-q1', sessionID: 'session-4', type: 'text', text: 'continued response' },
          delta: 'continued response',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-4' },
      },
    ], 'session-4');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-4' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReject = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
        question: { reject: questionReject, reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('continued response');
    expect(questionReject).toHaveBeenCalledWith(
      {
        requestID: 'q-1',
        directory: '/tmp',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should answer question.asked when handler is configured', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'question.asked',
        properties: {
          id: 'q-2',
          sessionID: 'session-5',
          questions: [
            {
              question: 'Select one',
              header: 'Question',
              options: [{ label: 'A', description: 'A desc' }],
            },
          ],
        },
      },
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-5',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-5' },
      },
    ], 'session-5');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-5' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReply = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
        question: { reject: vi.fn(), reply: questionReply },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onAskUserQuestion: async () => ({ Question: 'A' }),
    });

    expect(result.status).toBe('done');
    expect(questionReply).toHaveBeenCalledWith(
      {
        requestID: 'q-2',
        directory: '/tmp',
        answers: [['A']],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should reject question via API when handler throws AskUserQuestionDeniedError', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'question.asked',
        properties: {
          id: 'q-deny',
          sessionID: 'session-deny',
          questions: [
            {
              question: 'Pick one',
              header: 'Test',
              options: [{ label: 'A', description: 'desc' }],
            },
          ],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-deny' },
      },
    ], 'session-deny');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReject = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
        question: { reject: questionReject, reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const denyHandler = (): never => {
      throw new AskUserQuestionDeniedError();
    };

    const client = new OpenCodeClient();
    const result = await client.call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onAskUserQuestion: denyHandler,
    });

    expect(result.status).toBe('done');
    expect(questionReject).toHaveBeenCalledWith(
      {
        requestID: 'q-deny',
        directory: '/tmp',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should pass allowed tools as a permission whitelist to session.create', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-tools',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-tools' } },
    ], 'session-tools');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-tools' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'full',
      allowedTools: ['Read', 'Edit', 'TodoWrite', 'Bash', 'WebSearch', 'WebFetch', 'mcp__github__search'],
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      permission: [
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'todowrite', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'allow' },
        { permission: 'websearch', pattern: '*', action: 'allow' },
        { permission: 'webfetch', pattern: '*', action: 'allow' },
        { permission: 'write', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'deny' },
      ],
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          read: true,
          edit: true,
          write: true,
          patch: true,
          bash: true,
          todowrite: true,
          websearch: true,
          webfetch: true,
          glob: false,
          grep: false,
          question: false,
          task: false,
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should allow allowed tools when permission mode is not set', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-tools-allow',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-tools-allow' } },
    ], 'session-tools-allow');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-tools-allow' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      allowedTools: ['Read', 'Bash'],
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      permission: [
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'write', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'deny' },
      ],
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          read: true,
          bash: true,
          edit: false,
          write: false,
          patch: false,
          task: false,
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should pass variant to promptAsync when opencode variant is set', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-variant',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-variant'),
    ], 'session-variant');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-variant' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      variant: 'high',
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'high',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should not pass OpenCode native structured output format', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-output-format',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-output-format'),
    ], 'session-output-format');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-output-format' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'return json', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const promptPayload = promptAsync.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(promptPayload).not.toHaveProperty('format');
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: 'text', text: 'return json' }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should return provider error when the same unavailable OpenCode tool error repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const unavailableToolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-tool-loop' },
      },
    ], 'session-tool-loop');

    // 同一セッション correction、fresh session の双方で同じ fingerprint を
    // 再発させ、3回目を terminal にする。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-3',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-run-4',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
    ], 'session-tool-loop');
    const freshStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-5',
            type: 'tool',
            callID: 'call-run-5',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-6',
            type: 'tool',
            callID: 'call-run-6',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
    ], 'session-tool-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-tool-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });
    const abort = successfulSessionAbort();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(result.content).toContain(unavailableToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(abort).toHaveBeenCalledTimes(3);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(promptAsync.mock.invocationCallOrder[1]);
    expect(abort.mock.invocationCallOrder[1]).toBeLessThan(promptAsync.mock.invocationCallOrder[2]);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-tool-loop',
      'session-tool-loop',
      'session-tool-fresh',
    ]);
    expect(stream.returnSpy).toHaveBeenCalled();
    expect(correctionStream.returnSpy).toHaveBeenCalled();
    expect(freshStream.returnSpy).toHaveBeenCalled();
  });

  // v3-r4 実測形の回帰: opencode 1.17.18 に存在しない 'list' を呼び続け、
  // correction → fresh session 後も同名再発 → 確定失敗。修正前は recovery
  // 前置文の有効ツール一覧が TAKT の写像（'list' を含む）から生成され、
  // 「'list' は存在しない」と言った直後に 'list' を利用可能と再誘導していた。
  // 前置文はサーバ申告（エラー文の Available tools）を正とし、'invalid'
  // （内部擬似ツール）を除外し、'list' の具体的な代替（glob / bash ls）へ
  // 誘導することを固定する。
  it('should not re-advertise the phantom list tool in the recovery preamble (v3-r4 regression)', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const listUnavailableError = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write.";
    const listErrorPart = (index: number) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `list-part-${index}`,
          type: 'tool',
          callID: `call-list-${index}`,
          tool: 'list',
          state: { status: 'error', input: { path: '.' }, error: listUnavailableError },
        },
      },
    });
    const stream = new MockEventStream([listErrorPart(1), listErrorPart(2)], 'session-list-loop');
    const correctionStream = new MockEventStream([listErrorPart(3), listErrorPart(4)], 'session-list-loop');
    const freshStream = new MockEventStream([listErrorPart(5), listErrorPart(6)], 'session-list-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-list-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-list-loop-fresh' } });
    const abort = successfulSessionAbort();
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'fix the findings', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    // recovery 後の同名再発は本物の失敗として確定する（v3-r4 と同じ結末）。
    expect(result.status).toBe('error');
    expect(result.content).toContain("'list'");
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledTimes(3);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-list-loop',
      'session-list-loop',
      'session-list-loop-fresh',
    ]);

    const correctionPrompt = promptTextOfCall(promptAsync, 1);
    expect(correctionPrompt).toContain('unavailable tool "list"');
    expect(correctionPrompt).toContain('"bash", "edit", "glob", "grep", "read"');
    expect(correctionPrompt).not.toContain('fix the findings');
    const freshPrompt = promptTextOfCall(promptAsync, 2);
    expect(freshPrompt).toContain('previous session repeatedly called an unavailable tool');
    expect(freshPrompt).toContain('fix the findings');
    expect(freshPrompt).toContain('Do NOT overwrite or discard');
  });

  // OpenCode は拒否したツール呼び出しを `invalid` 擬似ツールの status='completed'
  // として返す。実測（takt-bench v3-r1 の implement）: qwen が 195 回連続で踏み、
  // 3 つの検出器も cycle budget も一度も発火しなかった。実物の形で検証する。
  const invalidToolPart = (index: number, attempted: string, error: string) => ({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `invalid-part-${index}`,
        type: 'tool',
        callID: `call-invalid-${index}`,
        tool: 'invalid',
        state: {
          status: 'completed',
          input: { tool: attempted, error },
          output: `The arguments provided to the tool are invalid: ${error}`,
          title: 'invalid',
        },
      },
    },
  });

  const runInvalidScenario = async (events: unknown[]) => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-loop' } })
      .mockResolvedValue({ data: { id: 'session-invalid-loop-fresh' } });
    const subscribe = vi.fn().mockImplementation(() => {
      const sessionID = sessionCreate.mock.calls.length > 1
        ? 'session-invalid-loop-fresh'
        : 'session-invalid-loop';
      return Promise.resolve({
        stream: new MockEventStream([
          ...events,
          sessionIdle(sessionID),
        ], sessionID),
      });
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: sessionCreate,
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });
    const client = new OpenCodeClient();
    return client.call('coder', 'write report', { cwd: '/tmp', model: 'opencode/qwen3-coder-next' });
  };

  it('should treat a completed "invalid" tool part as a rejected tool call and stop the repeating loop', async () => {
    const error = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, read.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'list', error),
      invalidToolPart(2, 'list', error),
      invalidToolPart(3, 'list', error),
      invalidToolPart(4, 'list', error),
    ]);

    expect(result.status).toBe('error');
    // 検出器には本来呼ぼうとしたツール名が渡る（"invalid" ではなく "list"）。
    expect(result.content).toContain('list');
  });

  it('should treat a completed "invalid" tool part reporting a missing argument as a rejected call', async () => {
    const error = "Required argument 'filePath' is missing or invalid.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'read', error),
      invalidToolPart(2, 'read', error),
      invalidToolPart(3, 'read', error),
      invalidToolPart(4, 'read', error),
    ]);

    expect(result.status).toBe('error');
    expect(result.content).toContain('read');
  });

  it('should not punish a single invalid tool call that the model corrects on its own', async () => {
    const error = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, read.";
    const result = await runInvalidScenario([
      invalidToolPart(1, 'list', error),
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-ok',
            type: 'tool',
            callID: 'call-ok',
            sessionID: 'session-invalid-loop',
            tool: 'read',
            state: { status: 'completed', input: { filePath: '/tmp/a.ts' }, output: 'ok', title: 'read' },
          },
        },
      },
    ]);

    // 1 回の空振りは自己修正の余地として許す（実測: v3-r2 の qwen は直後に
    // bash / glob へ切り替えた）。
    expect(result.status).toBe('done');
  });

  it('should return provider error when the same invalid OpenCode tool error repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const invalidToolError = "Model tried to call invalid tool 'run'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-invalid-tool-loop' },
      },
    ], 'session-invalid-tool-loop');

    // correction と fresh session の双方で同じ fingerprint を再発させる。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-3',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-run-4',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: invalidToolError },
          },
        },
      },
    ], 'session-invalid-tool-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-5', 'run', 'glob, grep, read', invalidToolError),
      unavailableToolErrorEvent('tool-part-6', 'call-run-6', 'run', 'glob, grep, read', invalidToolError),
    ], 'session-invalid-tool-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-invalid-tool-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(result.content).toContain(invalidToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should return provider error when unavailable OpenCode tool errors alternate tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const runToolError = "Model tried to call unavailable tool 'run'. Available tools: glob, grep, read.";
    const listToolError = "Model tried to call invalid tool 'list'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-list-1',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-alternating-tool-loop' },
      },
    ], 'session-alternating-tool-loop');

    // correction と fresh session でも交互ループを起こし、terminal を検証する。
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-3',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-4',
            type: 'tool',
            callID: 'call-list-2',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
    ], 'session-alternating-tool-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-3', 'run', 'glob, grep, read', runToolError),
      unavailableToolErrorEvent('tool-part-6', 'call-list-3', 'list', 'glob, grep, read', listToolError),
    ], 'session-alternating-tool-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-alternating-tool-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-alternating-tool-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('list');
    expect(result.content).toContain(listToolError);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('write report');
    expect(promptTextOfCall(promptAsync, 2)).toContain('write report');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should detect unavailable tool loop even when running state precedes each error', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const toolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'running', input: { command: 'echo report' }, title: 'run' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: toolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'running', input: { command: 'echo report' }, title: 'run' },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-2',
            type: 'tool',
            callID: 'call-run-2',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: toolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-running-then-error-loop' },
      },
    ], 'session-running-then-error-loop');

    // recovery の再試行側でも同じループを起こし、従来の打ち切り契約を検証する
    const correctionStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-run-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-run-4', 'run'),
    ], 'session-running-then-error-loop');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-run-5', 'run'),
      unavailableToolErrorEvent('tool-part-6', 'call-run-6', 'run'),
    ], 'session-running-then-error-loop-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-running-then-error-loop' } })
      .mockResolvedValueOnce({ data: { id: 'session-running-then-error-loop-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should ignore duplicate unavailable tool updates for the same OpenCode call', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const runToolError = "Model tried to call unavailable tool 'run'. Available tools: glob, grep, read.";
    const listToolError = "Model tried to call invalid tool 'list'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-run',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-run',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: runToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list',
            type: 'tool',
            callID: 'call-list-1',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-duplicate-tool-update' },
      },
    ], 'session-duplicate-tool-update');

    // recovery の再試行側でも list のループを起こし、従来の打ち切り契約を検証する
    const correctionStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list-2',
            type: 'tool',
            callID: 'call-list-2',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-list-3',
            type: 'tool',
            callID: 'call-list-3',
            tool: 'list',
            state: { status: 'error', input: {}, error: listToolError },
          },
        },
      },
    ], 'session-duplicate-tool-update');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-list-4', 'call-list-4', 'list', 'glob, grep, read', listToolError),
      unavailableToolErrorEvent('tool-part-list-5', 'call-list-5', 'list', 'glob, grep, read', listToolError),
    ], 'session-duplicate-tool-update-fresh');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-duplicate-tool-update' } })
      .mockResolvedValueOnce({ data: { id: 'session-duplicate-tool-update-fresh' } });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: freshStream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('list');
    expect(result.content).toContain(listToolError);
    expect(result.content).not.toContain(runToolError);
    // 発火は重複 run ではなく2件目の list（重複 update は1回として数える）。
    // recovery の前置文が引用するツール名で確かめる。
    expect(promptTextOfCall(promptAsync, 1)).toContain('"list"');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should continue when an unavailable OpenCode tool error occurs only once', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const unavailableToolError = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            type: 'tool',
            callID: 'call-run-1',
            tool: 'run',
            state: { status: 'error', input: { command: 'echo report' }, error: unavailableToolError },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'text-part-1', sessionID: 'session-single-tool-error', type: 'text', text: 'report ready' },
          delta: 'report ready',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-single-tool-error' },
      },
    ], 'session-single-tool-error');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-single-tool-error' } });
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

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'write report', {
      cwd: '/tmp',
      model: 'opencode/qwen3-coder-next',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('report ready');
    expect(result.content).not.toContain(unavailableToolError);
  });

  it('should ignore duplicate unavailable tool observations for the same call', async () => {
    const { UnavailableToolLoopDetector } = await import('../infra/opencode/unavailable-tool-loop.js');
    const detector = new UnavailableToolLoopDetector();

    expect(detector.observe('call-1', 'run', 'unavailable tool: run')).toBeUndefined();
    expect(detector.observe('call-1', 'run', 'unavailable tool: run')).toBeUndefined();
  });

  it('should detect consecutive unavailable tool errors across different calls', async () => {
    const { UnavailableToolLoopDetector } = await import('../infra/opencode/unavailable-tool-loop.js');
    const detector = new UnavailableToolLoopDetector();

    expect(detector.observe('call-1', 'run', 'invalid tool: run')).toBeUndefined();
    expect(detector.observe('call-2', 'run', 'unavailable tool: run')).toEqual({
      tool: 'run',
      message: 'OpenCode unavailable tool loop detected for tool "run": unavailable tool: run',
    });
  });

  it('should keep the unavailable tool loop threshold at exactly 2 consecutive errors', async () => {
    const { UnavailableToolLoopDetector } = await import('../infra/opencode/unavailable-tool-loop.js');
    const detector = new UnavailableToolLoopDetector();

    // 1回目では発火しない（正常な試行錯誤の余地）、2回目ちょうどで発火する。
    // recovery を足した際にも閾値自体は緩めない不変条件。
    expect(detector.observe('call-1', 'run', 'unavailable tool: run')).toBeUndefined();
    const detection = detector.observe('call-2', 'run', 'unavailable tool: run');
    expect(detection).toBeDefined();
    expect(detection?.tool).toBe('run');
  });

  it('should pass system prompt separately from user prompt to promptAsync', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-system', sessionID: 'session-system-prompt', type: 'text', text: 'system prompt\n\nuser promptassistant response' },
          delta: 'system prompt\n\nuser promptassistant response',
        },
      },
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-system-prompt',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-system-prompt'),
    ], 'session-system-prompt');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-system-prompt' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'user prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      systemPrompt: 'system prompt',
      onStream,
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'system prompt',
        parts: [{ type: 'text', text: 'user prompt' }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(promptAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({
        parts: [{ type: 'text', text: 'system prompt\n\nuser prompt' }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onStream).toHaveBeenCalledWith({
      type: 'text',
      data: { text: 'assistant response' },
    });
    expect(result.content).toBe('assistant response');
  });

  it('should pass allow-all permission ruleset for full mode without tool or network overrides', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-full-permission',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-full-permission'),
    ], 'session-full-permission');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-full-permission' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'full',
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      permission: [
        { permission: '*', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'write', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'deny' },
      ],
    });
  });

  it('should pass deny-all permission ruleset when allowedTools is an explicit empty array', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-empty-tools',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-empty-tools'),
    ], 'session-empty-tools');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-empty-tools' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      allowedTools: [],
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      permission: EMPTY_TOOLS_SESSION_PERMISSION_RULESET,
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          read: false,
          glob: false,
          grep: false,
          edit: false,
          write: false,
          patch: false,
          bash: false,
          todowrite: false,
          websearch: false,
          webfetch: false,
          question: false,
          task: false,
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should not treat assistant text that resembles tool markup as runtime permission denial', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-call-text',
            type: 'text',
            text: '<read><path>package.json</path></read>',
          },
          delta: '<read><path>package.json</path></read>',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-deny-tool-markup' },
      },
    ], 'session-deny-tool-markup');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny-tool-markup' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      allowedTools: [],
      onStream,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('<read><path>package.json</path></read>');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: {
        result: '<read><path>package.json</path></read>',
        sessionId: 'session-deny-tool-markup',
        success: true,
      },
    });
  });

  it('should reuse the session and restrict tools per prompt when resuming with allowed tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-existing-tools',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-existing-tools'),
    ], 'session-existing-tools');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'unused-session' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-existing-tools',
      allowedTools: [],
      onStream,
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-existing-tools');
    expect(sessionCreate).not.toHaveBeenCalled();
    // 再開パスではセッション権限を適用しないため permission_summary は流れない
    expect(onStream).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'permission_summary' }),
    );
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-existing-tools',
        tools: expect.objectContaining({ edit: false, write: false, bash: false, read: false }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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


  it('should not update permission ruleset when resuming without allowed tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-existing-default-permissions',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-existing-default-permissions'),
    ], 'session-existing-default-permissions');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'unused-session' } });
    const sessionUpdate = vi.fn().mockResolvedValue({ data: { id: 'session-existing-default-permissions' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-existing-default-permissions',
      permissionMode: 'readonly',
      networkAccess: false,
    });

    expect(result.status).toBe('done');
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-existing-default-permissions' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should emit a permission summary event after resolving allowed tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-permission-summary',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-permission-summary'),
    ], 'session-permission-summary');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-permission-summary' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
      networkAccess: false,
      allowedTools: ['Read', 'WebSearch'],
      onStream,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_summary',
      data: {
        sessionId: 'session-permission-summary',
        permissionMode: 'readonly',
        allowedTools: ['Read', 'WebSearch'],
        networkAccess: false,
        // summary は session.create に実際に渡した緩和済みルールセットを反映する
        resolvedPermissions: [
          { permission: '*', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'allow' },
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'write', pattern: '*', action: 'allow' },
          { permission: 'external_directory', pattern: '*', action: 'deny' },
        ],
      },
    });
  });

  it('should pass permission ruleset to session.create', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-ruleset',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
      sessionIdle('session-ruleset'),
    ], 'session-ruleset');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-ruleset' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'edit',
    });

    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp',
      permission: expect.arrayContaining([
        expect.objectContaining({ permission: 'edit', action: 'allow' }),
        expect.objectContaining({ permission: 'question', action: 'deny' }),
      ]),
    }));
  });

  it('should fail fast when permission reply times out', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-perm-timeout',
        },
      },
    ], 'session-perm-timeout');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-perm-timeout' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockImplementation(() => new Promise(() => {}));

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await Promise.race([
      client.call('coder', 'hello', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        permissionMode: 'edit',
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000)),
    ]);

    expect(result.status).toBe('error');
    expect(result.content).toContain('permission reply timed out');
  });

  it('should emit permission_asked stream event before replying to OpenCode permission request', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'session-permission',
          permission: 'bash',
          patterns: ['**'],
          metadata: { command: 'npm test' },
          always: [],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-permission' },
      },
    ], 'session-permission');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-permission' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
      onStream,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-1',
        sessionId: 'session-permission',
        permission: 'bash',
        patterns: ['**'],
        always: [],
        reply: 'reject',
      },
    });
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-1',
      directory: '/tmp',
      reply: 'reject',
    }, expect.any(Object));
  });

  it('should allow whitelisted OpenCode permission requests at runtime', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-allowed-read',
          sessionID: 'session-allowed-read',
          permission: 'read',
          patterns: ['**'],
          always: [],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-allowed-read' },
      },
    ], 'session-allowed-read');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-allowed-read' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'edit',
      allowedTools: ['Read'],
      onStream,
    });

    expect(result.status).toBe('done');
    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-allowed-read',
        sessionId: 'session-allowed-read',
        permission: 'read',
        patterns: ['**'],
        always: [],
        reply: 'once',
      },
    });
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-allowed-read',
      directory: '/tmp',
      reply: 'once',
    }, expect.any(Object));
  });

  it('should fail instead of reporting success when the stream is aborted without throwing', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const abortController = new AbortController();
    // Ends only when the stream abort signal fires (mirrors SSE behaviour):
    // the loop then falls through without an exception and the post-loop
    // guard must turn the aborted stream into an error, not a success.
    const buildAbortEndingStream = (signal: AbortSignal) => {
      let emitted = false;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<{ done: boolean; value?: unknown }> {
          if (!emitted) {
            emitted = true;
            return Promise.resolve({
              done: false,
              value: {
                type: 'permission.asked',
                properties: {
                  id: 'perm-stall',
                  sessionID: 'session-stall',
                  permission: 'read',
                  patterns: ['**'],
                  always: [],
                },
              },
            });
          }
          return new Promise((resolve) => {
            if (signal.aborted) {
              resolve({ done: true });
              return;
            }
            signal.addEventListener('abort', () => resolve({ done: true }), { once: true });
          });
        },
        return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      };
    };
    const permissionReply = vi.fn().mockImplementation(() => {
      // 最初の（そして唯一の）イベント処理後に外部 abort を発生させる
      queueMicrotask(() => abortController.abort());
      return Promise.resolve({ data: {} });
    });
    const subscribe = vi.fn().mockImplementation(
      (_args: unknown, opts: { signal: AbortSignal }) =>
        Promise.resolve({ stream: buildAbortEndingStream(opts.signal) }),
    );
    let cleanupSignal: AbortSignal | undefined;
    const sessionAbort = vi.fn(
      (_parameters: unknown, options: { signal: AbortSignal }) => {
        cleanupSignal = options.signal;
        return Promise.resolve({ data: true as const });
      },
    );
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-stall' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: sessionAbort,
        },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'edit',
      allowedTools: [],
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('abort');
    expect(sessionAbort).toHaveBeenCalledWith(
      { sessionID: 'session-stall', directory: '/tmp' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(cleanupSignal).not.toBe(abortController.signal);
    expect(cleanupSignal?.aborted).toBe(false);
  });

  it('should request native structured output and capture info.structured', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-structured',
            role: 'assistant',
            structured: { rawFindings: [] },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-structured' } },
    ], 'session-structured');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-structured' } }),
          promptAsync,
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ rawFindings: [] });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        format: { type: 'json_schema', schema, retryCount: 2 },
      }),
      expect.any(Object),
    );
  });

  it('should fall back to the trailing JSON block when structured is not emitted', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'session-fallback',
            type: 'text',
            text: 'report text\n```json\n{"rawFindings": []}\n```',
          },
          delta: 'report text\n```json\n{"rawFindings": []}\n```',
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-fallback' } },
    ], 'session-fallback');
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-fallback' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ rawFindings: [] });
  });

  it.each([
    {
      name: 'broken JSON inside the fence',
      text: 'report\n```json\n{"rawFindings": [}\n```',
      expected: undefined,
    },
    {
      name: 'array-rooted fenced JSON',
      text: 'report\n```json\n[1, 2]\n```',
      expected: undefined,
    },
    {
      name: 'multiple fenced blocks (last one wins)',
      text: '```json\n{"first": true}\n```\nmore text\n```json\n{"rawFindings": []}\n```',
      expected: { rawFindings: [] },
    },
    {
      name: 'explanation followed by bare JSON',
      text: 'report text\n{"rawFindings": []}',
      expected: undefined,
    },
    {
      name: 'formatless object accepted before downstream validation',
      text: '{"rawFindings": [], "extra": true}',
      expected: { rawFindings: [], extra: true },
      schema: {
        type: 'object',
        required: ['rawFindings'],
        properties: { rawFindings: { type: 'array' } },
        additionalProperties: false,
      },
    },
  ])('structured fallback edge case: $name', async ({ text, expected, schema: testSchema }) => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = testSchema ?? { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'part-1', sessionID: 'session-edge', type: 'text', text },
          delta: text,
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-edge' } },
    ], 'session-edge');
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-edge' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    // 抽出に失敗しても done のまま返し、判定は下流（検証 + 是正リトライ）に委ねる
    expect(result.status).toBe('done');
    if (expected === undefined) {
      expect(result.structuredOutput).toBeUndefined();
    } else {
      expect(result.structuredOutput).toEqual(expected);
    }
  });

  it('should fall back to formatless retry when the model does not produce structured output', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.updated',
            properties: {
              info: {
                sessionID: 'session-fmt',
                role: 'assistant',
                error: { name: 'StructuredOutputError', data: { message: 'Model did not produce structured output' } },
              },
            },
          },
        ], 'session-fmt'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'p-1', sessionID: 'session-fmt', type: 'text', text: '{"rawFindings": []}' },
              delta: '{"rawFindings": []}'
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-fmt' } },
        ], 'session-fmt'),
      });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-fmt' } }),
          promptAsync,
          abort: successfulSessionAbort(),
        },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ rawFindings: [] });
    // 1回目は format 付き、2回目（フォールバック）は format なし。追加の再試行はしない
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[0]?.[0]).toHaveProperty('format');
    expect(promptAsync.mock.calls[1]?.[0]).not.toHaveProperty('format');
  });

  it('should still fall back when the format failure lands on the last transient-budget attempt', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    // transient は promptAsync 例外経路（abortCause: prompt）でのみリトライされる
    const emptyStream = () => new MockEventStream([], 'session-budget');
    const formatFailureStream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: { sessionID: 'session-budget', role: 'assistant', error: { name: 'StructuredOutputError', data: { message: 'Model did not produce structured output' } } },
        },
      },
    ], 'session-budget');
    const successStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-1', sessionID: 'session-budget', type: 'text', text: 'report\n```json\n{"rawFindings": []}\n```' },
          delta: 'report\n```json\n{"rawFindings": []}\n```',
        },
      },
      { type: 'session.idle', properties: { sessionID: 'session-budget' } },
    ], 'session-budget');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: formatFailureStream })
      .mockResolvedValueOnce({ stream: successStream });
    const promptAsync = vi.fn()
      .mockRejectedValueOnce(new Error('transport error'))
      .mockRejectedValueOnce(new Error('transport error'))
      .mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-budget' } }),
          promptAsync,
          abort: successfulSessionAbort(),
        },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    // transient 2回で基礎予算(3)の最終試行に format 失敗が来ても、別枠でフォールバックできる
    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ rawFindings: [] });
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(promptAsync.mock.calls[3]?.[0]).not.toHaveProperty('format');
  });

  it('should recover a stale StructuredOutput tool call on a resumed plain session by retrying in a fresh session', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const staleStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
    ], 'session-old');
    const recoveredStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', sessionID: 'session-fresh', type: 'text', text: 'all good' }, delta: 'all good' },
      },
      { type: 'session.idle', properties: { sessionID: 'session-fresh' } },
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: staleStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh');
    // 1回目は resume（session.create を呼ばない）、2回目だけ fresh（session.create を呼ぶ）
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-fresh' });
  });

  it('should fail fast when the recovered fresh session also loops on StructuredOutput', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const staleStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
    ], 'session-old');
    const freshStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'StructuredOutput'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: staleStream })
      .mockResolvedValueOnce({ stream: freshStream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    // fresh session に切り替えても同じ違反が起きたら、以降は救済せず本物の失敗として扱う
    expect(result.status).toBe('error');
    expect(result.content).toContain('StructuredOutput');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should keep non-StructuredOutput loops on correction and fresh recovery only', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    // resumed session の run ループは correction と fresh recovery だけが受け持つ。
    const firstLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-old');
    const correctionLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-old');
    const freshLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-5', 'run'),
      unavailableToolErrorEvent('tool-part-6', 'call-6', 'run'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: firstLoop })
      .mockResolvedValueOnce({ stream: correctionLoop })
      .mockResolvedValueOnce({ stream: freshLoop });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('review it');
    expect(promptTextOfCall(promptAsync, 2)).toContain('review it');
  });

  it('should not attempt stale session recovery on the first call without a session id', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
    ], 'session-new');
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-new' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // sessionId 未指定＝そもそも resume していないので、stale recovery の対象にならない
    expect(result.status).toBe('error');
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  it('should degrade native structured output failures to a fresh formatless session, not reusing the resumed session id', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = {
      type: 'object',
      required: ['step', 'reason'],
      properties: { step: { type: 'integer' }, reason: { type: 'string' } },
      additionalProperties: false,
    };
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.updated',
            properties: {
              info: {
                sessionID: 'session-old',
                role: 'assistant',
                error: { name: 'StructuredOutputError', data: { message: 'Model did not produce structured output' } },
              },
            },
          },
        ], 'session-old'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'p-1', sessionID: 'session-fresh-format', type: 'text', text: '{"step":2,"reason":"second rule"}' },
              delta: '{"step":2,"reason":"second rule"}',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-fresh-format' } },
        ], 'session-fresh-format'),
      });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh-format' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
      outputSchema: schema,
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh-format');
    expect(result.structuredOutput).toEqual({ step: 2, reason: 'second rule' });
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[0]?.[0]).toHaveProperty('format');
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-fresh-format' });
    expect(promptAsync.mock.calls[1]?.[0]).not.toHaveProperty('format');
  });

  it('should build a formatless prompt with the schema, fence contract, and a StructuredOutput ban', async () => {
    const { buildFormatlessStructuredPrompt } = await import('../infra/opencode/structured-output-recovery.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const prompt = buildFormatlessStructuredPrompt('do the review', schema);

    expect(prompt).toContain('do the review');
    expect(prompt).toContain('"rawFindings"');
    expect(prompt).toContain('```json');
    expect(prompt.toLowerCase()).toContain('do not call structuredoutput');
  });

  it('should fail fast when the formatless fresh attempt also loops on StructuredOutput', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.updated',
            properties: {
              info: {
                sessionID: 'session-formatless',
                role: 'assistant',
                error: { name: 'StructuredOutputError', data: { message: 'Model did not produce structured output' } },
              },
            },
          },
        ], 'session-formatless'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
          unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
        ], 'session-formatless'),
      });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-formatless' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
    });

    // 劣化後（既に fresh）で同じ違反が起きたら stale recovery の対象にはならず、本物の失敗として扱う
    expect(result.status).toBe('error');
    expect(result.content).toContain('StructuredOutput');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should degrade to formatless on an upstream request failure message too', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['rawFindings'], properties: { rawFindings: { type: 'array' } } };
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.updated',
            properties: {
              info: {
                sessionID: 'session-old',
                role: 'assistant',
                error: { name: 'ProviderError', data: { message: 'upstream request failed with status 500' } },
              },
            },
          },
        ], 'session-old'),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'p-1', sessionID: 'session-fresh-upstream', type: 'text', text: 'report\n```json\n{"rawFindings": []}\n```' },
              delta: 'report\n```json\n{"rawFindings": []}\n```',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-fresh-upstream' } },
        ], 'session-fresh-upstream'),
      });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh-upstream' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
      outputSchema: schema,
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh-upstream');
    expect(promptAsync.mock.calls[1]?.[0]).not.toHaveProperty('format');
  });

  it('should return a new session id in the final response so callers persist the recovered session', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const staleStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
    ], 'session-old');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-recovered' } },
    ], 'session-recovered');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: staleStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-recovered' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-recovered');
    expect(result.sessionId).not.toBe('session-old');
  });

  it('should correct an unavailable-tool loop in-session, then recover a repeated fingerprint in one fresh session', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const recoveredStream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', sessionID: 'session-b', type: 'text', text: 'done via bash' }, delta: 'done via bash' },
      },
      { type: 'session.idle', properties: { sessionID: 'session-b' } },
    ], 'session-b');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-b' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const abort = successfulSessionAbort();
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    // 元セッションを捨て、新しい fresh session の ID を上位に返す
    expect(result.sessionId).toBe('session-b');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-a',
      'session-a',
      'session-b',
    ]);
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('unavailable tool "run"');
    expect(correctionText).toContain('"bash", "edit", "glob", "grep"');
    expect(correctionText).not.toContain('implement it');
    const retryText = promptTextOfCall(promptAsync, 2);
    expect(retryText).toContain('previous session repeatedly called an unavailable tool');
    expect(retryText).toContain('Do NOT overwrite or discard');
    expect(retryText).toContain('implement it');
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(promptAsync.mock.invocationCallOrder[1]);
    expect(abort.mock.invocationCallOrder[1]).toBeLessThan(promptAsync.mock.invocationCallOrder[2]);
  });

  it('should keep a resumed session for correction and discard it only after the fingerprint repeats', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-old');
    const correctionStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-old');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-fresh-run' } },
    ], 'session-fresh-run');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: correctionStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-fresh-run' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh-run');
    // initial と correction は resume、同じ fingerprint の再発後だけ fresh を作る
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[2]?.[0]).toMatchObject({ sessionID: 'session-fresh-run' });
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('implement it');
    expect(promptTextOfCall(promptAsync, 2)).toContain('implement it');
  });

  it('should fail after correction and the single fresh recovery both repeat the same fingerprint', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const freshLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-5', 'run'),
      unavailableToolErrorEvent('tool-part-6', 'call-6', 'run'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: firstLoop })
      .mockResolvedValueOnce({ stream: correctionLoop })
      .mockResolvedValueOnce({ stream: freshLoop });
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-fresh' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // correction と fresh を使い切った後の再発は terminal（計3 attempt）
    expect(result.status).toBe('error');
    expect(result.content).toContain('run');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls.map(([payload]) => (payload as { sessionID: string }).sessionID)).toEqual([
      'session-a',
      'session-a',
      'session-fresh',
    ]);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('implement it');
    expect(promptTextOfCall(promptAsync, 2)).toContain('implement it');
  });

  it('should make a different fingerprint terminal after the fresh recovery has been used', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-a');
    const correctionLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'run'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'run'),
    ], 'session-a');
    const invalidArgumentError = 'The read tool was called with invalid arguments: SchemaError(Expected string)';
    const freshLoop = new MockEventStream(Array.from({ length: 4 }, (_, index) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `invalid-part-${index}`,
          type: 'tool',
          callID: `invalid-call-${index}`,
          tool: 'read',
          state: { status: 'error', input: {}, error: invalidArgumentError },
        },
      },
    })), 'session-fresh');
    const unexpectedCorrection = new MockEventStream([
      textPartUpdated('session-fresh', 'unexpected', 'incorrectly recovered'),
      sessionIdle('session-fresh'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: firstLoop })
      .mockResolvedValueOnce({ stream: correctionLoop })
      .mockResolvedValueOnce({ stream: freshLoop })
      .mockResolvedValueOnce({ stream: unexpectedCorrection });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-a' } })
      .mockResolvedValueOnce({ data: { id: 'session-fresh' } });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('invalid tool argument loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
  });

  it('should quote todo_write and advertise the observed tool set in its correction', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'todo_write'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'todo_write'),
    ], 'session-todo');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-todo' } },
    ], 'session-todo');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-todo' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'track the plan', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('unavailable tool "todo_write"');
    expect(correctionText).toContain('"todowrite"');
    expect(correctionText).not.toContain('track the plan');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should not invent a semantic mapping for an unknown hallucinated tool name', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'execute_shell'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'execute_shell'),
    ], 'session-unknown');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-unknown' } },
    ], 'session-unknown');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-unknown' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'run the build', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"execute_shell"');
    expect(correctionText).not.toContain('Use "bash"');
    expect(correctionText).toContain('"bash", "edit", "glob", "grep"');
    expect(correctionText).not.toContain('run the build');
  });

  it('should advertise only observed tools when bash is not enabled', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      // bash の無いレビュー系ステップでは、サーバ申告一覧にも bash が現れない。
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run', 'glob, grep, invalid, read, skill'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run', 'glob, grep, invalid, read, skill'),
    ], 'session-no-bash');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-no-bash' } },
    ], 'session-no-bash');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-no-bash' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review the diff', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      // bash の無いレビュー系ステップの allowed_tools を再現する
      allowedTools: ['read', 'glob', 'grep'],
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"run"');
    expect(correctionText).not.toContain('Use "bash"');
    expect(correctionText).toContain('"glob", "grep", "read", "skill"');
    expect(correctionText).not.toContain('"list"');
    expect(correctionText).not.toContain('"bash"');
  });

  it('should not advertise todowrite when it is absent from the observed tool set', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'todo_write', 'glob, grep, invalid, read, skill'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'todo_write', 'glob, grep, invalid, read, skill'),
    ], 'session-no-todo');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-no-todo' } },
    ], 'session-no-todo');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-no-todo' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review the diff', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      allowedTools: ['read', 'glob', 'grep'],
    });

    expect(result.status).toBe('done');
    const correctionText = promptTextOfCall(promptAsync, 1);
    expect(correctionText).toContain('"todo_write"');
    expect(correctionText).not.toContain('Use "todowrite"');
    expect(correctionText).toContain('"glob", "grep", "read", "skill"');
    expect(correctionText).not.toContain('"todowrite"');
  });

  it('should route a StructuredOutput loop only through the stale-session recovery, never the general one', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    // sessionId 無しの初回呼び出し: stale recovery の条件（resume）を満たさず、
    // 一般 recovery からも StructuredOutput は除外されるため、即エラーになる
    const stream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'StructuredOutput'),
    ], 'session-so');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-so' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('StructuredOutput');
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  it('should route StructuredOutput through stale-session recovery after an unrelated correction', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    // run correction 中の StructuredOutput loop は一般 tool-loop recovery へ混ぜず、
    // stale-session route で fresh にする。fresh での再発は terminal。
    const runLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-old');
    const structuredLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-3', 'call-3', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-4', 'call-4', 'StructuredOutput'),
    ], 'session-old');
    const freshStructuredLoop = new MockEventStream([
      unavailableToolErrorEvent('tool-part-5', 'call-5', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-part-6', 'call-6', 'StructuredOutput'),
    ], 'session-fresh');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: runLoop })
      .mockResolvedValueOnce({ stream: structuredLoop })
      .mockResolvedValueOnce({ stream: freshStructuredLoop });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-fresh' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('StructuredOutput');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[2]?.[0]).toMatchObject({ sessionID: 'session-fresh' });
  });

  it('should apply correction, fresh recovery, then terminal failure to an invalid-argument loop', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const events = [1, 2, 3, 4].map((n) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `tool-part-${n}`,
          type: 'tool',
          callID: `call-${n}`,
          tool: 'read',
          state: {
            status: 'error',
            input: {},
            error: `Required argument 'filePath' is missing or invalid (variant ${'x'.repeat(n)})`,
          },
        },
      },
    }));
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-invalid-arg' } })
      .mockResolvedValueOnce({ data: { id: 'session-invalid-arg-fresh' } });
    const subscribe = vi.fn().mockImplementation(() => {
      const sessionID = sessionCreate.mock.calls.length > 1
        ? 'session-invalid-arg-fresh'
        : 'session-invalid-arg';
      return Promise.resolve({ stream: new MockEventStream(events, sessionID) });
    });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'read files', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('invalid tool argument loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptTextOfCall(promptAsync, 1)).not.toContain('read files');
    expect(promptTextOfCall(promptAsync, 2)).toContain('read files');
  });

  it('should not enter the unavailable-tool recovery when the tool error budget is exhausted', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '2';
    try {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      // unavailable / invalid-argument どちらのパターンにも当たらない一般エラーで
      // 予算だけを使い切らせる（ツール名を変えて連続性検出も回避）
      const events = [
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-part-1',
              type: 'tool',
              callID: 'call-1',
              tool: 'read',
              state: { status: 'error', input: {}, error: 'file not found: /a' },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'tool-part-2',
              type: 'tool',
              callID: 'call-2',
              tool: 'grep',
              state: { status: 'error', input: {}, error: 'pattern failed to compile' },
            },
          },
        },
      ];
      const promptAsync = vi.fn().mockResolvedValue(undefined);
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
          session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-budget-x' } }), promptAsync, abort: successfulSessionAbort() },
          event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream(events, 'session-budget-x') }) },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const client = new OpenCodeClient();
      const result = await client.call('coder', 'explore', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });

      expect(result.status).toBe('error');
      expect(result.content).toContain('tool error budget exceeded');
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET;
    }
  });

  it('should keep the unavailable-tool recovery slot even after the transient budget is consumed', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const emptyStream = () => new MockEventStream([], 'session-late');
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', 'run'),
      unavailableToolErrorEvent('tool-part-2', 'call-2', 'run'),
    ], 'session-late');
    const successStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-late' } },
    ], 'session-late');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: emptyStream() })
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: successStream });
    const promptAsync = vi.fn()
      .mockRejectedValueOnce(new Error('transport error'))
      .mockRejectedValueOnce(new Error('transport error'))
      .mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-late' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // transient 2回で基礎予算(3)の最終試行にループが来ても、別枠の1回で救済できる
    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(promptTextOfCall(promptAsync, 3)).toContain('"run"');
  });

  it('should safely quote a hostile hallucinated tool name in the retry preamble', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const hostileTool = 'bad"tool\nname';
    const loopStream = new MockEventStream([
      unavailableToolErrorEvent('tool-part-1', 'call-1', hostileTool),
      unavailableToolErrorEvent('tool-part-2', 'call-2', hostileTool),
    ], 'session-hostile');
    const recoveredStream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-hostile' } },
    ], 'session-hostile');
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: loopStream })
      .mockResolvedValueOnce({ stream: recoveredStream });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: vi.fn().mockResolvedValue({ data: { id: 'session-hostile' } }), promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    const retryText = promptTextOfCall(promptAsync, 1);
    // JSON.stringify での引用: 引用符・改行がエスケープされ、生の改行が
    // 前置文の構造を壊さない
    expect(retryText).toContain(JSON.stringify(hostileTool));
    expect(retryText).not.toContain('a tool named bad"tool');
  });

  it('should not leak sibling-session text into the active session content', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-unknown', type: 'text', text: 'unknown session text' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-sibling', type: 'text', text: 'sibling text', sessionID: 'other-session' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-own', type: 'text', text: 'own text', sessionID: 'session-own' } },
      },
      { type: 'session.idle', properties: { sessionID: 'session-own' } },
    ], undefined);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-own' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(result.content).toContain('own text');
    expect(result.content).not.toContain('sibling text');
    expect(result.content).not.toContain('unknown session text');
  });

  it('should time out a stalled session even while unrelated bus events keep flowing', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const chatterStream = new ChatterOnlyEventStream(100);
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
          session: {
            create: vi.fn().mockResolvedValue({ data: { id: 'session-stalled' } }),
            promptAsync: vi.fn().mockReturnValue(new Promise(() => { /* 完了しない */ })),
            abort: successfulSessionAbort(),
          },
          event: { subscribe: vi.fn().mockResolvedValue({ stream: chatterStream }) },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const result = await new OpenCodeClient().call('coder', 'do it', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        interactionTimeoutMs: 500,
      });

      // 兄弟セッションのイベントでは延命せず、無音タイムアウトが発火して
      // エラーとして表面化する（永久ハングしない）
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
      // 中断経路でもイテレータの後始末（SSE クローズ）が呼ばれること
      expect(chatterStream.returnSpy).toHaveBeenCalled();
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  /** 無音タイムアウトで止めたセッションを検死する共通シナリオ */
  async function runStalledSessionScenario(
    messagesData: unknown,
  ): Promise<import('../core/models/index.js').AgentResponse> {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const chatterStream = new ChatterOnlyEventStream(100);
    const messages = vi.fn().mockResolvedValue({ data: messagesData });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-stalled' } }),
          promptAsync: vi.fn().mockReturnValue(new Promise(() => { /* 完了しない */ })),
          abort: successfulSessionAbort(),
          messages,
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream: chatterStream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    return new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      interactionTimeoutMs: 500,
    });
  }

  it('Given a stalled session whose last assistant message carries a 429 When the idle watchdog fires Then the call is reported as rate limited', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true } },
          },
          parts: [],
        },
      ]);

      expect(result.status).toBe('rate_limited');
      expect(result.errorKind).toBe('rate_limit');
      expect(result.error).toContain('Too Many Requests');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given a stalled session whose last assistant error is unrelated When the idle watchdog fires Then the timeout error is preserved', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'UnknownError', data: { message: 'boom' } },
          },
          parts: [],
        },
      ]);

      expect(result.status).toBe('error');
      expect(result.errorKind).toBeUndefined();
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given a stalled session with no assistant error When the idle watchdog fires Then the timeout error is preserved', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([{ info: { role: 'assistant' }, parts: [] }]);

      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given an older assistant message carries a 429 but the latest one does not When the idle watchdog fires Then the stale rate limit is not reported', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true } },
          },
          parts: [],
        },
        { info: { role: 'user' }, parts: [] },
        { info: { role: 'assistant' }, parts: [] },
      ]);

      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given an older assistant carries a 429 and the latest message is still a user turn When the idle watchdog fires Then the stale rate limit is not reported', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      // セッション再利用で「前回 assistant の 429 → 今回 user prompt → assistant
      // 未生成のまま無音停止」という並びを再現する。
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true } },
          },
          parts: [],
        },
        { info: { role: 'user' }, parts: [] },
      ]);

      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given the latest assistant error exposes the rate limit only in a top level message When the idle watchdog fires Then it is reported as rate limited', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'UnknownError', message: 'AI_APICallError: Too Many Requests' },
          },
          parts: [],
        },
      ]);

      expect(result.status).toBe('rate_limited');
      expect(result.errorKind).toBe('rate_limit');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given the latest assistant error carries a string status code When the idle watchdog fires Then it is reported as rate limited', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const result = await runStalledSessionScenario([
        {
          info: {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'rate exceeded', statusCode: '429' } },
          },
          parts: [],
        },
      ]);

      expect(result.status).toBe('rate_limited');
      expect(result.errorKind).toBe('rate_limit');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given the postmortem query hangs When the idle watchdog fires Then the timeout error is preserved without hanging', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    // 検死 RPC のハングを実時間 5 秒待たない（CI でのフレークを避ける）
    process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS = '200';
    try {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const chatterStream = new ChatterOnlyEventStream(100);
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
          session: {
            create: vi.fn().mockResolvedValue({ data: { id: 'session-stalled' } }),
            promptAsync: vi.fn().mockReturnValue(new Promise(() => { /* 完了しない */ })),
            abort: successfulSessionAbort(),
            messages: vi.fn().mockReturnValue(new Promise(() => { /* 応答しない */ })),
          },
          event: { subscribe: vi.fn().mockResolvedValue({ stream: chatterStream }) },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const result = await new OpenCodeClient().call('coder', 'do it', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        interactionTimeoutMs: 500,
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
      delete process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS;
    }
  }, 20_000);

  it('Given the postmortem query itself fails When the idle watchdog fires Then the timeout error is preserved', async () => {
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '300';
    try {
      const { OpenCodeClient } = await import('../infra/opencode/client.js');
      const chatterStream = new ChatterOnlyEventStream(100);
      createOpencodeMock.mockResolvedValue({
        client: {
          instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
          session: {
            create: vi.fn().mockResolvedValue({ data: { id: 'session-stalled' } }),
            promptAsync: vi.fn().mockReturnValue(new Promise(() => { /* 完了しない */ })),
            abort: successfulSessionAbort(),
            messages: vi.fn().mockRejectedValue(new Error('server gone')),
          },
          event: { subscribe: vi.fn().mockResolvedValue({ stream: chatterStream }) },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      const result = await new OpenCodeClient().call('coder', 'do it', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        interactionTimeoutMs: 500,
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    } finally {
      delete process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS;
    }
  }, 20_000);

  /** 予算系4テスト共通: イベント列を流して call の結果だけ返す */
  async function runBudgetScenario(sessionId: string, events: unknown[]): Promise<import('../core/models/index.js').AgentResponse> {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      ...events,
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);
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
    return new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      interactionTimeoutMs: 500,
    });
  }

  it('should complete normally when message cycles stay under the budget', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      const result = await runBudgetScenario('session-under', Array.from({ length: 4 }, (_, i) => ({
        type: 'message.updated',
        properties: { info: { sessionID: 'session-under', role: 'assistant', time: { completed: 1000 + i } } },
      })).concat([{
        type: 'message.part.updated',
        properties: { part: { id: 'p-t', type: 'text', text: 'done', sessionID: 'session-under' } },
      }] as unknown[]));

      // 予算未満（4 < 5）なら通常どおり完了する
      expect(result.status).toBe('done');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('should complete normally when tool errors stay under the budget', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '6';
    try {
      const result = await runBudgetScenario('session-under2', ['read', 'write', 'glob', 'grep', 'list'].map((tool, i) => ({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `u${i}`, type: 'tool', tool, callID: `u${i}`, sessionID: 'session-under2',
            state: { status: 'error', error: `The ${tool} tool was called with invalid arguments: SchemaError(x)` },
          },
        },
      })).concat([{
        type: 'message.part.updated',
        properties: { part: { id: 'p-t2', type: 'text', text: 'done', sessionID: 'session-under2' } },
      }] as unknown[]));

      // 予算未満（5 < 6）なら通常どおり完了する（回転ツール名で連続性検出も発火しない）
      expect(result.status).toBe('done');
    } finally {
      delete process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET;
    }
  });

  it('should stop a degenerate text-fragment loop via the message cycle budget', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      const result = await runBudgetScenario('session-spin', Array.from({ length: 6 }, (_, i) => ({
        type: 'message.updated',
        properties: { info: { sessionID: 'session-spin', role: 'assistant', time: { completed: 1000 + i } } },
      })));

      expect(result.status).toBe('error');
      expect(result.error).toContain('message cycle budget exceeded');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('should not stop long healthy work that keeps completing tool calls', async () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '5';
    try {
      // 成功するツール呼び出しを挟みながら予算の倍のサイクルを回す。
      // 総サイクル数で打ち切る実装ではここで落ちる（実測: 9万行の implement）。
      const events = Array.from({ length: 10 }, (_, i) => ([
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool', id: `tool-${i}`, callID: `call-${i}`, tool: 'read',
              sessionID: 'session-healthy', messageID: `msg-${i}`,
              state: { status: 'completed', input: {}, output: 'ok', title: 'read' },
            },
          },
        },
        {
          type: 'message.updated',
          properties: { info: { sessionID: 'session-healthy', role: 'assistant', time: { completed: 1000 + i } } },
        },
      ])).flat();

      const result = await runBudgetScenario('session-healthy', events);

      expect(result.status).toBe('done');
    } finally {
      delete process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET;
    }
  });

  it('should stop a degenerate loop that rotates tool names via the error budget', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '6';
    try {
      const result = await runBudgetScenario('session-degenerate', ['read', 'write', 'glob', 'grep', 'list', 'edit'].map((tool, i) => ({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `c${i}`, type: 'tool', tool, callID: `c${i}`, sessionID: 'session-degenerate',
            state: { status: 'error', error: `The ${tool} tool was called with invalid arguments: SchemaError(x)` },
          },
        },
      })));

      expect(result.status).toBe('error');
      expect(result.error).toContain('tool error budget exceeded');
    } finally {
      delete process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET;
    }
  });

  it('should not trip the invalid-argument loop across interleaved unavailable errors', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const INVALID = 'The read tool was called with invalid arguments: SchemaError(Expected string)';
    const UNAVAILABLE = 'unavailable tool: fetch';
    const toolError = (id: string, tool: string, error: string) => ({
      type: 'message.part.updated',
      properties: { part: { id, type: 'tool', tool, callID: id, state: { status: 'error', error } } },
    });
    // invalid ×3 → unavailable ×1 → invalid ×1: 修正前は invalid 側が
    // unavailable を観測できず「連続4回」と誤認して打ち切っていた並び
    const stream = new MockEventStream([
      toolError('c1', 'read', INVALID),
      toolError('c2', 'read', INVALID),
      toolError('c3', 'read', INVALID),
      toolError('c4', 'fetch', UNAVAILABLE),
      toolError('c5', 'read', INVALID),
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-text', sessionID: 'session-mixed', type: 'text', text: 'done' }, delta: 'done' },
      },
      { type: 'session.idle', properties: { sessionID: 'session-mixed' } },
    ], 'session-mixed');
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-mixed' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('coder', 'do it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    // 偽の連続判定で error にならず完走する（unavailable も1回では閾値未満）
    expect(result.status).toBe('done');
  });

  it('should pass the external_directory deny in the server config', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      { type: 'session.idle', properties: { sessionID: 'session-config-deny' } },
    ], 'session-config-deny');
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-config-deny' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort: successfulSessionAbort(),
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    await client.call('coder', 'hello', { cwd: '/tmp', model: 'opencode/big-pickle' });

    // Prompt-level tools maps rewrite session.permission on the server, so
    // the out-of-workspace deny must live in the server config, which that
    // rewrite does not touch.
    expect(createOpencodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          permission: { external_directory: 'deny' },
        }),
      }),
    );
  });

  it('should reject the permission but continue the call when allowedTools is empty', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-deny-all',
          sessionID: 'session-deny-all',
          permission: 'read',
          patterns: ['**'],
          always: [],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-deny-all' },
      },
    ], 'session-deny-all');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny-all' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'edit',
      allowedTools: [],
      onStream,
    });

    // A rejected permission is a per-tool failure: the call keeps consuming
    // the stream and finishes normally on session.idle instead of aborting.
    expect(result.status).not.toBe('error');
    expect(result.error).toBeUndefined();
    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-deny-all',
        sessionId: 'session-deny-all',
        permission: 'read',
        patterns: ['**'],
        always: [],
        reply: 'reject',
      },
    });
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-deny-all',
      directory: '/tmp',
      reply: 'reject',
    }, expect.any(Object));
  });

  it('should wait for rejected permission promptAsync settlement before releasing same config queue', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstPrompt = deferred();
    const sharedSessionId = 'session-permission-reject';
    const sessionCreate = vi.fn();
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'permission.asked',
            properties: {
              id: 'perm-reject-before-queue',
              sessionID: sharedSessionId,
              permission: 'read',
              patterns: ['**'],
              always: [],
            },
          },
          { type: 'session.idle', properties: { sessionID: sharedSessionId } },
        ], sharedSessionId),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sharedSessionId } },
        ], sharedSessionId),
      });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const firstCall = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'edit',
      allowedTools: [],
      sessionId: sharedSessionId,
    });
    await vi.waitFor(() => {
      expect(permissionReply).toHaveBeenCalledTimes(1);
    });

    const secondCall = client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.status).not.toBe('error');
    expect(firstResult.error).toBeUndefined();
    expect(secondResult.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should wait for stream exceptions to settle promptAsync before releasing same config queue', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstPrompt = deferred();
    const sharedSessionId = 'session-stream-error';
    const sessionCreate = vi.fn();
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: vi.fn().mockRejectedValue(new Error('stream exploded')),
          return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        },
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sharedSessionId } },
        ], sharedSessionId),
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
    const firstCall = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
    });
    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    const secondCall = client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.status).toBe('error');
    expect(firstResult.content).toContain('stream exploded');
    expect(secondResult.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should abort stalling stream and retry when promptAsync rejects before idle', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    let firstStream: StallingEventStream | undefined;
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-prompt-transport-error' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-prompt-transport-error' } });
    const promptAsync = vi.fn()
      .mockRejectedValueOnce(new Error('transport error'))
      .mockResolvedValueOnce(undefined);
    const subscribe = vi.fn()
      .mockImplementationOnce((_input: unknown, options: { signal?: AbortSignal }) => {
        firstStream = new StallingEventStream({
          type: 'message.part.updated',
          properties: {
            part: { id: 'p-before-prompt-error', sessionID: 'session-prompt-transport-error', type: 'text', text: 'partial' },
            delta: 'partial',
          },
        }, options.signal);
        return Promise.resolve({ stream: firstStream });
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          {
            type: 'message.part.updated',
            properties: {
              part: { id: 'p-after-prompt-error', sessionID: 'session-after-prompt-transport-error', type: 'text', text: 'recovered' },
              delta: 'recovered',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-after-prompt-transport-error' } },
        ], 'session-after-prompt-transport-error'),
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
    const result = await Promise.race([
      client.call('coder', 'hello', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(result.status).toBe('done');
    expect(result.content).toBe('recovered');
    expect(firstStream).toBeDefined();
    // Each retry creates a new session (not reused)
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should allow OpenCode doom loop permission once in readonly mode', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-doom-loop',
          sessionID: 'session-doom-loop',
          permission: 'doom_loop',
          patterns: ['invalid'],
          metadata: {},
          always: ['invalid'],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-doom-loop' },
      },
    ], 'session-doom-loop');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-doom-loop' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
      onStream,
    });

    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-doom-loop',
        sessionId: 'session-doom-loop',
        permission: 'doom_loop',
        patterns: ['invalid'],
        always: ['invalid'],
        reply: 'once',
      },
    });
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-doom-loop',
      directory: '/tmp',
      reply: 'once',
    }, expect.any(Object));
  });

  it('should allow OpenCode doom loop permission once when allowedTools is empty', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm-doom-loop-deny-only',
          sessionID: 'session-doom-loop-deny-only',
          permission: 'doom_loop',
          patterns: ['invalid'],
          always: ['invalid'],
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-doom-loop-deny-only' },
      },
    ], 'session-doom-loop-deny-only');

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-doom-loop-deny-only' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
        event: { subscribe },
        permission: { reply: permissionReply },
      },
      server: { close: vi.fn() },
    });

    const onStream = vi.fn();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
      allowedTools: [],
      onStream,
    });

    expect(result.status).toBe('done');
    expect(onStream).toHaveBeenCalledWith({
      type: 'permission_asked',
      data: {
        requestId: 'perm-doom-loop-deny-only',
        sessionId: 'session-doom-loop-deny-only',
        permission: 'doom_loop',
        patterns: ['invalid'],
        always: ['invalid'],
        reply: 'once',
      },
    });
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-doom-loop-deny-only',
      directory: '/tmp',
      reply: 'once',
    }, expect.any(Object));
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

  it('should remove an aborted waiting call from the same config queue', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const sharedSessionId = 'session-queue-abort';
    const firstPrompt = deferred();
    const sessionCreate = vi.fn();
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const subscribe = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: sharedSessionId } },
        ], sharedSessionId),
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
    const firstCall = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
    });
    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    const controller = new AbortController();
    const abortedCall = client.call('coder', 'aborted', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    const abortedResult = await abortedCall;
    expect(abortedResult.status).toBe('error');
    expect(abortedResult.content).toContain('OpenCode execution aborted');
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();
    const firstResult = await firstCall;
    expect(firstResult.status).toBe('done');

    const afterAbortResult = await client.call('coder', 'after abort', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: sharedSessionId,
    });
    expect(afterAbortResult.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
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

  it('should apply childProcessEnv only while starting the shared server and restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('env-session', ['done']);
    createOpencodeMock.mockImplementation(async () => {
      envSnapshots.push({
        TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      });
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      };
    });

    try {
      const client = new OpenCodeClient();
      await client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
        },
      });

      expect(envSnapshots).toEqual([{
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      }]);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should preserve ambient observability env while starting without childProcessEnv', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('ambient-env-session', ['done']);
    createOpencodeMock.mockImplementation(async () => {
      envSnapshots.push({
        TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      });
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      };
    });

    try {
      const client = new OpenCodeClient();
      await client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });

      expect(envSnapshots).toEqual([{
        TAKT_OBSERVABILITY: '{"enabled":false}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
      }]);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should not leak childProcessEnv into concurrent startup without childProcessEnv', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const firstStartup = deferred<Awaited<ReturnType<typeof createOpencodeMock>>>();
    const { sessionCreate: firstSessionCreate, promptAsync: firstPromptAsync, subscribe: firstSubscribe } =
      makeOpenCodeClientMock('env-leak-first-session', ['done-1']);
    const { sessionCreate: secondSessionCreate, promptAsync: secondPromptAsync, subscribe: secondSubscribe } =
      makeOpenCodeClientMock('env-leak-second-session', ['done-2']);

    createOpencodeMock
      .mockImplementationOnce(() => {
        envSnapshots.push({ TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY });
        return firstStartup.promise;
      })
      .mockImplementationOnce(async () => {
        envSnapshots.push({ TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY });
        return {
          client: {
            instance: { dispose: vi.fn() },
            session: { create: secondSessionCreate, promptAsync: secondPromptAsync, abort: successfulSessionAbort() },
            event: { subscribe: secondSubscribe },
            permission: { reply: vi.fn() },
          },
          server: { close: vi.fn() },
        };
      });

    try {
      const client = new OpenCodeClient();
      const firstCall = client.call('coder', 'task 1', {
        cwd: '/tmp',
        model: 'opencode/model-a',
        childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const secondCall = client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/model-b',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(envSnapshots).toEqual([{ TAKT_OBSERVABILITY: '{"enabled":true}' }]);

      firstStartup.resolve({
        client: {
          instance: { dispose: vi.fn() },
          session: { create: firstSessionCreate, promptAsync: firstPromptAsync, abort: successfulSessionAbort() },
          event: { subscribe: firstSubscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      await expect(firstCall).resolves.toMatchObject({ status: 'done' });
      await expect(secondCall).resolves.toMatchObject({ status: 'done' });
      expect(envSnapshots).toEqual([
        { TAKT_OBSERVABILITY: '{"enabled":true}' },
        { TAKT_OBSERVABILITY: '{"enabled":false}' },
      ]);
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
    }
  });

  it('should keep childProcessEnv until shared server startup promise settles and then restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('pending-env-session', ['done']);
    let resolveStartup: (value: {
      client: {
        instance: { dispose: ReturnType<typeof vi.fn> };
        session: { create: typeof sessionCreate; promptAsync: typeof promptAsync };
        event: { subscribe: typeof subscribe };
        permission: { reply: ReturnType<typeof vi.fn> };
      };
      server: { close: ReturnType<typeof vi.fn> };
    }) => void;

    createOpencodeMock.mockImplementation(() => new Promise((resolve) => {
      resolveStartup = resolve;
    }));

    try {
      const client = new OpenCodeClient();
      const callPromise = client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
        },
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":true}');

      resolveStartup!({
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      await expect(callPromise).resolves.toMatchObject({ status: 'done' });
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
    }
  });

  it('should restore env and allow later startup when OpenCode startup rejects', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('after-reject-session', ['done']);
    createOpencodeMock
      .mockImplementationOnce(async () => {
        envSnapshots.push({
          TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
          OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        });
        throw new Error('startup failed');
      })
      .mockImplementationOnce(async () => {
        envSnapshots.push({
          TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
          OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        });
        return {
          client: {
            instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
            event: { subscribe },
            permission: { reply: vi.fn() },
          },
          server: { close: vi.fn() },
        };
      });

    try {
      const client = new OpenCodeClient();
      await expect(client.call('coder', 'task 1', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
        },
      })).resolves.toMatchObject({
        status: 'error',
        content: 'startup failed',
      });
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');

      await expect(client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
        },
      })).resolves.toMatchObject({ status: 'done' });

      expect(envSnapshots).toEqual([
        {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
        },
        {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
        },
      ]);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should create a separate shared server when childProcessEnv snapshot changes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    createOpencodeMock.mockImplementation(async () => {
      const index = createOpencodeMock.mock.calls.length;
      const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock(`env-session-${index}`, [`done-${index}`]);
      const close = vi.fn();
      serverCloseFns.push(close);
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close },
      };
    });

    const client = new OpenCodeClient();
    await client.call('coder', 'task 1', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true,"run":1}' },
    });
    await client.call('coder', 'task 2', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true,"run":2}' },
    });

    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(serverCloseFns[0]).not.toHaveBeenCalled();
    expect(serverCloseFns[1]).not.toHaveBeenCalled();
  });

  it('should reuse the shared server when only active trace context changes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    context.disable();
    propagation.disable();
    context.setGlobalContextManager(createTestContextManager());
    propagation.setGlobalPropagator(createTestTraceContextPropagator());
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    createOpencodeMock.mockImplementation(async () => {
      const index = createOpencodeMock.mock.calls.length;
      const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock(`trace-session-${index}`, [`done-${index}`]);
      const close = vi.fn();
      serverCloseFns.push(close);
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close },
      };
    });

    try {
      const client = new OpenCodeClient();
      await context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('11111111111111111111111111111111', '1111111111111111')),
        () => client.call('coder', 'task 1', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );
      await context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('22222222222222222222222222222222', '2222222222222222')),
        () => client.call('coder', 'task 2', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );

      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(serverCloseFns[0]).not.toHaveBeenCalled();
    } finally {
      context.disable();
      propagation.disable();
    }
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
