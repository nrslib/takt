import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockEventStream,
  textPartUpdated,
  reasoningPartUpdated,
  sensitiveToolPartUpdated,
  expectStreamTextOnce,
  expectStreamThinkingOnce,
  sessionIdle,
  successfulSessionAbort,
  unavailableToolErrorEvent,
  promptTextOfCall,
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

describe('OpenCodeClient structured output', () => {
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

  it('should request native structured output and capture info.structured', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
    const stream = new MockEventStream([
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'session-structured',
            role: 'assistant',
            structured: { records: [] },
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
    expect(result.structuredOutput).toEqual({ records: [] });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        format: { type: 'json_schema', schema, retryCount: 2 },
      }),
      expect.any(Object),
    );
  });

  it('should fall back to the trailing JSON block when structured is not emitted', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
    const stream = new MockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'session-fallback',
            type: 'text',
            text: 'report text\n```json\n{"records": []}\n```',
          },
          delta: 'report text\n```json\n{"records": []}\n```',
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
    expect(result.structuredOutput).toEqual({ records: [] });
  });

  it.each([
    {
      name: 'broken JSON inside the fence',
      text: 'report\n```json\n{"records": [}\n```',
      expected: undefined,
    },
    {
      name: 'array-rooted fenced JSON',
      text: 'report\n```json\n[1, 2]\n```',
      expected: undefined,
    },
    {
      name: 'multiple fenced blocks (last one wins)',
      text: '```json\n{"first": true}\n```\nmore text\n```json\n{"records": []}\n```',
      expected: { records: [] },
    },
    {
      name: 'explanation followed by bare JSON',
      text: 'report text\n{"records": []}',
      expected: undefined,
    },
    {
      name: 'formatless object accepted before downstream validation',
      text: '{"records": [], "extra": true}',
      expected: { records: [], extra: true },
      schema: {
        type: 'object',
        required: ['records'],
        properties: { records: { type: 'array' } },
        additionalProperties: false,
      },
    },
  ])('structured fallback edge case: $name', async ({ text, expected, schema: testSchema }) => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = testSchema ?? { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
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
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
    const subscribe = vi.fn()
      .mockResolvedValueOnce({
        stream: new MockEventStream([
          sensitiveToolPartUpdated('session-fmt', 'format-tool', 'format-secret'),
          textPartUpdated('session-fmt', 'format-tail', 'format retry tail'),
          reasoningPartUpdated('session-fmt', 'format-reasoning', 'format reasoning tail'),
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
              part: { id: 'p-1', sessionID: 'session-fmt', type: 'text', text: '{"records": []}' },
              delta: '{"records": []}'
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

    const client = new OpenCodeProvider().setup({ name: 'reviewer' });
    const onStream = vi.fn();
    const result = await client.call('review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      outputSchema: schema,
      language: 'ja',
      onStream,
    });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ records: [] });
    // 1回目は format 付き、2回目（フォールバック）は format なし。追加の再試行はしない
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[0]?.[0]).toHaveProperty('format');
    expect(promptAsync.mock.calls[1]?.[0]).not.toHaveProperty('format');
    expect(JSON.stringify(promptAsync.mock.calls[1]?.[0])).toContain('次の JSON schema に一致する');
    expectStreamTextOnce(onStream, 'format retry tail');
    expectStreamThinkingOnce(onStream, 'format reasoning tail');
    expect(JSON.stringify(onStream.mock.calls)).not.toContain('format-secret');
  });

  it('should still fall back when the format failure lands on the last transient-budget attempt', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
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
          part: { id: 'p-1', sessionID: 'session-budget', type: 'text', text: 'report\n```json\n{"records": []}\n```' },
          delta: 'report\n```json\n{"records": []}\n```',
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
    expect(result.structuredOutput).toEqual({ records: [] });
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(promptAsync.mock.calls[3]?.[0]).not.toHaveProperty('format');
  });

  it('should recover a stale StructuredOutput tool call on a resumed plain session by retrying in a fresh session', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const staleStream = new MockEventStream([
      sensitiveToolPartUpdated('session-old', 'stale-tool-secret', 'stale-secret'),
      textPartUpdated('session-old', 'stale-tail', 'stale retry tail'),
      reasoningPartUpdated('session-old', 'stale-reasoning', 'stale reasoning tail'),
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
    const onStream = vi.fn();
    const result = await client.call('reviewer', 'review it', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      sessionId: 'session-old',
      onStream,
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('session-fresh');
    // 1回目は resume（session.create を呼ばない）、2回目だけ fresh（session.create を呼ぶ）
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ sessionID: 'session-old' });
    expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({ sessionID: 'session-fresh' });
    expectStreamTextOnce(onStream, 'stale retry tail');
    expectStreamThinkingOnce(onStream, 'stale reasoning tail');
    expect(JSON.stringify(onStream.mock.calls)).not.toContain('stale-secret');
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
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
    const prompt = buildFormatlessStructuredPrompt('do the review', schema);

    expect(prompt).toContain('do the review');
    expect(prompt).toContain('"records"');
    expect(prompt).toContain('```json');
    expect(prompt.toLowerCase()).toContain('do not call structuredoutput');
  });

  it('should fail fast when the formatless fresh attempt also loops on StructuredOutput', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
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
    const schema = { type: 'object', required: ['records'], properties: { records: { type: 'array' } } };
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
              part: { id: 'p-1', sessionID: 'session-fresh-upstream', type: 'text', text: 'report\n```json\n{"records": []}\n```' },
              delta: 'report\n```json\n{"records": []}\n```',
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
});
