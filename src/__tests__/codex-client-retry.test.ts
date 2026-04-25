import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockEvent[] }
  | { type: 'throw'; error: Error }
  | { type: 'stream'; createEvents: (signal?: AbortSignal) => AsyncGenerator<MockEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
let startThreadCalls: Array<Record<string, unknown> | undefined> = [];
let resumeThreadCalls: Array<{ threadId: string; options?: Record<string, unknown> }> = [];
const CODEX_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function createEvents(events: MockEvent[]) {
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

function createIdleTimeoutPlan(onThreadStarted?: () => void): RunPlan {
  return {
    type: 'stream',
    createEvents: (signal?: AbortSignal) => (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-1' };
      onThreadStarted?.();
      await waitForAbort(signal);
    })(),
  };
}

function createThread(id: string) {
  return {
    id,
    runStreamed: async (_prompt: string, turnOptions?: { signal?: AbortSignal }) => {
      const plan = runPlans[runPlanIndex];
      runPlanIndex += 1;
      if (!plan) {
        throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
      }
      if (plan.type === 'throw') {
        throw plan.error;
      }
      if (plan.type === 'stream') {
        return { events: plan.createEvents(turnOptions?.signal) };
      }
      return { events: createEvents(plan.events) };
    },
  };
}

vi.mock('@openai/codex-sdk', () => {
  return {
    Codex: class MockCodex {
      async startThread(options?: Record<string, unknown>) {
        startThreadCalls.push(options);
        return createThread('thread-1');
      }

      async resumeThread(threadId: string, options?: Record<string, unknown>) {
        resumeThreadCalls.push({ threadId, options });
        return createThread(threadId);
      }
    },
  };
});

const { CodexClient } = await import('../infra/codex/client.js');

describe('CodexClient retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    runPlans = [];
    runPlanIndex = 0;
    startThreadCalls = [];
    resumeThreadCalls = [];
  });

  it('turn.failed の at capacity を 1 秒後に retry して成功を返す', async () => {
    vi.useFakeTimers();

    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
        ],
      },
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'retry succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
        ],
      },
    ];

    const client = new CodexClient();

    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    await vi.advanceTimersByTimeAsync(999);
    expect(resumeThreadCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toEqual([
      {
        threadId: 'thread-1',
        options: expect.objectContaining({ workingDirectory: '/tmp' }),
      },
    ]);
    expect(result.status).toBe('done');
    expect(result.content).toBe('retry succeeded');
  });

  it('例外経路の at capacity を 1 秒、2 秒の指数バックオフで retry する', async () => {
    vi.useFakeTimers();

    runPlans = [
      { type: 'throw', error: new Error('Selected model is at capacity. Please try a different model.') },
      { type: 'throw', error: new Error('Selected model is at capacity. Please try a different model.') },
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'third attempt succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } },
        ],
      },
    ];

    const client = new CodexClient();

    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    await vi.advanceTimersByTimeAsync(999);
    expect(resumeThreadCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(resumeThreadCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(resumeThreadCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(resumeThreadCalls).toHaveLength(2);
    expect(result.status).toBe('done');
    expect(result.content).toBe('third attempt succeeded');
  });

  it('at capacity が続く場合は 初回実行後に 8 回 retry して最後の失敗を返す', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'events' as const,
      events: [
        { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
      ],
    }));

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(8);
    expect(result.status).toBe('error');
    expect(result.content).toBe('Selected model is at capacity. Please try a different model.');
  });

  it('at capacity が続く場合は 128 秒バックオフまで待ってから最後の retry を行う', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'events' as const,
      events: [
        { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
      ],
    }));

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    const retryDelaysMs = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
    let elapsedMs = 0;

    for (let index = 0; index < retryDelaysMs.length; index += 1) {
      const delayMs = retryDelaysMs[index];
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(resumeThreadCalls).toHaveLength(index);

      await vi.advanceTimersByTimeAsync(1);
      elapsedMs += delayMs;
      expect(resumeThreadCalls).toHaveLength(index + 1);
      expect(elapsedMs).toBe(retryDelaysMs.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
    }

    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(8);
    expect(elapsedMs).toBe(255000);
    expect(result.status).toBe('error');
    expect(result.content).toBe('Selected model is at capacity. Please try a different model.');
  });

  it('ストリームの idle timeout を 1 回 retry して成功を返す', async () => {
    vi.useFakeTimers();

    runPlans = [
      createIdleTimeoutPlan(),
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg-timeout', type: 'agent_message', text: 'timeout retry succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      },
    ];

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(resumeThreadCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(resumeThreadCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(resumeThreadCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toEqual([
      {
        threadId: 'thread-1',
        options: expect.objectContaining({ workingDirectory: '/tmp' }),
      },
    ]);
    expect(result.status).toBe('done');
    expect(result.content).toBe('timeout retry succeeded');
  });

  it('ストリームの idle timeout は最大 2 回まで retry して停止する', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 3 }, () => createIdleTimeoutPlan());

    const client = new CodexClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp', onStream });

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS + 1000);
    expect(resumeThreadCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS + 2000);
    expect(resumeThreadCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS);
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(2);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('stream_idle_timeout');
    expect(result.content).toBe('Codex stream timed out after 10 minutes of inactivity');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: 'Codex stream timed out after 10 minutes of inactivity',
        failureCategory: 'stream_idle_timeout',
      }),
    });
  });

  it('non-retriable provider error は provider_error 分類を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'turn.failed', error: { message: 'Upstream model returned 500' } },
        ],
      },
    ];

    const client = new CodexClient();
    const onStream = vi.fn();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', onStream });

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_error');
    expect(result.content).toBe('Upstream model returned 500');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: 'Upstream model returned 500',
        failureCategory: 'provider_error',
      }),
    });
  });

  it('通常 retry を 8 回使い切った後でも idle timeout を retry して成功を返す', async () => {
    vi.useFakeTimers();

    runPlans = [
      ...Array.from({ length: 8 }, () => ({
        type: 'events' as const,
        events: [
          { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
        ],
      })),
      createIdleTimeoutPlan(),
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg-timeout-after-capacity', type: 'agent_message', text: 'mixed retry succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      },
    ];

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    const transientRetryDelaysMs = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
    for (let index = 0; index < transientRetryDelaysMs.length; index += 1) {
      await vi.advanceTimersByTimeAsync(transientRetryDelaysMs[index]);
      expect(resumeThreadCalls).toHaveLength(index + 1);
    }

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(resumeThreadCalls).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(1);
    expect(resumeThreadCalls).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(256000 - 1);
    expect(resumeThreadCalls).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(9);
    expect(result.status).toBe('done');
    expect(result.content).toBe('mixed retry succeeded');
  });

  it('external abort は retry せずに停止する', async () => {
    let notifyStreamReady!: () => void;
    const streamReady = new Promise<void>((resolve) => {
      notifyStreamReady = resolve;
    });

    runPlans = [
      createIdleTimeoutPlan(() => {
        notifyStreamReady();
      }),
    ];

    const controller = new AbortController();
    const client = new CodexClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      abortSignal: controller.signal,
      onStream,
    });

    await streamReady;
    controller.abort(new Error('Workflow interrupted by user (SIGINT)'));
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('external_abort');
    expect(result.content).toContain('external abort');
    expect(result.content).toContain('Workflow interrupted by user (SIGINT)');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('external abort'),
        failureCategory: 'external_abort',
      }),
    });
  });

  it('part timeout abort は retry せずに timeout分類を返す', async () => {
    let notifyStreamReady!: () => void;
    const streamReady = new Promise<void>((resolve) => {
      notifyStreamReady = resolve;
    });

    runPlans = [
      createIdleTimeoutPlan(() => {
        notifyStreamReady();
      }),
    ];

    const controller = new AbortController();
    const client = new CodexClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      abortSignal: controller.signal,
      onStream,
    });

    await streamReady;
    controller.abort(new Error('Part timeout after 1000ms'));
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('part_timeout');
    expect(result.content).toContain('part timeout');
    expect(result.content).toContain('Part timeout after 1000ms');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('part timeout'),
        failureCategory: 'part_timeout',
      }),
    });
  });

  it('call 前に aborted 済み signal でも part_timeout 分類を返す', async () => {
    runPlans = [
      { type: 'throw', error: new Error('stream aborted before run') },
    ];

    const controller = new AbortController();
    controller.abort(new Error('Part timeout after 2000ms'));

    const client = new CodexClient();
    const onStream = vi.fn();
    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      abortSignal: controller.signal,
      onStream,
    });

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('part_timeout');
    expect(result.content).toContain('part timeout');
    expect(result.content).toContain('Part timeout after 2000ms');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('part timeout'),
        failureCategory: 'part_timeout',
      }),
    });
  });

  it('retry delay 中の abort は external_abort 分類を返して retry しない', async () => {
    vi.useFakeTimers();

    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
        ],
      },
    ];

    const controller = new AbortController();
    const client = new CodexClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', {
      cwd: '/tmp',
      abortSignal: controller.signal,
      onStream,
    });

    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('Workflow interrupted by user (SIGINT)'));
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('external_abort');
    expect(result.content).toContain('external abort');
    expect(result.content).toContain('Workflow interrupted by user (SIGINT)');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('external abort'),
        failureCategory: 'external_abort',
      }),
    });
  });
});
