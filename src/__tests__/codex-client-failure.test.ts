import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCallOptions } from '../infra/codex/types.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';

const {
  ensurePrivateDirectoryMock,
  writeNewPrivateFileWithModeMock,
  infoMock,
  warnMock,
} = vi.hoisted(() => ({
  ensurePrivateDirectoryMock: vi.fn(),
  writeNewPrivateFileWithModeMock: vi.fn(),
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: infoMock,
      warn: warnMock,
      error: vi.fn(),
      enter: vi.fn(),
      exit: vi.fn(),
    })),
  };
});

vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  return {
    ...actual,
    ensurePrivateDirectory: ensurePrivateDirectoryMock,
    writeNewPrivateFileWithMode: writeNewPrivateFileWithModeMock,
  };
});

type MockEvent = Record<string, unknown>;
type RunPlan =
  | { type: 'events'; events: MockEvent[] }
  | { type: 'iterator-throw'; error: Error };

let runPlans: RunPlan[] = [];
let runPlanIndex = 0;

function createEvents(events: MockEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function createThrowingEvents(error: Error) {
  return (async function* () {
    throw error;
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
      if (plan.type === 'iterator-throw') {
        return { events: createThrowingEvents(plan.error) };
      }
      return { events: createEvents(plan.events) };
    },
  };
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class MockCodex {
    async startThread() {
      return createThread('thread-1');
    }

    async resumeThread(threadId: string) {
      return createThread(threadId);
    }
  },
}));

const { CodexClient } = await import('../infra/codex/client.js');

const FAILURE_DIR = '/project/.takt/runs/run-1/failures';

function createFailureOptions(): CodexCallOptions {
  return {
    cwd: '/project',
    failureDir: FAILURE_DIR,
  };
}

function createParseFailurePlan(message: string): RunPlan {
  return { type: 'iterator-throw', error: new Error(message) };
}

function createTurnFailedPlan(message: string): RunPlan {
  return {
    type: 'events',
    events: [{ type: 'turn.failed', error: { message } }],
  };
}

