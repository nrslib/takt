vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeServerStartMock } from './helpers/opencode-server-process-test-helpers.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import {
  OPENCODE_STREAM_EVENT_LIMIT,
  OPENCODE_STREAM_REASONING_BYTE_LIMIT,
  OPENCODE_STREAM_TEXT_BYTE_LIMIT,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import {
  OpenCodeGuardSuite,
  type OpenCodeGuardEvaluation,
} from '../infra/opencode/guards/index.js';

type MockStreamEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockStreamEvent[] }
  | { type: 'stream'; createStream: (signal?: AbortSignal) => AsyncGenerator<MockStreamEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;

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

function createAbortOnlyStream(
  signal: AbortSignal | undefined,
  returnIterator: () => Promise<IteratorResult<MockStreamEvent>>,
): AsyncGenerator<MockStreamEvent, void, unknown> {
  return {
    [Symbol.asyncIterator](this: AsyncGenerator<MockStreamEvent, void, unknown>) {
      return this;
    },
    next: vi.fn(() => waitForAbort(signal)),
    return: returnIterator,
    throw: vi.fn((error?: unknown) => Promise.reject(error)),
  } satisfies AsyncGenerator<MockStreamEvent, void, unknown>;
}

function createPermissionEventAtDeadlineStream(): AsyncGenerator<MockStreamEvent, void, unknown> {
  return {
    [Symbol.asyncIterator](this: AsyncGenerator<MockStreamEvent, void, unknown>) {
      return this;
    },
    next: vi.fn(() => new Promise<IteratorResult<MockStreamEvent, void>>((resolve) => {
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
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
    throw: vi.fn((error?: unknown) => Promise.reject(error)),
  } satisfies AsyncGenerator<MockStreamEvent, void, unknown>;
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

function rateLimitPlan(message: string): RunPlan {
  return { type: 'events', events: [{ type: 'session.error', properties: {
    sessionID: 'session-1', error: { name: 'APIError', data: { message } },
  } }] };
}

function successfulRetryPlan(): RunPlan {
  return { type: 'events', events: [
    textPartUpdated('session-1', 'final-answer', 'final answer'),
    { type: 'session.idle', properties: { sessionID: 'session-1' } },
  ] };
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

vi.mock('../infra/opencode/server-process.js', () => ({
  startOpenCodeServer: createOpenCodeServerStartMock(createOpencodeMock),
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

function installOpenCodeMock() {
  let activeSessionId: string | undefined;
  const sessionCreate = vi.fn().mockImplementation(() => {
    activeSessionId = 'session-1';
    return Promise.resolve({ data: { id: activeSessionId } });
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const resolveModel = vi.fn().mockResolvedValue({ providerID: 'opencode', modelID: 'runtime-default' });
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
      resolveModel,
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
    resolveModel,
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

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['full', 'readonly', 'strict-readonly'] as const)('resolves the omitted model with the same role as the prompt in %s', async (mode) => {
    runPlans = [{
      type: 'events',
      events: [
        textPartUpdated('session-1', 'response', 'done'),
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ],
    }];
    const { sessionCreate, promptAsync, resolveModel } = installOpenCodeMock();
    resolveModel.mockResolvedValue({ providerID: 'opencode', modelID: 'runtime-default', variant: 'high' });

    const result = await new OpenCodeClient().call('coder', 'implement task', {
      cwd: '/tmp',
      allowDefaultModel: true,
      guards: { modelProfiles: { 'opencode/runtime-default': 'minimal' } },
      allowedTools: mode === 'full' ? undefined : ['Read'],
      permissionMode: mode === 'full' ? undefined : 'readonly',
      internalAgentIsolation: mode === 'strict-readonly' ? 'strict-readonly' : undefined,
      allowReadonlyFileRead: mode !== 'full',
    });

    expect(result.status).toBe('done');
    const agent = mode === 'full' ? 'takt' : mode === 'strict-readonly' ? 'takt-read' : 'takt-review';
    expect(resolveModel).toHaveBeenCalledWith({ directory: '/tmp', agent }, { signal: expect.any(AbortSignal) });
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', modelID: 'runtime-default' },
      agent,
      variant: 'high',
      parts: [{ type: 'text', text: 'implement task' }],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(createOpencodeMock.mock.calls[0]?.[0].config).not.toHaveProperty('model');
    expect(createOpencodeMock.mock.calls[0]?.[0].config).not.toHaveProperty('small_model');
  });

  it('retries transient model resolution before creating the execution session', async () => {
    runPlans = [{
      type: 'events',
      events: [
        textPartUpdated('session-1', 'response', 'done'),
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ],
    }];
    const { sessionCreate, promptAsync, resolveModel } = installOpenCodeMock();
    resolveModel.mockRejectedValueOnce(new Error('network error'));

    const result = await new OpenCodeClient().call('coder', 'implement task', {
      cwd: '/tmp',
      allowDefaultModel: true,
      allowedTools: ['Read'], permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly', allowReadonlyFileRead: true,
      systemPrompt: 'Interpret verification results.',
    });

    expect(result.status).toBe('done');
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledOnce();
    for (const [input] of resolveModel.mock.calls) expect(input.agent).toBe('takt-read');
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'takt-read', system: 'Interpret verification results.', tools: expect.objectContaining({ read: true, bash: false, write: false }),
    }), expect.anything());
  });

  it('preserves the interpretation role and readonly tools after a transient execution error', async () => {
    runPlans = [
      { type: 'events', events: [{ type: 'session.error', properties: {
        sessionID: 'session-1', error: { name: 'RequestError', data: { message: 'fetch failed' } },
      } }] },
      { type: 'events', events: [
        { type: 'message.part.updated', properties: {
          part: { id: 'answer', sessionID: 'session-1', type: 'text', text: 'verification passed' }, delta: 'verification passed',
        } },
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ] },
    ];
    const { promptAsync } = installOpenCodeMock();
    const result = await new OpenCodeClient().call('assistant', 'interpret', {
      cwd: '/tmp', model: 'opencode/big-pickle', allowedTools: ['Read'], permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly', allowReadonlyFileRead: true, systemPrompt: 'Interpret verification results.',
    });
    expect(result).toMatchObject({ status: 'done', content: 'verification passed', retryCount: 1 });
    expect(promptAsync).toHaveBeenCalledTimes(2);
    for (const [request] of promptAsync.mock.calls) {
      expect(request).toMatchObject({ agent: 'takt-read', system: 'Interpret verification results.', tools: {
        read: true, bash: false, write: false, edit: false, task: false,
      } });
    }
  });

  it('returns an external-abort failure when model resolution is interrupted', async () => {
    let modelResolutionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelResolutionStarted = resolve; });
    const abortController = new AbortController();
    const { sessionCreate, promptAsync, resolveModel } = installOpenCodeMock();
    resolveModel.mockImplementationOnce((_input: unknown, options?: { signal?: AbortSignal }) => {
      modelResolutionStarted?.();
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('model resolution aborted'));
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });

    const resultPromise = new OpenCodeClient().call('coder', 'implement task', {
      cwd: '/tmp',
      allowDefaultModel: true,
      abortSignal: abortController.signal,
    });
    await started;
    abortController.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
    });
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('applies the call timeout to runtime model resolution', async () => {
    vi.useFakeTimers();
    let modelResolutionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { modelResolutionStarted = resolve; });
    const { sessionCreate, promptAsync, resolveModel } = installOpenCodeMock();
    resolveModel.mockImplementationOnce((_input: unknown, options?: { signal?: AbortSignal }) => {
      modelResolutionStarted?.();
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('model resolution aborted'));
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });

    const resultPromise = new OpenCodeClient().call('coder', 'implement task', {
      cwd: '/tmp',
      allowDefaultModel: true,
      guards: { callTimeoutMs: 60_000 },
    });
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
      error: 'Part timeout after 60000ms',
    });
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it('session.error の429は250msと500msの待機後に rate_limited を返す', async () => {
    vi.useFakeTimers();
    runPlans = Array.from({ length: 3 }, () => ({
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
      }));

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();

    const onStream = vi.fn();
    const pending = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      onStream,
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [250, 500].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(promptAsync).toHaveBeenCalledTimes(index + 1);
      expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(promptAsync).toHaveBeenCalledTimes(index + 2);
    }
    const result = await pending;

    expect(sessionCreate).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
    expect(result.retryCount).toBe(2);
    expect(result.rateLimitInfo?.provider).toBe('opencode');
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toHaveLength(1);
  });

  it.each(['pending', 'running', 'completed'] as const)(
    'ツールの%sイベント後に429を受けても元のpromptを再送しない', async (status) => {
      vi.useFakeTimers();
      runPlans = [{ type: 'events', events: [
        { type: 'message.part.updated', properties: {
          sessionID: 'session-1',
          part: {
            id: 'edit-part', sessionID: 'session-1', type: 'tool', callID: 'edit-call', tool: 'edit',
            state: { status, input: { filePath: '/tmp/example.ts' },
              ...(status === 'completed' ? { output: 'edited', title: 'Edit file' } : {}) },
          },
        } },
        { type: 'session.error', properties: {
          sessionID: 'session-1', error: { name: 'RateLimitError', data: { message: 'HTTP 429: Too Many Requests' } },
        } },
      ] }, successfulRetryPlan()];
      const { promptAsync, subscribe } = installOpenCodeMock();
      const pending = new OpenCodeClient().call('coder', 'edit the file', {
        cwd: '/tmp', model: 'opencode/big-pickle',
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
      expect(promptAsync).toHaveBeenCalledOnce();
      expect(subscribe).toHaveBeenCalledOnce();
    },
  );

  it('session.error の RateLimitError 名だけでも2回再試行する', async () => {
    vi.useFakeTimers();
    runPlans = Array.from({ length: 3 }, () => ({
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
      }));

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();

    const pending = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });
    await vi.advanceTimersByTimeAsync(750);
    const result = await pending;

    expect(sessionCreate).toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('rate_limited');
    expect(result.error).toBe('RateLimitError');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
  });

  it.each(['session.error', 'message.updated', 'message.completed', 'message.failed', 'exception'] as const)(
    '%s の429を2回再試行しreadonlyの実行制約を保持する', async (channel) => {
      vi.useFakeTimers();
      const failure: RunPlan = channel === 'exception'
        ? { type: 'stream', createStream: async function* () { throw new Error('HTTP 429: Too Many Requests'); } }
        : { type: 'events', events: [{ type: channel, properties: {
          sessionID: 'session-1',
          ...(channel === 'session.error'
            ? { error: { name: 'APIError', data: { statusCode: 429, message: 'request rejected' } } }
            : { info: { sessionID: 'session-1', role: 'assistant', error: { name: 'APIError', data: { statusCode: 429, message: 'request rejected' } } } }),
        } }] };
      runPlans = [failure, failure, successfulRetryPlan()];
      const { promptAsync } = installOpenCodeMock();
      const pending = new OpenCodeClient().call('coder', 'original prompt', {
        cwd: '/tmp', model: 'opencode/big-pickle', permissionMode: 'readonly',
        internalAgentIsolation: 'strict-readonly', allowReadonlyFileRead: true, allowedTools: ['Read'], systemPrompt: 'original system',
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(promptAsync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ status: 'done', content: 'final answer', retryCount: 2 });
      expect(result.errorKind).toBeUndefined();
      expect(promptAsync).toHaveBeenCalledTimes(3);
      for (const [request] of promptAsync.mock.calls) {
        expect(request).toMatchObject({ agent: 'takt-read', system: 'original system',
          model: { providerID: 'opencode', modelID: 'big-pickle' },
          tools: { read: true, bash: false, write: false, edit: false, task: false },
          parts: [{ type: 'text', text: 'original prompt' }],
        });
      }
    },
  );

  it.each([429, '429'])(
    'タイムアウト後に取得したstatusCode=%sの429も再試行して成功する', async (statusCode) => {
      vi.useFakeTimers();
      let failAttempt: ((failure: OpenCodeGuardEvaluation) => void) | undefined;
      const original = OpenCodeGuardSuite.prototype.startAttempt;
      const spy = vi.spyOn(OpenCodeGuardSuite.prototype, 'startAttempt').mockImplementation(function (
        this: OpenCodeGuardSuite, onFailure: (failure: OpenCodeGuardEvaluation) => void,
      ) {
        failAttempt = onFailure;
        original.call(this, onFailure);
      });
      const failure: RunPlan = { type: 'stream', createStream: (signal) => (async function* () {
        if (failAttempt === undefined) throw new Error('Attempt guard callback is missing');
        failAttempt({ guardId: 'idle-timeout', verdict: { action: 'fail', reason: 'OpenCode attempt timed out' } });
        await waitForAbort(signal);
      })() };
      runPlans = [failure, failure, successfulRetryPlan()];
      const { promptAsync, messages } = installOpenCodeMock();
      messages.mockResolvedValue({ data: [{ info: {
        role: 'assistant', error: { name: 'APIError', data: { statusCode, message: 'request rejected' } },
      }, parts: [] }] });
      try {
        const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
        await vi.advanceTimersByTimeAsync(249);
        expect(messages).toHaveBeenCalledOnce();
        expect(promptAsync).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(messages).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(499);
        expect(promptAsync).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ status: 'done', content: 'final answer', retryCount: 2 });
        expect(promptAsync).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(['message.updated', 'message.completed'] as const)('%s のstatusCodeだけの429を再試行する', async (type) => {
    vi.useFakeTimers();
    runPlans = [{ type: 'events', events: [{ type, properties: { info: {
      sessionID: 'session-1', role: 'assistant', error: { data: { statusCode: 429 } },
    } } }] }, successfulRetryPlan()];
    const { promptAsync } = installOpenCodeMock();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(249);
    expect(promptAsync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'done', content: 'final answer' });
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it('promptAsyncの構造化429例外を再試行する', async () => {
    vi.useFakeTimers();
    const failure: RunPlan = { type: 'stream', createStream: (signal) => (async function* () {
      await waitForAbort(signal);
    })() };
    runPlans = [failure, failure, successfulRetryPlan()];
    const { promptAsync } = installOpenCodeMock();
    const error = Object.assign(new Error('request rejected'), { data: { statusCode: 429 } });
    promptAsync.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(249);
    expect(promptAsync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'done', content: 'final answer', retryCount: 2 });
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  it.each(['message.updated', 'message.completed'] as const)(
    'promptAsyncの429とエラーのない%sが競合しても429分類を保持する', async (type) => {
      vi.useFakeTimers();
      let rejectPrompt: ((reason?: unknown) => void) | undefined;
      runPlans = [
        { type: 'stream', createStream: () => {
          let emitted = false;
          return {
            [Symbol.asyncIterator](this: AsyncGenerator<MockStreamEvent, void, unknown>) { return this; },
            next: vi.fn(() => {
              if (emitted) return Promise.resolve({ done: true as const, value: undefined });
              const reject = rejectPrompt;
              if (!reject) throw new Error('promptAsync was not started');
              emitted = true;
              queueMicrotask(() => reject(Object.assign(new Error('request rejected'), { data: { statusCode: 429 } })));
              return Promise.resolve({
                done: false as const,
                value: { type, properties: { info: { sessionID: 'session-1', role: 'assistant' } } },
              });
            }),
            return: vi.fn(async () => ({ done: true as const, value: undefined })),
            throw: vi.fn((error?: unknown) => Promise.reject(error)),
          };
        } },
        successfulRetryPlan(),
      ];
      const { promptAsync } = installOpenCodeMock();
      promptAsync.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPrompt = reject; }));

      const pending = new OpenCodeClient().call('coder', 'prompt', {
        cwd: '/tmp', model: 'opencode/big-pickle',
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(await pending).toMatchObject({ status: 'done', content: 'final answer', retryCount: 1 });
      expect(promptAsync).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['throw', 'timeout'] as const)(
    'promptAsyncの構造化429とiterator.returnの%sが重なっても保存した分類で再試行する', async (closeFailure) => {
      vi.useFakeTimers();
      const iteratorReturn = vi.fn(() => closeFailure === 'throw'
        ? Promise.reject(new Error('iterator close failed'))
        : new Promise<IteratorResult<MockStreamEvent>>(() => {}));
      runPlans = [
        { type: 'stream', createStream: (signal) => createAbortOnlyStream(signal, iteratorReturn) },
        successfulRetryPlan(),
      ];
      const { promptAsync } = installOpenCodeMock();
      promptAsync.mockRejectedValueOnce(Object.assign(new Error('request rejected'), { data: { statusCode: 429 } }));

      const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
      await vi.advanceTimersByTimeAsync(closeFailure === 'timeout' ? 5_000 : 0);
      expect(iteratorReturn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toMatchObject({ status: 'done', content: 'final answer', retryCount: 1 });
      expect(promptAsync).toHaveBeenCalledTimes(2);
    },
  );

  it('promptAsyncの構造化429でもセッション停止に失敗したら再試行しない', async () => {
    runPlans = [{
      type: 'stream',
      createStream: (signal) => createAbortOnlyStream(signal, vi.fn(async () => {
        throw new Error('iterator close failed');
      })),
    }];
    const { promptAsync, abort } = installOpenCodeMock();
    promptAsync.mockRejectedValueOnce(Object.assign(new Error('request rejected'), { data: { statusCode: 429 } }));
    abort.mockRejectedValueOnce(new Error('session abort failed'));

    const result = await new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    expect(result.status).toBe('error');
    expect(result.content).toContain('OpenCode server session abort failed');
    expect(promptAsync).toHaveBeenCalledOnce();
  });

  it.each([
    'usage_limit_exceeded',
    'HTTP 429: Your workspace is out of credits. Add credits to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue. HTTP 429',
  ])('使い切り通知は再試行しない: %s', async (message) => {
    runPlans = [rateLimitPlan(message)];
    const { promptAsync } = installOpenCodeMock();
    expect(await new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' }))
      .toMatchObject({ status: 'rate_limited', content: '', errorKind: 'rate_limit' });
    expect(promptAsync).toHaveBeenCalledOnce();
  });

  it('429の再試行中に使い切り通知を受けたら追加試行しない', async () => {
    vi.useFakeTimers();
    runPlans = [rateLimitPlan('HTTP 429: Too Many Requests'), rateLimitPlan('HTTP 429: usage_limit_exceeded')];
    const { promptAsync } = installOpenCodeMock();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('429以外の一時障害は250msと500msで合計3試行に制限する（最終成功: %s）', async (succeeds) => {
    vi.useFakeTimers();
    runPlans = [rateLimitPlan('fetch failed'), rateLimitPlan('fetch failed'),
      succeeds ? successfulRetryPlan() : rateLimitPlan('fetch failed')];
    const { promptAsync } = installOpenCodeMock();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(249);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: succeeds ? 'done' : 'error', retryCount: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  it.each(['session.error', 'exception'] as const)('%s では通常障害と429が3試行の予算を共有する', async (channel) => {
    vi.useFakeTimers();
    const failure = (message: string): RunPlan => channel === 'session.error'
      ? rateLimitPlan(message)
      : { type: 'stream', createStream: async function* () { throw new Error(message); } };
    runPlans = [failure('fetch failed'), failure('fetch failed'), failure('HTTP 429: Too Many Requests')];
    const { promptAsync } = installOpenCodeMock();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit', retryCount: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  it.each(['session.error', 'exception'] as const)('%s では429によって通常障害の予算を補充しない', async (channel) => {
    vi.useFakeTimers();
    const failure = (message: string): RunPlan => channel === 'session.error'
      ? rateLimitPlan(message)
      : { type: 'stream', createStream: async function* () { throw new Error(message); } };
    runPlans = [failure('HTTP 429: Too Many Requests'), failure('HTTP 429: Too Many Requests'), failure('fetch failed')];
    const { promptAsync } = installOpenCodeMock();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle' });
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ status: 'error', retryCount: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  it('429の待機中に中断したら次のpromptを送信しない', async () => {
    vi.useFakeTimers();
    runPlans = [rateLimitPlan('HTTP 429: Too Many Requests')];
    const { promptAsync, abort } = installOpenCodeMock();
    const controller = new AbortController();
    const pending = new OpenCodeClient().call('coder', 'prompt', { cwd: '/tmp', model: 'opencode/big-pickle', abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(249);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'error' });
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('出力がないと call inactivity timeout で終了する', async () => {
    vi.useFakeTimers();
    runPlans = [{
      type: 'stream',
      createStream: (signal?: AbortSignal) => (async function* () {
        await waitForAbort(signal);
      })(),
    }];
    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { callTimeoutMs: 60_000 },
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.error).toContain('Part timeout after 60000ms');
    expect(result.failureCategory).toBe('part_timeout');
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('call inactivity timeout は全体を abort し retry しない', async () => {
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
    expect(result.error).toContain('Part timeout after 60000ms');
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('call deadline と attempt timeout が同時発生しても PART_TIMEOUT 分類を保持する', async () => {
    let notifyStreamReady!: () => void;
    const streamReady = new Promise<void>((resolve) => {
      notifyStreamReady = resolve;
    });
    runPlans = [{
      type: 'stream',
      createStream: (signal?: AbortSignal) => (async function* () {
        notifyStreamReady();
        await waitForAbort(signal);
      })(),
    }];
    const deadlineFailure: OpenCodeGuardEvaluation = {
      guardId: 'inactivity-timeout',
      verdict: {
        action: 'fail',
        reason: 'Part timeout after 60000ms',
        abortKind: 'deadline',
      },
    };
    const attemptTimeoutFailure: OpenCodeGuardEvaluation = {
      guardId: 'idle-timeout',
      verdict: {
        action: 'fail',
        reason: 'OpenCode attempt timed out',
      },
    };
    let failAttempt: ((failure: OpenCodeGuardEvaluation) => void) | undefined;
    const originalStartAttempt = OpenCodeGuardSuite.prototype.startAttempt;
    const startAttemptSpy = vi.spyOn(OpenCodeGuardSuite.prototype, 'startAttempt')
      .mockImplementation(function captureAttemptFailure(
        this: OpenCodeGuardSuite,
        onFailure: (failure: OpenCodeGuardEvaluation) => void,
      ) {
        failAttempt = onFailure;
        originalStartAttempt.call(this, onFailure);
      });
    const getCallFailureSpy = vi.spyOn(OpenCodeGuardSuite.prototype, 'getCallFailure')
      .mockReturnValue(deadlineFailure);
    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const controller = new AbortController();

    try {
      const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        abortSignal: controller.signal,
      });

      await streamReady;
      if (failAttempt === undefined) {
        throw new Error('OpenCode attempt guard callback was not registered');
      }
      controller.abort(new Error(deadlineFailure.verdict.reason));
      failAttempt(attemptTimeoutFailure);
      const result = await resultPromise;

      expect(result.status).toBe('error');
      expect(result.error).toContain(deadlineFailure.verdict.reason);
      expect(result.failureCategory).toBe('part_timeout');
      expect(sessionCreate).toHaveBeenCalledOnce();
      expect(promptAsync).toHaveBeenCalledOnce();
      expect(subscribe).toHaveBeenCalledOnce();
    } finally {
      startAttemptSpy.mockRestore();
      getCallFailureSpy.mockRestore();
    }
  });

  it('inactivity timeout signal は未完了の prompt 待ちと iterator close を打ち切る', async () => {
    vi.useFakeTimers();
    const iteratorReturn = vi.fn(() => new Promise<IteratorResult<MockStreamEvent>>(() => {}));
    runPlans = [{
      type: 'stream',
      createStream: (signal?: AbortSignal) => createAbortOnlyStream(signal, iteratorReturn),
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
    expect(result.error).toContain('Part timeout after 60000ms');
    expect(iteratorReturn).toHaveBeenCalledOnce();
  });

  it('deadline と event が同時に ready でも以後の callback と reply を実行しない', async () => {
    vi.useFakeTimers();
    runPlans = [{
      type: 'stream',
      createStream: () => createPermissionEventAtDeadlineStream(),
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
    expect(result.error).toContain('Part timeout after 60000ms');
    expect(onStream).toHaveBeenCalledTimes(streamCallsBeforeDeadline);
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(onAskUserQuestion).not.toHaveBeenCalled();
    expect(permissionReply).not.toHaveBeenCalled();
    expect(questionReply).not.toHaveBeenCalled();
    expect(questionReject).not.toHaveBeenCalled();
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
    const onActivity = vi.fn();
    const strictMcpTools = ['takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run'].map((name) => `takt_${name}`);
    const logsDir = mkdtempSync(join(tmpdir(), 'takt-opencode-retry-thinking-'));
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'retry-thinking',
      runId: 'retry-thinking-run',
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
        permissionMode: 'readonly', networkAccess: false,
        allowedTools: ['Read'], allowedMcpTools: strictMcpTools, strictToolAllowlist: ['Read', ...strictMcpTools.map((name) => `mcp__takt__${name.slice(5)}`)],
        onActivity,
        onStream: (event) => {
          providerLogger.logEvent(logContext, event);
          onStream(event);
        },
      });

      expect(result.status, JSON.stringify(result)).toBe('done');
      expect(sessionCreate).toHaveBeenCalledTimes(2);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      for (const [payload] of promptAsync.mock.calls) {
        const tools = payload.tools as Record<string, boolean>;
        expect(Object.keys(tools).filter((name) => tools[name]).sort()).toEqual(['read', ...strictMcpTools].sort());
        expect(tools['*']).toBe(false);
      }
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(onActivity).toHaveBeenCalledTimes(2);
      expect(onActivity).toHaveBeenNthCalledWith(1, { kind: 'attempt_started' });
      expect(onActivity).toHaveBeenNthCalledWith(2, { kind: 'attempt_started' });
      expect(onActivity.mock.invocationCallOrder[1]).toBeLessThan(
        promptAsync.mock.invocationCallOrder[1]!,
      );
      expect(onStream.mock.calls.filter(([event]) => (
        event.type === 'text' && event.data.text === 'transient retry tail'
      ))).toHaveLength(1);
      expect(onStream.mock.calls.filter(([event]) => (
        event.type === 'thinking' && event.data.thinking === 'transient reasoning tail'
      ))).toHaveLength(1);
      expect(JSON.stringify(onStream.mock.calls)).not.toContain('transient-secret');
      expect(result.retryCount).toBe(1);
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

  it('resets the internal inactivity deadline before retry attempt initialization', async () => {
    vi.useFakeTimers();
    runPlans = [
      {
        type: 'events',
        events: [{
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
            error: { name: 'RequestError', data: { message: 'fetch failed' } },
          },
        }],
      },
      {
        type: 'events',
        events: [
          textPartUpdated('session-1', 'recovered', 'recovered'),
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        ],
      },
    ];
    const { sessionCreate, promptAsync, setActiveSessionId } = installOpenCodeMock();
    setActiveSessionId('session-1');
    sessionCreate
      .mockResolvedValueOnce({ data: { id: 'session-1' } })
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ data: { id: 'session-1' } }), 59_900);
      }));
    const onActivity = vi.fn();

    const resultPromise = new OpenCodeClient().call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { callTimeoutMs: 60_000 },
      onActivity,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenNthCalledWith(2, { kind: 'attempt_started' });
    expect(onActivity.mock.invocationCallOrder[1]).toBeLessThan(
      sessionCreate.mock.invocationCallOrder[1]!,
    );

    await vi.advanceTimersByTimeAsync(59_750);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    const result = await resultPromise;

    expect(result.status).toBe('done');
    expect(result.content).toBe('recovered');
    expect(result.retryCount).toBe(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
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

  it('emits and charges only the unseen suffix of cumulative reasoning updates', async () => {
    runPlans = [{
      type: 'events',
      events: [
        reasoningPartUpdated('session-1', 'reasoning-main', 'A'),
        reasoningPartUpdated('session-1', 'reasoning-main', 'AB'),
        { type: 'session.idle', properties: { sessionID: 'session-1' } },
      ],
    }];
    installOpenCodeMock();
    const onStream = vi.fn();

    const result = await new OpenCodeClient().call('interactive', 'hello', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      guards: { reasoningByteLimit: 2 },
      onStream,
    });

    expect(result.status).toBe('done');
    expect(onStream.mock.calls
      .map(([event]) => event as { type: string; data?: { thinking?: string } })
      .filter((event) => event.type === 'thinking')
      .map((event) => event.data?.thinking ?? '')
      .join('')).toBe('AB');
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
    expect(result.failureCategory).toBe('external_abort');
  });
});
