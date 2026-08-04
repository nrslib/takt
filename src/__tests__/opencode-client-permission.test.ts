import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AskUserQuestionDeniedError } from '../core/workflow/ask-user-question-error.js';
import {
  MockEventStream,
  EMPTY_TOOLS_SESSION_PERMISSION_RULESET,
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

describe('OpenCodeClient permissions', () => {
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
});