async function assertOversizedRateLimitResponseIsBounded(
  createPlan: (message: string) => RunPlan,
): Promise<void> {
  const failureMessage = `HTTP 429: ${'x'.repeat(10000)}`;
  runPlans = [createPlan(failureMessage)];

  const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

  expect(result.status).toBe('rate_limited');
  expect(result.error).toContain('HTTP 429:');
  expect(result.error).toMatch(/\[TRUNCATED: \d+ bytes, full text:/);
  expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
  expect(Buffer.byteLength(result.error ?? '', 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
  expect(ensurePrivateDirectoryMock).toHaveBeenCalledWith(FAILURE_DIR);
  expect(writeNewPrivateFileWithModeMock).toHaveBeenCalledOnce();
  expect(writeNewPrivateFileWithModeMock.mock.calls[0]?.[1]).toBe(failureMessage);
}

describe('CodexClient failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    runPlans = [];
    runPlanIndex = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should fail fast with a dedicated category when the SDK cannot parse stdout', async () => {
    runPlans = [createParseFailurePlan('Failed to parse item: invalid stdout line')];
    const onStream = vi.fn();

    const result = await new CodexClient().call('coder', 'prompt', {
      ...createFailureOptions(),
      onStream,
    });

    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_stream_parse_error');
    expect(result.error).toContain('Failed to parse item: invalid stdout line');
    expect(runPlanIndex).toBe(1);
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        failureCategory: 'provider_stream_parse_error',
        error: expect.stringContaining('Failed to parse item: invalid stdout line'),
      }),
    });
  });

  it('should classify an iterator parse failure as parse error even when the detail contains rate-limit text', async () => {
    runPlans = [createParseFailurePlan(`Failed to parse item: ${'x'.repeat(9000)} 429 Too Many Requests`)];

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_stream_parse_error');
    expect(result.error).toContain('[TRUNCATED:');
    expect(runPlanIndex).toBe(1);
  });

  it('should classify a turn.failed parse failure as parse error even when the detail contains rate-limit text', async () => {
    runPlans = [createTurnFailedPlan('Failed to parse item: invalid stdout line; 429 Too Many Requests')];

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_stream_parse_error');
    expect(result.error).toContain('Failed to parse item: invalid stdout line');
    expect(runPlanIndex).toBe(1);
  });

  it('should bound an oversized rate-limit error from an iterator failure', async () => {
    await assertOversizedRateLimitResponseIsBounded(createParseFailurePlan);
  });

  it('should bound an oversized rate-limit error from turn.failed', async () => {
    await assertOversizedRateLimitResponseIsBounded(createTurnFailedPlan);
  });

  it('should keep the generic category when the parse phrase is not at the start', async () => {
    runPlans = [createParseFailurePlan('prefix: Failed to parse item: invalid stdout line')];

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.failureCategory).toBe('provider_error');
    expect(runPlanIndex).toBe(1);
  });

  it('should persist oversized failure text and return a traceable bounded message', async () => {
    const failureMessage = `Upstream failure: ${'あ'.repeat(10000)}`;
    runPlans = [createParseFailurePlan(failureMessage)];
    const onStream = vi.fn();

    const result = await new CodexClient().call('coder', 'prompt', {
      ...createFailureOptions(),
      onStream,
    });
    const writtenPath = String(writeNewPrivateFileWithModeMock.mock.calls[0]?.[0]);
    const writtenText = String(writeNewPrivateFileWithModeMock.mock.calls[0]?.[1]);

    expect(ensurePrivateDirectoryMock).toHaveBeenCalledWith(FAILURE_DIR);
    expect(writeNewPrivateFileWithModeMock).toHaveBeenCalledOnce();
    expect(writeNewPrivateFileWithModeMock.mock.calls[0]?.[2]).toBe(0o600);
    expect(writtenPath.startsWith(`${FAILURE_DIR}/`)).toBe(true);
    expect(writtenText).toBe(failureMessage);
    expect(result.error).toBeDefined();
    expect(Buffer.byteLength(result.error ?? '', 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(result.error).toContain('Upstream failure:');
    expect(result.error).toContain(
      `[TRUNCATED: `,
    );
    expect(result.error).toContain(
      `full text: .takt/runs/run-1/failures/${basename(writtenPath)}]`,
    );
    const marker = result.error?.match(/\[TRUNCATED: (\d+) bytes, full text:/);
    expect(marker).not.toBeNull();
    const prefix = result.error?.slice(0, result.error.indexOf('[TRUNCATED')) ?? '';
    expect(failureMessage.startsWith(prefix)).toBe(true);
    expect(Number(marker?.[1])).toBe(Buffer.byteLength(failureMessage) - Buffer.byteLength(prefix));
    expect(onStream).toHaveBeenLastCalledWith({
      type: 'result',
      data: expect.objectContaining({
        success: false,
        error: result.error,
      }),
    });
  });

  it('should use a different failure file for each oversized failure', async () => {
    runPlans = [
      createParseFailurePlan(`first failure: ${'a'.repeat(9000)}`),
      createParseFailurePlan(`second failure: ${'b'.repeat(9000)}`),
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', createFailureOptions());
    await client.call('coder', 'prompt', createFailureOptions());

    const paths = writeNewPrivateFileWithModeMock.mock.calls.map((call) => String(call[0]));
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((path) => path.startsWith(`${FAILURE_DIR}/`))).toBe(true);
  });

  it('should preserve an error at the maximum byte boundary without creating a file', async () => {
    const failureMessage = `${'あ'.repeat(2730)}ab`;
    expect(Buffer.byteLength(failureMessage, 'utf8')).toBe(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    runPlans = [createParseFailurePlan(failureMessage)];

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.error).toBe(failureMessage);
    expect(ensurePrivateDirectoryMock).not.toHaveBeenCalled();
    expect(writeNewPrivateFileWithModeMock).not.toHaveBeenCalled();
  });

  it('should keep failure reporting alive with a pathless marker when persistence fails', async () => {
    const failureMessage = `Upstream failure: ${'長い内容'.repeat(3000)}`;
    runPlans = [createParseFailurePlan(failureMessage)];
    writeNewPrivateFileWithModeMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_error');
    expect(result.error).toMatch(/\[TRUNCATED: \d+ bytes\]/);
    expect(result.error).not.toContain('full text:');
    expect(Buffer.byteLength(result.error ?? '', 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(warnMock).toHaveBeenCalledWith(
      'Failed to persist full Codex failure text',
      expect.objectContaining({ failureDir: FAILURE_DIR, error: 'disk full' }),
    );
  });

  it('should not retry when a retryable pattern appears only after the retry prefix', async () => {
    vi.useFakeTimers();
    runPlans = [createParseFailurePlan(`${'x'.repeat(MAX_AGENT_FAILURE_MESSAGE_BYTES)} network error`)];

    const resultPromise = new CodexClient().call('coder', 'prompt', createFailureOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(runPlanIndex).toBe(1);
    expect(result.status).toBe('error');
  });

  it('should bound the transient stream failure message before logging it', async () => {
    vi.useFakeTimers();
    const failureMessage = `network error: ${'x'.repeat(10000)}`;
    runPlans = [
      createTurnFailedPlan(failureMessage),
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-retry' },
          { type: 'item.completed', item: { id: 'message-retry', type: 'agent_message', text: 'retry succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      },
    ];

    const resultPromise = new CodexClient().call('coder', 'prompt', createFailureOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    const retryLog = infoMock.mock.calls[0]?.[1] as { message?: string } | undefined;
    expect(retryLog?.message).toMatch(/\[TRUNCATED: \d+ bytes, full text:/);
    expect(Buffer.byteLength(retryLog?.message ?? '', 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(writeNewPrivateFileWithModeMock.mock.calls[0]?.[1]).toBe(failureMessage);
    expect(result.status).toBe('done');
  });

  it('should bound the transient exception message before logging it', async () => {
    vi.useFakeTimers();
    const failureMessage = `network error: ${'x'.repeat(10000)}`;
    runPlans = [
      createParseFailurePlan(failureMessage),
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-retry' },
          { type: 'item.completed', item: { id: 'message-retry', type: 'agent_message', text: 'retry succeeded' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      },
    ];

    const resultPromise = new CodexClient().call('coder', 'prompt', createFailureOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    const retryLog = infoMock.mock.calls[0]?.[1] as { errorMessage?: string } | undefined;
    expect(retryLog?.errorMessage).toMatch(/\[TRUNCATED: \d+ bytes, full text:/);
    expect(Buffer.byteLength(retryLog?.errorMessage ?? '', 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(writeNewPrivateFileWithModeMock.mock.calls[0]?.[1]).toBe(failureMessage);
    expect(result.status).toBe('done');
  });

  it('should not retry a provider stream parse failure containing a retryable pattern', async () => {
    vi.useFakeTimers();
    runPlans = [
      createParseFailurePlan('Failed to parse item: network error'),
      {
        type: 'events',
        events: [
          { type: 'thread.started', thread_id: 'thread-retry' },
          { type: 'item.completed', item: { id: 'message-retry', type: 'agent_message', text: 'unexpected retry' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      },
    ];

    const resultPromise = new CodexClient().call('coder', 'prompt', createFailureOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(runPlanIndex).toBe(1);
    expect(result.status).toBe('error');
    expect(result.failureCategory).toBe('provider_stream_parse_error');
  });

  it('should not add reconnect diagnostics when a reconnect pattern appears only after the retry prefix', async () => {
    vi.useFakeTimers();
    runPlans = [createParseFailurePlan(`${'x'.repeat(MAX_AGENT_FAILURE_MESSAGE_BYTES)} Reconnecting... 2/5`)];

    const resultPromise = new CodexClient().call('coder', 'prompt', createFailureOptions());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(runPlanIndex).toBe(1);
    expect(result.error).not.toContain('provider reconnect failure');
  });

  it('should keep the complete successful response outside the failure truncation path', async () => {
    const content = `Successful response: ${'結果'.repeat(5000)}`;
    runPlans = [{
      type: 'events',
      events: [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: content } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    }];

    const result = await new CodexClient().call('coder', 'prompt', createFailureOptions());

    expect(result.status).toBe('done');
    expect(result.content).toBe(content);
    expect(ensurePrivateDirectoryMock).not.toHaveBeenCalled();
    expect(writeNewPrivateFileWithModeMock).not.toHaveBeenCalled();
  });
});
