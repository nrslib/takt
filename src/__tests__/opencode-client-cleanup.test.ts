import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskUserQuestionDeniedError } from '../core/piece/ask-user-question-error.js';

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
});
