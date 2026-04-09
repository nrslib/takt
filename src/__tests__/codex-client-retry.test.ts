import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockEvent[] }
  | { type: 'throw'; error: Error };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
let startThreadCalls: Array<Record<string, unknown> | undefined> = [];
let resumeThreadCalls: Array<{ threadId: string; options?: Record<string, unknown> }> = [];

function createEvents(events: MockEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function createThread(id: string) {
  return {
    id,
    runStreamed: async () => {
      const plan = runPlans[runPlanIndex];
      runPlanIndex += 1;
      if (!plan) {
        throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
      }
      if (plan.type === 'throw') {
        throw plan.error;
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
});
