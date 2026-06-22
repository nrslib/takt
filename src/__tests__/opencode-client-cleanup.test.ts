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

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
}));

const DENY_ONLY_OPEN_CODE_PERMISSION_RULESET = [
  { permission: '*', pattern: '*', action: 'deny' },
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

function makeOpenCodeClientMock(sessionId: string, responses: string[]) {
  let turnIndex = 0;
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn().mockImplementation(() => {
    const text = responses[turnIndex] ?? '';
    const events: unknown[] = [];
    if (text) {
      events.push({
        type: 'message.part.updated',
        properties: { part: { id: `p-${turnIndex}`, type: 'text', text }, delta: text },
      });
    }
    events.push({ type: 'session.idle', properties: { sessionID: sessionId } });
    turnIndex += 1;
    return Promise.resolve({ stream: new MockEventStream(events) });
  });
  return { sessionCreate, promptAsync, subscribe };
}

describe('OpenCodeClient stream cleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
          part: { id: 'p-pending-prompt', type: 'text', text: 'done' },
          delta: 'done',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-pending-prompt' },
      },
    ]);

    const prompt = deferred();
    const promptAsync = vi.fn().mockImplementation(() => prompt.promise);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-pending-prompt' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

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
        stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID } }]),
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-2' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
          part: { id: 'p-1', type: 'text', text: 'done' },
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
          part: { id: 'p-1', type: 'text', text: 'done more' },
          delta: ' more',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-3' },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-3' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
        properties: { part: { id: 'p-1', type: 'text', text: '' } },
      },
      {
        type: 'message.part.delta',
        properties: { sessionID: 'session-dup', partID: 'p-1', field: 'text', delta: 'apple' },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p-1', type: 'text', text: 'apple' } },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-dup' },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-dup' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
        properties: { part: { id: 'p-2', type: 'text', text: '' } },
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
        properties: { part: { id: 'p-2', type: 'text', text: 'apple' } },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-dup2' },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-dup2' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
          part: { id: 'p-q1', type: 'text', text: 'continued response' },
          delta: 'continued response',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-4' },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-4' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReject = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-5' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReply = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const questionReject = vi.fn().mockResolvedValue({ data: true });

    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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

  it('Given allowed tools are configured, When calling OpenCode, Then it passes the same whitelist to session.create and promptAsync', async () => {
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-tools' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
      ],
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          read: true,
          edit: true,
          todowrite: true,
          bash: true,
          websearch: true,
          webfetch: true,
        },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-tools-allow' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
      ],
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          read: true,
          bash: true,
        },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-variant' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-output-format' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-tool-loop' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
    expect(stream.returnSpy).toHaveBeenCalled();
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-invalid-tool-loop' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-alternating-tool-loop' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-running-then-error-loop' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
    expect(result.content).toContain(toolError);
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-duplicate-tool-update' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
          part: { id: 'text-part-1', type: 'text', text: 'report ready' },
          delta: 'report ready',
        },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'session-single-tool-error' },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-single-tool-error' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn().mockResolvedValue({ data: {} }) },
        session: { create: sessionCreate, promptAsync },
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
    expect(detector.observe('call-2', 'run', 'unavailable tool: run')).toBe(
      'OpenCode unavailable tool loop detected for tool "run": unavailable tool: run',
    );
  });

  it('should pass system prompt separately from user prompt to promptAsync', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p-system', type: 'text', text: 'system prompt\n\nuser promptassistant response' },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-system-prompt' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-full-permission' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
      ],
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('Given allowedTools is an explicit empty array, When calling OpenCode, Then it denies permissions and hides all prompt tools', async () => {
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-empty-tools' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
      permission: DENY_ONLY_OPEN_CODE_PERMISSION_RULESET,
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ tools: {} }),
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny-tool-markup' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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

  it('should create a permission-scoped child session when resuming with allowed tools', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-existing-tools-deny',
            role: 'assistant',
            time: { created: Date.now(), completed: Date.now() + 1 },
          },
        },
      },
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-existing-tools-deny' } });
    const sessionUpdate = vi.fn().mockResolvedValue({ data: { id: 'unused-session' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-existing-tools',
      allowedTools: [],
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-existing-tools-deny');
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      parentID: 'session-existing-tools',
      permission: DENY_ONLY_OPEN_CODE_PERMISSION_RULESET,
    });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-existing-tools-deny' }),
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
    const subscribe = vi.fn().mockImplementation(() => {
      const sessionId = sessionCreate.mock.results.length === 2
        ? 'session-after-create-failure-2'
        : 'session-after-create-failure-3';
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
    await vi.waitFor(() => {
      expect(sessionCreate).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(failed.status).toBe('error');
    expect(failed.content).toContain('Failed to create OpenCode session');
    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(2);

    finishSecondPrompt!();
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(second.status).toBe('done');
    expect(third.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(3);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should stop before prompting when permission-scoped child session creation fails', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockRejectedValue(new Error('permission session create failed'));
    const sessionUpdate = vi.fn().mockResolvedValue({ data: { id: 'unused-session' } });
    const subscribe = vi.fn().mockResolvedValue({
      stream: new MockEventStream([
        { type: 'session.idle', properties: { sessionID: 'session-update-failure' } },
      ]),
    });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-update-failure',
      allowedTools: [],
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('permission session create failed');
    expect(sessionCreate).toHaveBeenCalledWith({
      directory: '/tmp',
      parentID: 'session-update-failure',
      permission: DENY_ONLY_OPEN_CODE_PERMISSION_RULESET,
    });
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'unused-session' } });
    const sessionUpdate = vi.fn().mockResolvedValue({ data: { id: 'session-existing-default-permissions' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, update: sessionUpdate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-permission-summary' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
        resolvedPermissions: [
          { permission: '*', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'allow' },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-ruleset' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-perm-timeout' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockImplementation(() => new Promise(() => {}));

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-permission' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-allowed-read' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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

  it('should reject OpenCode permission request when allowedTools is empty', async () => {
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny-all' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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

    expect(result.status).toBe('error');
    expect(result.content).toContain('OpenCode permission rejected: read');
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

  it('should fail fast after rejected permission when OpenCode does not emit idle', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const stream = new StallingEventStream({
      type: 'permission.asked',
      properties: {
        id: 'perm-deny-no-idle',
        sessionID: 'session-deny-no-idle',
        permission: 'read',
        patterns: ['**'],
        always: [],
      },
    });

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-deny-no-idle' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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
        allowedTools: [],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(result.status).toBe('error');
    expect(result.content).toContain('OpenCode permission rejected: read');
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'perm-deny-no-idle',
      directory: '/tmp',
      reply: 'reject',
    }, expect.any(Object));
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should wait for rejected permission promptAsync settlement before releasing same config queue', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstPrompt = deferred();
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-permission-reject' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-reject' } });
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new StallingEventStream({
          type: 'permission.asked',
          properties: {
            id: 'perm-reject-before-queue',
            sessionID: 'session-permission-reject',
            permission: 'read',
            patterns: ['**'],
            always: [],
          },
        }),
      })
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          { type: 'session.idle', properties: { sessionID: 'session-after-reject' } },
        ]),
      });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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
    });
    await vi.waitFor(() => {
      expect(permissionReply).toHaveBeenCalledTimes(1);
    });

    const secondCall = client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.status).toBe('error');
    expect(firstResult.content).toContain('OpenCode permission rejected: read');
    expect(secondResult.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('should wait for stream exceptions to settle promptAsync before releasing same config queue', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstPrompt = deferred();
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-stream-error' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-stream-error' } });
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
          { type: 'session.idle', properties: { sessionID: 'session-after-stream-error' } },
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
    const firstCall = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    const secondCall = client.call('coder', 'second', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.status).toBe('error');
    expect(firstResult.content).toContain('stream exploded');
    expect(secondResult.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
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
            part: { id: 'p-before-prompt-error', type: 'text', text: 'partial' },
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
              part: { id: 'p-after-prompt-error', type: 'text', text: 'recovered' },
              delta: 'recovered',
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-after-prompt-transport-error' } },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-doom-loop' } });
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
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
    ]);

    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-doom-loop-deny-only' } });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    const permissionReply = vi.fn().mockResolvedValue({ data: {} });

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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

  it('should reuse shared server for parallel calls with same config', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    let callCount = 0;
    const sessionCreate = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({ data: { id: `session-${callCount}` } });
    });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const serverClose = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe: vi.fn().mockImplementation(() => {
          const events = [{ type: 'session.idle', properties: { sessionID: `session-${callCount}` } }];
          return Promise.resolve({ stream: new MockEventStream(events) });
        }) },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose },
    });

    const client = new OpenCodeClient();

    const [result1, result2, result3] = await Promise.all([
      client.call('coder', 'task1', { cwd: '/tmp', model: 'opencode/big-pickle' }),
      client.call('coder', 'task2', { cwd: '/tmp', model: 'opencode/big-pickle' }),
      client.call('coder', 'task3', { cwd: '/tmp', model: 'opencode/big-pickle' }),
    ]);

    expect(createOpencodeMock).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(3);
    expect(result1.status).toBe('done');
    expect(result2.status).toBe('done');
    expect(result3.status).toBe('done');
    expect(serverClose).not.toHaveBeenCalled();
  });

  it('should keep the existing server open when model changes', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
    const promptAsync = vi.fn().mockResolvedValue(undefined);
    const disposeInstance = vi.fn().mockResolvedValue({ data: {} });
    const serverClose1 = vi.fn();
    const serverClose2 = vi.fn();

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-1' } }]) }) },
        permission: { reply: vi.fn() },
      },
      server: { close: serverClose1 },
    }).mockResolvedValueOnce({
      client: {
        instance: { dispose: disposeInstance },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe: vi.fn().mockResolvedValue({ stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-2' } }]) }) },
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
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([
              { type: 'session.idle', properties: { sessionID: 'session-close-failure' } },
            ]),
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
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-model-a' } }]),
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
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-model-b' } }]),
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
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-key-a' } }]),
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
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-key-b' } }]),
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
    const sessionCreateB = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-b-1' } })
      .mockResolvedValueOnce({ data: { id: 'session-b-2' } });
    const promptAsyncB = vi.fn()
      .mockImplementationOnce(() => promptB1.promise)
      .mockImplementationOnce(() => promptB2.promise);

    createOpencodeMock.mockResolvedValueOnce({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-a' } }),
          promptAsync: vi.fn().mockImplementation(() => promptA.promise),
        },
        event: {
          subscribe: vi.fn().mockResolvedValue({
            stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID: 'session-a' } }]),
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
        },
        event: {
          subscribe: vi.fn().mockImplementation(() => {
            const sessionID = sessionCreateB.mock.calls.length === 1 ? 'session-b-1' : 'session-b-2';
            return Promise.resolve({
              stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID } }]),
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

    const callB1 = client.call('coder', 'task-b-1', { cwd: '/tmp', model: 'opencode/model-b' });
    await vi.waitFor(() => {
      expect(promptAsyncB).toHaveBeenCalledTimes(1);
    });

    const callB2 = client.call('coder', 'task-b-2', { cwd: '/tmp', model: 'opencode/model-b' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionCreateB).toHaveBeenCalledTimes(1);
    expect(promptAsyncB).toHaveBeenCalledTimes(1);

    promptA.resolve();
    await callA;
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionCreateB).toHaveBeenCalledTimes(1);
    expect(promptAsyncB).toHaveBeenCalledTimes(1);

    promptB1.resolve();
    await vi.waitFor(() => {
      expect(sessionCreateB).toHaveBeenCalledTimes(2);
    });
    promptB2.resolve();

    const [resultB1, resultB2] = await Promise.all([callB1, callB2]);
    expect(resultB1.status).toBe('done');
    expect(resultB2.status).toBe('done');
  });

  it('should remove an aborted waiting call from the same config queue', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const firstPrompt = deferred();
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'session-before-abort' } })
      .mockResolvedValueOnce({ data: { id: 'session-after-abort' } });
    const promptAsync = vi.fn()
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockResolvedValueOnce(undefined);
    const subscribe = vi.fn().mockImplementation(() => {
      const sessionID = sessionCreate.mock.calls.length === 1
        ? 'session-before-abort'
        : 'session-after-abort';
      return Promise.resolve({
        stream: new MockEventStream([{ type: 'session.idle', properties: { sessionID } }]),
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
    const firstCall = client.call('coder', 'first', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await vi.waitFor(() => {
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    const controller = new AbortController();
    const abortedCall = client.call('coder', 'aborted', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    const abortedResult = await abortedCall;
    expect(abortedResult.status).toBe('error');
    expect(abortedResult.content).toContain('OpenCode execution aborted');
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    firstPrompt.resolve();
    const firstResult = await firstCall;
    expect(firstResult.status).toBe('done');

    const afterAbortResult = await client.call('coder', 'after abort', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    expect(afterAbortResult.status).toBe('done');
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
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
          session: { create: sessionCreate, promptAsync },
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
          session: { create: sessionCreate, promptAsync },
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
            session: { create: secondSessionCreate, promptAsync: secondPromptAsync },
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
          session: { create: firstSessionCreate, promptAsync: firstPromptAsync },
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
          session: { create: sessionCreate, promptAsync },
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
            session: { create: sessionCreate, promptAsync },
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
          session: { create: sessionCreate, promptAsync },
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
          session: { create: sessionCreate, promptAsync },
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
          properties: { part: { id: `p-${turnIndex}`, type: 'text', text }, delta: text },
        });
      }
      events.push({ type: 'session.idle', properties: { sessionID: sessionId } });
      turnIndex += 1;
      return Promise.resolve({ stream: new MockEventStream(events) });
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
        session: { create: sessionCreate, update: sessionUpdate, promptAsync },
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
        session: { create: sessionCreate, update: sessionUpdate, promptAsync },
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
