import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OPENCODE_STREAM_EVENT_LIMIT,
  OPENCODE_STREAM_ID_LIMIT,
  OPENCODE_STREAM_TEXT_BYTE_LIMIT,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import { MAX_TRACKED_SENSITIVE_SOURCES } from '../shared/utils/sensitiveText.js';
import {
  ChatterOnlyEventStream,
  MockEventStream,
  StallingEventStream,
  deferred,
  textPartUpdated,
  sensitiveToolPartUpdated,
  sessionIdle,
  successfulSessionAbort,
  startTimerPump,
} from './helpers/opencode-client-test-helpers.js';

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

  // タイマー駆動の待ち（retry backoff・idle watchdog・permission タイムアウト）を
  // fake timers で実時間ゼロに圧縮する。アサーションは実時間版と同一。
  let pump: { stop: () => Promise<void> };

  beforeEach(() => {
    pump = startTimerPump(20);
  });

  afterEach(async () => {
    await pump.stop();
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

  it('should surface iterator cleanup failure after an idle session is finalized', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const cleanupError = new Error('iterator cleanup failed');
    let emitted = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<unknown, void>> {
        if (emitted) {
          return { done: true, value: undefined };
        }
        emitted = true;
        return {
          done: false,
          value: { type: 'session.idle', properties: { sessionID: 'session-cleanup-failure' } },
        };
      },
      return: vi.fn().mockRejectedValue(cleanupError),
    };
    const abort = successfulSessionAbort();
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-cleanup-failure' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort,
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('iterator cleanup failed'),
    });
    expect(stream.return).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it('should retain iterator and session cleanup failures together', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const iteratorCleanupError = new Error('iterator cleanup failed');
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockRejectedValue(iteratorCleanupError),
    };
    const abort = vi.fn().mockResolvedValue({ data: false });
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: 'session-combined-cleanup-failure' } }),
          promptAsync: vi.fn().mockResolvedValue(undefined),
          abort,
        },
        event: { subscribe: vi.fn().mockResolvedValue({ stream }) },
        permission: { reply: vi.fn() },
      },
      server: { close: vi.fn() },
    });

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('iterator cleanup failed'),
    });
    expect(result.error).toContain('OpenCode server session abort failed');
    expect(stream.return).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('fails an active-session event flood instead of letting it extend the idle timeout indefinitely', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-event-flood';
    const events = Array.from({ length: OPENCODE_STREAM_EVENT_LIMIT + 1 }, () => ({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type: 'busy' } },
    }));
    const stream = new MockEventStream(events, sessionId);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
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
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('event_count');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('fails an attempt when tracked ids exceed the limit and reports tracked_id_count', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-tracked-id-limit';
    const events = Array.from({ length: OPENCODE_STREAM_ID_LIMIT + 1 }, (_, index) => (
      textPartUpdated(sessionId, `text-${index}`, 'x')
    ));
    const stream = new MockEventStream(events, sessionId);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
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
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tracked_id_count');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it.each([
    ['delta', (sessionId: string) => [{
      type: 'message.part.delta',
      properties: {
        sessionID: sessionId,
        partID: 'text-1',
        field: 'text',
        delta: 'x'.repeat(OPENCODE_STREAM_TEXT_BYTE_LIMIT + 1),
      },
    }]],
    ['full snapshot', (sessionId: string) => [{
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'text-1',
          sessionID: sessionId,
          type: 'text',
          text: 'x'.repeat(OPENCODE_STREAM_TEXT_BYTE_LIMIT + 1),
        },
      },
    }]],
    ['multiple ids', (sessionId: string) => [
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'text-1',
          field: 'text',
          delta: 'x'.repeat(Math.floor(OPENCODE_STREAM_TEXT_BYTE_LIMIT / 2) + 1),
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'text-2',
          field: 'text',
          delta: 'y'.repeat(Math.floor(OPENCODE_STREAM_TEXT_BYTE_LIMIT / 2) + 1),
        },
      },
    ]],
  ] as const)('fails an attempt when %s text exceeds the cumulative byte limit', async (_kind, makeEvents) => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = `session-text-limit-${_kind.replace(' ', '-')}`;
    const stream = new MockEventStream(makeEvents(sessionId), sessionId);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
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
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('text_bytes');
    expect(result.content).toContain('text_bytes');
    expect(result.error).not.toContain('event_count');
    expect(result.error).not.toContain('tracked_id_count');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('ignores unsupported part type delta while continuing with later text output', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-unsupported-part-type';
    const unsupportedDelta = 'ignored unsupported delta';
    const supportedText = 'kept text output';
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: sessionId,
          part: {
            id: 'unsupported-part',
            sessionID: sessionId,
            type: 'image',
            text: 'unsupported snapshot',
          },
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: sessionId,
          partID: 'unsupported-part',
          field: 'text',
          delta: unsupportedDelta,
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: sessionId,
          part: {
            id: 'text-1',
            sessionID: sessionId,
            type: 'text',
            text: supportedText,
          },
          delta: supportedText,
        },
      },
      { type: 'session.idle', properties: { sessionID: sessionId } },
    ], sessionId);
    const onStream = vi.fn();

    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
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

    expect(result.status).toBe('done');
    expect(result.content).toBe(supportedText);
    const visibleEvents = onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { text?: string; thinking?: string } })
      .filter((event) => event.type === 'text' || event.type === 'thinking');
    expect(visibleEvents.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { text: supportedText } },
    ]);
    expect(visibleEvents.filter((event) => event.type === 'thinking')).toEqual([]);
    for (const event of visibleEvents) {
      const value = event.type === 'text' ? event.data?.text : event.data?.thinking;
      expect(value).not.toContain(unsupportedDelta);
    }
  });

  it('fails an attempt when sensitive source tracking is exhausted and reports sensitive_sources', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const sessionId = 'session-sensitive-source-limit';
    const events = Array.from({ length: MAX_TRACKED_SENSITIVE_SOURCES + 1 }, (_, index) => (
      sensitiveToolPartUpdated(sessionId, `tool-${index}`, `secret-${index}`)
    ));
    const stream = new MockEventStream(events, sessionId);
    createOpencodeMock.mockResolvedValue({
      client: {
        instance: { dispose: vi.fn() },
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
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('sensitive_sources');
    expect(stream.returnSpy).toHaveBeenCalled();
  });

  it('should consume stream events while promptAsync is still pending', async () => {
    // promptAsync を手動 resolve するまで宙吊りにするテストなので、pump が
    // fake 時間を進めると prompt 完了タイムアウトが先に発火してしまう。実時間で走らせる。
    await pump.stop();
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
});
