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

  it('should pass mapped tools to promptAsync when allowedTools is set', async () => {
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
      allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'mcp__github__search'],
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          read: true,
          edit: true,
          bash: true,
          websearch: true,
          webfetch: true,
          mcp__github__search: true,
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

  it('should pass empty tools object to promptAsync when allowedTools is an explicit empty array', async () => {
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
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {},
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

  it('should create new server when model changes', async () => {
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
    expect(serverClose1).toHaveBeenCalled();
    expect(result1.status).toBe('done');
    expect(result2.status).toBe('done');
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

  it('should carry sessionId across turns and reuse server', async () => {
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const { sessionCreate, promptAsync, subscribe } = makeClientMock('conv-session', [
      'Hello!',
      'I remember our conversation.',
    ]);

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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
    // 両ターンでプロンプトが送られた
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('should carry sessionId across three turns (multi-turn conversation)', async () => {
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();

    const { sessionCreate, promptAsync, subscribe } = makeClientMock('multi-session', [
      'Turn 1 response',
      'Turn 2 response',
      'Turn 3 response',
    ]);

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
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
    // 3ターン分のプロンプトが送られた
    expect(promptAsync).toHaveBeenCalledTimes(3);
    // すべてのターンで同じ sessionId
    expect(results[0].sessionId).toBe('multi-session');
    expect(results[1].sessionId).toBe('multi-session');
    expect(results[2].sessionId).toBe('multi-session');
  });

  it('should apply childProcessEnv only while starting the shared server and restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeClientMock('env-session', ['done']);
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
    const { sessionCreate, promptAsync, subscribe } = makeClientMock('ambient-env-session', ['done']);
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

  it('should keep childProcessEnv until shared server startup promise settles and then restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const { sessionCreate, promptAsync, subscribe } = makeClientMock('pending-env-session', ['done']);
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
    const { sessionCreate, promptAsync, subscribe } = makeClientMock('after-reject-session', ['done']);
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

  it('should recreate the shared server when childProcessEnv snapshot changes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    createOpencodeMock.mockImplementation(async () => {
      const index = createOpencodeMock.mock.calls.length;
      const { sessionCreate, promptAsync, subscribe } = makeClientMock(`env-session-${index}`, [`done-${index}`]);
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
    expect(serverCloseFns[0]).toHaveBeenCalledTimes(1);
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
      const { sessionCreate, promptAsync, subscribe } = makeClientMock(`trace-session-${index}`, [`done-${index}`]);
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

  it('should share an in-flight server when only active trace context changes concurrently', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    context.disable();
    propagation.disable();
    context.setGlobalContextManager(createTestContextManager());
    propagation.setGlobalPropagator(createTestTraceContextPropagator());
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    let resolveFirstPrompt: (() => void) | undefined;
    let firstPromptStarted: (() => void) | undefined;
    let promptCalls = 0;
    const firstPromptStartedPromise = new Promise<void>((resolve) => {
      firstPromptStarted = resolve;
    });
    createOpencodeMock.mockImplementation(async () => {
      const { sessionCreate, promptAsync, subscribe } = makeClientMock('parallel-trace-session', ['done-1', 'done-2']);
      const prompt = vi.fn(() => {
        promptCalls += 1;
        if (promptCalls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstPrompt = resolve;
            firstPromptStarted!();
          });
        }
        return promptAsync();
      });
      const close = vi.fn();
      serverCloseFns.push(close);
      return {
        client: {
          instance: { dispose: vi.fn() },
          session: { create: sessionCreate, promptAsync: prompt },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close },
      };
    });

    try {
      const client = new OpenCodeClient();
      const firstCall = context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('11111111111111111111111111111111', '1111111111111111')),
        () => client.call('coder', 'task 1', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );
      await firstPromptStartedPromise;

      const secondCall = await context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('22222222222222222222222222222222', '2222222222222222')),
        () => client.call('coder', 'task 2', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );

      expect(secondCall.status).toBe('done');
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(serverCloseFns[0]).not.toHaveBeenCalled();

      resolveFirstPrompt!();
      await expect(firstCall).resolves.toMatchObject({ status: 'done' });
      expect(serverCloseFns[0]).not.toHaveBeenCalled();
    } finally {
      context.disable();
      propagation.disable();
    }
  });

  it('should not underflow active calls when session creation returns no id', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const firstServerClose = vi.fn();
    const secondServerClose = vi.fn();
    const sessionCreate = vi.fn()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { id: 'recovered-session' } });
    let resolvePrompt: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      const promptAsync = vi.fn(() => new Promise<void>((promptResolve) => {
        resolvePrompt = promptResolve;
        resolve();
      }));
      const subscribe = vi.fn().mockResolvedValue({
        stream: new MockEventStream([
          { type: 'message.part.updated', properties: { part: { id: 'p-1', type: 'text', text: 'recovered' }, delta: 'recovered' } },
          { type: 'session.idle', properties: { sessionID: 'recovered-session' } },
        ]),
      });
      createOpencodeMock
        .mockResolvedValueOnce({
          client: {
            instance: { dispose: vi.fn() },
            session: { create: sessionCreate, promptAsync },
            event: { subscribe },
            permission: { reply: vi.fn() },
          },
          server: { close: firstServerClose },
        })
        .mockResolvedValueOnce({
          client: {
            instance: { dispose: vi.fn() },
            session: {
              create: vi.fn().mockResolvedValue({ data: { id: 'different-model-session' } }),
              promptAsync: vi.fn().mockResolvedValue(undefined),
            },
            event: {
              subscribe: vi.fn().mockResolvedValue({
                stream: new MockEventStream([
                  { type: 'session.idle', properties: { sessionID: 'different-model-session' } },
                ]),
              }),
            },
            permission: { reply: vi.fn() },
          },
          server: { close: secondServerClose },
        });
    });

    const client = new OpenCodeClient();
    await expect(client.call('coder', 'task 1', {
      cwd: '/tmp',
      model: 'opencode/model-a',
    })).resolves.toMatchObject({
      status: 'error',
      content: 'Failed to create OpenCode session',
    });

    const recoveredCall = client.call('coder', 'task 2', {
      cwd: '/tmp',
      model: 'opencode/model-a',
    });
    await promptStarted;

    await expect(client.call('coder', 'task 3', {
      cwd: '/tmp',
      model: 'opencode/model-b',
    })).resolves.toMatchObject({ status: 'done' });

    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(firstServerClose).not.toHaveBeenCalled();

    resolvePrompt!();
    await expect(recoveredCall).resolves.toMatchObject({ status: 'done' });
    expect(firstServerClose).toHaveBeenCalledTimes(1);
    expect(secondServerClose).not.toHaveBeenCalled();
  });

  it('should log shared server close failures without throwing', async () => {
    const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');
    const { setVerboseConsole, resetDebugLogger } = await import('../shared/utils/debug.js');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { sessionCreate, promptAsync, subscribe } = makeClientMock('close-failure-session', ['done']);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync },
        event: { subscribe },
        permission: { reply: vi.fn() },
      },
      server: {
        close: vi.fn(() => {
          throw new Error('close failed');
        }),
      },
    });

    try {
      setVerboseConsole(true);
      const client = new OpenCodeClient();
      await expect(client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      })).resolves.toMatchObject({ status: 'done' });

      expect(() => resetSharedServer()).not.toThrow();
      expect(writeSpy.mock.calls.map(([message]) => String(message)).join('')).toContain('OpenCode server close failed');
    } finally {
      writeSpy.mockRestore();
      resetDebugLogger();
      resetSharedServer();
    }
  });
});
