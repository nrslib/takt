import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockEvent[] }
  | { type: 'throw'; error: Error }
  | { type: 'stream'; createEvents: (signal?: AbortSignal) => AsyncGenerator<MockEvent> };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;
let startThreadCalls: Array<Record<string, unknown> | undefined> = [];
let resumeThreadCalls: Array<{ threadId: string; options?: Record<string, unknown> }> = [];
let runStreamedInputs: unknown[] = [];
const CODEX_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_RECONNECT_FAILURE_MESSAGE = 'Reconnecting... 2/5 (timeout waiting for child process to exit)';
const CODEX_RETRY_MAX_DELAY_MS = 30_000;
const CODEX_CAPPED_RETRY_DELAYS_MS = [
  1000,
  2000,
  4000,
  8000,
  16000,
  CODEX_RETRY_MAX_DELAY_MS,
  CODEX_RETRY_MAX_DELAY_MS,
  CODEX_RETRY_MAX_DELAY_MS,
];
const CODEX_RECONNECT_RETRYABLE_MESSAGES = [
  'Reconnecting... 2/5',
  'timeout waiting for child process to exit',
  CODEX_RECONNECT_FAILURE_MESSAGE,
];

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

function createReconnectCommandFailureEvents(message: string, command: string): MockEvent[] {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-e2e',
        type: 'command_execution',
        command,
      },
    },
    { type: 'turn.failed', error: { message } },
  ];
}

