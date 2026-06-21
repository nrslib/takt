import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

type MockStreamEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockStreamEvent[] }
  | { type: 'stream'; createStream: (signal?: AbortSignal) => AsyncGenerator<MockStreamEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
const OPENCODE_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;

function createEvents(events: MockStreamEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
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

// Resolves (does NOT throw) when the stream is aborted, so the consumer loop
// exits via a clean break (its `if (signal.aborted) break`) instead of the
// catch path. Used to exercise the try-internal error return.
function waitForAbortClean(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener('abort', () => resolve(), { once: true });
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
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: 'session-1' } });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn().mockImplementation(async (_payload: unknown, options?: { signal?: AbortSignal }) => {
    const plan = runPlans[runPlanIndex];
    runPlanIndex += 1;
    if (!plan) {
      throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
    }
    if (plan.type === 'stream') {
      return { stream: plan.createStream(options?.signal) };
    }
    return { stream: createEvents(plan.events) };
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

  return { sessionCreate, promptAsync, subscribe };
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
    expect(result.retryCount).toBeUndefined();
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
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        ],
      },
    ];

    const { sessionCreate, promptAsync, subscribe } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(sessionCreate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(sessionCreate).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('done');
    expect(result.content).toBe('timeout retry succeeded');
    expect(result.retryCount).toBe(1);
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
    expect(result.status).toBe('error');
    expect(result.content).toBe('OpenCode stream timed out after 10 minutes of inactivity');
    expect(result.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT);
    expect(result.retryCount).toBe(2);

    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: {
          name: 'implement',
          persona: '../agents/coder.md',
          instruction: 'Implement',
        },
        iteration: 1,
        providerInfo: {
          provider: 'opencode',
          model: 'opencode/big-pickle',
        },
      }, async () => ({
        response: result,
        instruction: 'Implement',
        providerInfo: {
          provider: 'opencode',
          model: 'opencode/big-pickle',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'opencode',
      'takt.model.name': 'opencode/big-pickle',
      'takt.provider.error_type': AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
    })?.value).toBe(1);
  });

  it('idle timeout が try 内の error return 経路でも STREAM_IDLE_TIMEOUT を付与する', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: OPENCODE_RETRY_MAX_ATTEMPTS }, () => ({
      type: 'stream' as const,
      // Clean break: the stream loop exits via its abort check, never throwing,
      // so completion flows through the try block (not the catch block).
      createStream: (signal?: AbortSignal) => (async function* () {
        await waitForAbortClean(signal);
      })(),
    }));

    const { promptAsync } = installOpenCodeMock();
    // Keep the prompt pending so the post-loop completion check (not the catch
    // block) marks the attempt as failed via the prompt-completion timeout,
    // while abortCause stays 'timeout' from the idle abort.
    promptAsync.mockImplementation(() => new Promise(() => {}));

    const client = new OpenCodeClient();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    for (let attempt = 0; attempt < OPENCODE_RETRY_MAX_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(OPENCODE_STREAM_IDLE_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(OPENCODE_INTERACTION_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(OPENCODE_RETRY_BASE_DELAY_MS * (2 ** attempt));
    }

    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT);
    expect(result.retryCount).toBe(OPENCODE_RETRY_MAX_ATTEMPTS - 1);
  });

  it('try 内の error return が timeout 以外の中断では failureCategory を付与しない', async () => {
    runPlans = [
      {
        type: 'stream',
        // Clean break so the prompt-error completion flows through the try block.
        createStream: (signal?: AbortSignal) => (async function* () {
          await waitForAbortClean(signal);
        })(),
      },
    ];

    const { promptAsync } = installOpenCodeMock();
    // A non-retryable prompt failure aborts with abortCause 'prompt' (not
    // 'timeout'), so the try-internal return must not attach a failureCategory.
    promptAsync.mockRejectedValue(new Error('fatal validation error'));

    const client = new OpenCodeClient();
    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.content).toBe('fatal validation error');
    expect(result.failureCategory).toBeUndefined();
    expect(result.retryCount).toBeUndefined();
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