function createThread(id: string) {
  return {
    id,
    runStreamed: async (input: unknown, turnOptions?: { signal?: AbortSignal }) => {
      runStreamedInputs.push(input);
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
    runStreamedInputs = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('turn.failed が rate limit を示す場合は retry せず rate_limited を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'turn.failed', error: { message: 'HTTP 429: rate limit exceeded' } },
        ],
      },
    ];

    const client = new CodexClient();

    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('rate_limited');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.content).toBe('');
  });

  it('imageAttachments がある場合は Codex SDK に local_image 入力として渡す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'saw image' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
        ],
      },
    ];

    const client = new CodexClient();

    const result = await client.call('coder', 'この画像を見て [Image #1]', {
      cwd: '/tmp',
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
    });

    expect(result.status).toBe('done');
    expect(runStreamedInputs[0]).toEqual([
      { type: 'text', text: 'この画像を見て [Image #1]' },
      { type: 'text', text: '[Image #1] path: `/tmp/image-1.png`' },
      { type: 'local_image', path: '/tmp/image-1.png' },
    ]);
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

  it('at capacity が続く場合は 30 秒 cap で最後の retry を行う', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'events' as const,
      events: [
        { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } },
      ],
    }));

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });

    let elapsedMs = 0;

    for (let index = 0; index < CODEX_CAPPED_RETRY_DELAYS_MS.length; index += 1) {
      const delayMs = CODEX_CAPPED_RETRY_DELAYS_MS[index];
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(resumeThreadCalls).toHaveLength(index);

      await vi.advanceTimersByTimeAsync(1);
      elapsedMs += delayMs;
      expect(resumeThreadCalls).toHaveLength(index + 1);
      expect(elapsedMs).toBe(CODEX_CAPPED_RETRY_DELAYS_MS.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
    }

    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(8);
    expect(elapsedMs).toBe(121000);
    expect(result.status).toBe('error');
    expect(result.content).toBe('Selected model is at capacity. Please try a different model.');
  });

  it.each(CODEX_RECONNECT_RETRYABLE_MESSAGES)(
    'turn.failed の %s provider_error を 1 秒後に retry して成功を返す',
    async (reconnectMessage) => {
      vi.useFakeTimers();

      runPlans = [
        {
          type: 'events',
          events: [
            { type: 'thread.started', thread_id: 'thread-1' },
            { type: 'turn.failed', error: { message: reconnectMessage } },
          ],
        },
        {
          type: 'events',
          events: [
            { type: 'thread.started', thread_id: 'thread-1' },
            { type: 'item.completed', item: { id: 'msg-reconnect', type: 'agent_message', text: 'reconnect retry succeeded' } },
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
      expect(result.content).toBe('reconnect retry succeeded');
    },
  );

  it('stream error event の Reconnecting provider_error は retry せず同一 stream を継続して成功を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'error', message: CODEX_RECONNECT_FAILURE_MESSAGE },
          { type: 'item.completed', item: { id: 'msg-reconnect-event-error', type: 'agent_message', text: 'stream error continued' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
        ],
      },
    ];

    const client = new CodexClient();

    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('done');
    expect(result.content).toBe('stream error continued');
  });

  it('stream error event 後に有効な出力があれば turn.completed なしの自然終了でも成功を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'error', message: CODEX_RECONNECT_FAILURE_MESSAGE },
          { type: 'item.completed', item: { id: 'msg-reconnect-event-output', type: 'agent_message', text: 'stream output without turn completed' } },
        ],
      },
    ];

    const client = new CodexClient();

    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(0);
    expect(result.status).toBe('done');
    expect(result.content).toBe('stream output without turn completed');
  });

  it('stream error event だけで自然終了した場合は retry せず最後の error を provider_error として返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'error', message: CODEX_RECONNECT_FAILURE_MESSAGE },
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
    expect(result.content).toContain(CODEX_RECONNECT_FAILURE_MESSAGE);
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining(CODEX_RECONNECT_FAILURE_MESSAGE),
        failureCategory: 'provider_error',
      }),
    });
  });

  it('command 実行中に stream error event だけで自然終了した場合は retry せず reconnect 診断を返す', async () => {
    runPlans = [
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          {
            type: 'item.started',
            item: {
              id: 'cmd-stream-error',
              type: 'command_execution',
              command: 'npm run test:e2e:mock',
            },
          },
          { type: 'error', message: CODEX_RECONNECT_FAILURE_MESSAGE },
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
    expect(result.content).toContain('provider reconnect failure');
    expect(result.content).toContain(CODEX_RECONNECT_FAILURE_MESSAGE);
    expect(result.content).toContain('Active tool: Bash');
    expect(result.content).toContain('Bash command: npm run test:e2e:mock');
    expect(result.content).toContain('Command result: unknown');
    const resultEvent = onStream.mock.calls.find(([event]) => event.type === 'result')?.[0];
    expect(resultEvent).toEqual({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.any(String),
        failureCategory: 'provider_error',
      }),
    });
    expect(resultEvent?.data.error).toContain('provider reconnect failure');
    expect(resultEvent?.data.error).toContain('Active tool: Bash');
    expect(resultEvent?.data.error).toContain('Bash command: npm run test:e2e:mock');
    expect(resultEvent?.data.error).toContain('Command result: unknown');
  });

  it.each(CODEX_RECONNECT_RETRYABLE_MESSAGES)(
    '例外経路の %s provider_error を 1 秒後に retry して成功を返す',
    async (reconnectMessage) => {
      vi.useFakeTimers();

      runPlans = [
        { type: 'throw', error: new Error(reconnectMessage) },
        {
          type: 'events',
          events: [
            { type: 'thread.started', thread_id: 'thread-1' },
            { type: 'item.completed', item: { id: 'msg-reconnect-exception', type: 'agent_message', text: 'exception retry succeeded' } },
            { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } },
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
      expect(result.content).toBe('exception retry succeeded');
    },
  );

  it('Reconnecting 系 provider_error の retry を使い切った場合は実行中 command の結果不明を診断する', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'events' as const,
      events: [
        ...createReconnectCommandFailureEvents(
          CODEX_RECONNECT_FAILURE_MESSAGE,
          'npm run test:e2e:mock',
        ),
      ],
    }));

    const client = new CodexClient();
    const onStream = vi.fn();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp', onStream });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(8);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_error');
    expect(result.content).toContain('provider reconnect failure');
    expect(result.content).toContain(CODEX_RECONNECT_FAILURE_MESSAGE);
    expect(result.content).toContain('Active tool: Bash');
    expect(result.content).toContain('Bash command: npm run test:e2e:mock');
    expect(result.content).toContain('Command result: unknown');
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: expect.stringContaining('provider reconnect failure'),
        failureCategory: 'provider_error',
      }),
    });
  });

  it('例外経路の Reconnecting 系 provider_error の retry を使い切った場合も実行中 command の結果不明を診断する', async () => {
    vi.useFakeTimers();

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'stream' as const,
      createEvents: async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        yield {
          type: 'item.started',
          item: {
            id: 'cmd-exception',
            type: 'command_execution',
            command: 'npm run test:e2e:mock',
          },
        };
        throw new Error(CODEX_RECONNECT_FAILURE_MESSAGE);
      },
    }));

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(startThreadCalls).toHaveLength(1);
    expect(resumeThreadCalls).toHaveLength(8);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_error');
    expect(result.content).toContain('provider reconnect failure');
    expect(result.content).toContain(CODEX_RECONNECT_FAILURE_MESSAGE);
    expect(result.content).toContain('Active tool: Bash');
    expect(result.content).toContain('Bash command: npm run test:e2e:mock');
    expect(result.content).toContain('Command result: unknown');
  });

  it('Reconnecting 系 provider_error の command 診断は機密値をマスクする', async () => {
    vi.useFakeTimers();

    const secretCommand = [
      'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz"',
      'curl -H "Authorization: Basic dXNlcjpwYXNz"',
      'curl -H "Authorization:    Bearer leading-space-token"',
      'curl -H "Cookie: sessionid=plain-session-id; theme=dark"',
      'curl -H "Set-Cookie: sessionid=set-cookie-secret; Path=/"',
      'curl -u user:plain-password',
      'curl -uuser:compact-password',
      'curl --user other:other-password',
      'curl --user=third:third-password',
      'curl --proxy-user proxy:proxy-password',
      'curl --proxy-user=proxy-eq:proxy-eq-password',
      'curl https://url-user:url-password@example.test/path',
      'https://example.test?api_key=query-secret',
      '--token ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'OPENAI_API_KEY=sk-proj-secret_1234567890',
      "PASSWORD='correct horse battery staple'",
      "AWS_SECRET_ACCESS_KEY='aws secret phrase with spaces'",
      'SERVICE_PRIVATE_KEY="private key phrase with spaces"',
      '--aws-access-key-id access-key-secret',
      'PASSWORD="abc\\" double assignment leaked tail"',
      "SECRET='abc\\' single assignment leaked tail'",
      '--token "abc\\" double option leaked tail"',
      "--private-key 'abc\\' single option leaked tail'",
    ].join(' ');

    runPlans = Array.from({ length: 9 }, () => ({
      type: 'events' as const,
      events: [
        { type: 'thread.started', thread_id: 'thread-1' },
        {
          type: 'item.started',
          item: {
            id: 'cmd-secret',
            type: 'command_execution',
            command: secretCommand,
          },
        },
        { type: 'turn.failed', error: { message: CODEX_RECONNECT_FAILURE_MESSAGE } },
      ],
    }));

    const client = new CodexClient();
    const resultPromise = client.call('coder', 'prompt', { cwd: '/tmp' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(result.content).toContain('Bash command:');
    expect(result.content).toContain('Authorization: Bearer [REDACTED]');
    expect(result.content).toContain('Authorization: Basic [REDACTED]');
    expect(result.content).toContain('Authorization:    Bearer [REDACTED]');
    expect(result.content).toContain('Cookie: [REDACTED]');
    expect(result.content).toContain('Set-Cookie: [REDACTED]');
    expect(result.content).toContain('-u [REDACTED]');
    expect(result.content).toContain('-u[REDACTED]');
    expect(result.content).toContain('--user [REDACTED]');
    expect(result.content).toContain('--user=[REDACTED]');
    expect(result.content).toContain('--proxy-user [REDACTED]');
    expect(result.content).toContain('--proxy-user=[REDACTED]');
    expect(result.content).toContain('https://[REDACTED]@example.test/path');
    expect(result.content).toContain('api_key=[REDACTED]');
    expect(result.content).toContain('--token [REDACTED]');
    expect(result.content).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(result.content).toContain("PASSWORD='[REDACTED]'");
    expect(result.content).toContain("AWS_SECRET_ACCESS_KEY='[REDACTED]'");
    expect(result.content).toContain('SERVICE_PRIVATE_KEY="[REDACTED]"');
    expect(result.content).toContain('--aws-access-key-id [REDACTED]');
    expect(result.content).toContain('PASSWORD="[REDACTED]"');
    expect(result.content).toContain("SECRET='[REDACTED]'");
    expect(result.content).toContain('--private-key [REDACTED]');
    expect(result.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(result.content).not.toContain('dXNlcjpwYXNz');
    expect(result.content).not.toContain('leading-space-token');
    expect(result.content).not.toContain('plain-session-id');
    expect(result.content).not.toContain('set-cookie-secret');
    expect(result.content).not.toContain('plain-password');
    expect(result.content).not.toContain('compact-password');
    expect(result.content).not.toContain('other-password');
    expect(result.content).not.toContain('third-password');
    expect(result.content).not.toContain('proxy-password');
    expect(result.content).not.toContain('proxy-eq-password');
    expect(result.content).not.toContain('url-password');
    expect(result.content).not.toContain('query-secret');
    expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.content).not.toContain('sk-proj-secret_1234567890');
    expect(result.content).not.toContain('correct horse battery staple');
    expect(result.content).not.toContain('aws secret phrase with spaces');
    expect(result.content).not.toContain('private key phrase with spaces');
    expect(result.content).not.toContain('access-key-secret');
    expect(result.content).not.toContain('double assignment leaked tail');
    expect(result.content).not.toContain('single assignment leaked tail');
    expect(result.content).not.toContain('double option leaked tail');
    expect(result.content).not.toContain('single option leaked tail');
    expect(result.error).not.toContain('correct horse battery staple');
    expect(result.error).not.toContain('dXNlcjpwYXNz');
    expect(result.error).not.toContain('leading-space-token');
    expect(result.error).not.toContain('plain-session-id');
    expect(result.error).not.toContain('set-cookie-secret');
    expect(result.error).not.toContain('plain-password');
    expect(result.error).not.toContain('compact-password');
    expect(result.error).not.toContain('other-password');
    expect(result.error).not.toContain('third-password');
    expect(result.error).not.toContain('proxy-password');
    expect(result.error).not.toContain('proxy-eq-password');
    expect(result.error).not.toContain('url-password');
    expect(result.error).not.toContain('aws secret phrase with spaces');
    expect(result.error).not.toContain('private key phrase with spaces');
    expect(result.error).not.toContain('access-key-secret');
    expect(result.error).not.toContain('double assignment leaked tail');
    expect(result.error).not.toContain('single assignment leaked tail');
    expect(result.error).not.toContain('double option leaked tail');
    expect(result.error).not.toContain('single option leaked tail');
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

    for (let index = 0; index < CODEX_CAPPED_RETRY_DELAYS_MS.length; index += 1) {
      await vi.advanceTimersByTimeAsync(CODEX_CAPPED_RETRY_DELAYS_MS[index]);
      expect(resumeThreadCalls).toHaveLength(index + 1);
    }

    await vi.advanceTimersByTimeAsync(CODEX_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(resumeThreadCalls).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(1);
    expect(resumeThreadCalls).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(CODEX_RETRY_MAX_DELAY_MS - 1);
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
