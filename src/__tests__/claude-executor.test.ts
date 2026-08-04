/**
 * Claude SDK executor layer tests.
 *
 * Covers:
 * - SdkOptionsBuilder — outputSchema → outputFormat conversion and env wiring
 * - QueryExecutor — structured_output extraction, abortSignal wiring,
 *   rate limit cause preservation
 * - sdkMessageToStreamEvent — SDK message → stream event conversion
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, dirname } from 'node:path';
import type { ClaudeSpawnOptions, StreamEvent } from '../infra/claude/types.js';

const {
  queryMock,
  interruptMock,
  AbortErrorMock,
} = vi.hoisted(() => {
  class AbortErrorMock extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'AbortError';
    }
  }

  return {
    queryMock: vi.fn(),
    interruptMock: vi.fn(async () => {}),
    AbortErrorMock,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  AbortError: AbortErrorMock,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { QueryExecutor } from '../infra/claude/executor.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { sdkMessageToStreamEvent } from '../infra/claude/stream-converter.js';

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Please try again later.';
const EXIT_CODE_MESSAGE = 'Claude Code process exited with code 1';
type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

function createMockQuery(
  messages: Array<Record<string, unknown>>,
  error?: Error,
) {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      for (const message of messages) {
        yield message;
      }

      if (error) {
        throw error;
      }
    },
  };
}

function createMockQueryThatFailsAfterFirstMessage(
  firstMessage: Record<string, unknown>,
) {
  const state = { afterMarkerPulled: false };
  return {
    state,
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
      yield firstMessage;
      state.afterMarkerPulled = true;
      throw new Error('stream should stop after rate limit detection');
    },
  };
}

function createInterruptibleQuery() {
  let interrupted = false;
  interruptMock.mockImplementation(async () => {
    interrupted = true;
  });

  return {
    interrupt: interruptMock,
    async *[Symbol.asyncIterator](): AsyncGenerator<never, void, unknown> {
      while (!interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new AbortErrorMock('aborted');
    },
  };
}

function createAssistantRateLimitMessage(): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: [] },
    error: 'rate_limit',
    uuid: 'assistant-rate-limit',
    session_id: 'session-rate-limit',
    parent_tool_use_id: null,
  };
}

function createAssistantTextMessage(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    session_id: 'session-rate-limit',
  };
}

function createRateLimitEventMessage(
  rateLimitInfo: {
    status: RateLimitStatus;
    overageStatus?: RateLimitStatus;
  },
): Record<string, unknown> {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: rateLimitInfo.status,
      rateLimitType: 'five_hour',
      overageStatus: rateLimitInfo.overageStatus ?? rateLimitInfo.status,
      overageDisabledReason: 'out_of_credits',
      resetsAt: 1775059200,
      overageResetsAt: 1775059200,
      isUsingOverage: false,
    },
    uuid: 'rate-limit-event',
    session_id: 'session-rate-limit',
  };
}

function createResultMessage(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    ...overrides,
  };
}

describe('SdkOptionsBuilder — outputFormat 変換', () => {
  it('effort が SDK options に直接反映される', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', effort: 'medium' });

    expect(sdkOptions.effort).toBe('medium');
  });

  it('outputSchema が outputFormat に変換される', () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', outputSchema: schema });

    expect(sdkOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema,
    });
  });

  it('outputSchema 未設定なら outputFormat は含まれない', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp' });
    expect(sdkOptions).not.toHaveProperty('outputFormat');
  });

  it('現在の Node.js 実行ディレクトリを PATH の先頭に追加する', () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);

      const sdkOptions = buildSdkOptions({
        cwd: '/tmp',
        pathToClaudeCodeExecutable: '/tmp/test-bin/claude',
      });

      const pathEntries = sdkOptions.env?.PATH?.split(delimiter) ?? [];
      expect(pathEntries[0]).toBe(dirname(process.execPath));
      expect(pathEntries).toContain('/usr/bin');
      expect(pathEntries).toContain(dirname(process.execPath));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('Anthropic API key を env に引き継ぐ', () => {
    const sdkOptions = buildSdkOptions({
      cwd: '/tmp',
      anthropicApiKey: 'test-key',
    });

    expect(sdkOptions.env?.ANTHROPIC_API_KEY).toBe('test-key');
  });

  it('baseUrl を ANTHROPIC_BASE_URL として SDK env に注入し ambient env より優先する', () => {
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.ANTHROPIC_BASE_URL = 'http://ambient.example.test';
      const spawnOptions = {
        cwd: '/tmp',
        baseUrl: 'http://127.0.0.1:8787',
      } as unknown as ClaudeSpawnOptions;

      const sdkOptions = buildSdkOptions(spawnOptions);

      expect(sdkOptions.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      }
    }
  });
});

describe('QueryExecutor — structuredOutput 抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('result メッセージの structured_output (snake_case) を抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: { step: 2 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('result メッセージの structuredOutput (camelCase) を抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structuredOutput: { step: 3 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toEqual({ step: 3 });
  });

  it('structured_output が snake_case 優先 (snake_case と camelCase 両方ある場合)', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        structured_output: { step: 1 },
        structuredOutput: { step: 9 },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toEqual({ step: 1 });
  });

  it('structuredOutput がない場合は undefined', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'plain text' },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が配列の場合は無視する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: [1, 2, 3] },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が null の場合は無視する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: null },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('assistant テキストと structured_output を同時に取得する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking...' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'final text',
        structured_output: { step: 1, reason: 'approved' },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.content).toBe('final text');
    expect(result.structuredOutput).toEqual({ step: 1, reason: 'approved' });
  });

  it('result メッセージの usage を providerUsage として抽出する', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      cachedInputTokens: 12,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
      usageMissing: false,
    });
  });

  it('usage が存在しない場合は usageMissing=true と reason を返す', async () => {
    queryMock.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done' },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toMatchObject({
      usageMissing: true,
      reason: 'usage_not_available',
    });
  });

  it('usage に必須 token が欠ける場合は usage_tokens_missing を返す', async () => {
    queryMock.mockReturnValue(createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        usage: {
          input_tokens: 12,
        },
      },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.providerUsage).toEqual({
      usageMissing: true,
      reason: 'usage_tokens_missing',
    });
  });
});

describe('QueryExecutor abortSignal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => createInterruptibleQuery());
  });

  it('abortSignal 発火時に query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    const executor = new QueryExecutor();

    const promise = executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const result = await promise;

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });

  it('開始前に中断済みの signal でも query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = new QueryExecutor();
    const result = await executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });
});

describe('QueryExecutor rate limit cause preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assistant.error が rate_limit の場合は exit code 1 より優先して RateLimit 文言を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([createAssistantRateLimitMessage()], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe(RATE_LIMIT_MESSAGE);
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rate_limit_event が観測された場合は SDK event の詳細を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({ status: 'rejected' }),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toContain('Claude SDK rate limit event: status=rejected');
    expect(result.error).toContain('overageDisabledReason=out_of_credits');
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('status=allowed なら overageStatus=rejected でも rate_limit 扱いせずリクエストを完走させる', async () => {
    // overage 未提供の組織では overageStatus が恒常的に 'rejected' になるが、
    // ベース status が 'allowed' であればリクエストは成功するため rate_limit ではない。
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({
          status: 'allowed',
          overageStatus: 'rejected',
        }),
        createAssistantTextMessage('ok'),
        createResultMessage({ subtype: 'success', result: 'ok' }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('ok');
    expect(result.errorKind).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('status=rejected でも overageStatus=allowed なら overage で救済されるので rate_limit 扱いしない', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createRateLimitEventMessage({
          status: 'rejected',
          overageStatus: 'allowed',
        }),
        createAssistantTextMessage('ok'),
        createResultMessage({ subtype: 'success', result: 'ok' }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('ok');
    expect(result.errorKind).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('Claude response の result 文面が rate limit を示す場合はその文面を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createResultMessage({
          subtype: 'error',
          result: "You're out of extra usage. Please retry later.",
        }),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe("You're out of extra usage. Please retry later.");
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('Claude SDK の HTTP 429 エラーは sdk_error の rate_limited として返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([], new Error('HTTP 429: rate limit exceeded')),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
    expect(result.error).toBe('HTTP 429: rate limit exceeded');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.rateLimitInfo?.source).toBe('sdk_error');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('assistant text のみで rate limit が示された場合はその文面を返す', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage("You're out of extra usage. Please retry later."),
      ], new Error(EXIT_CODE_MESSAGE)),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.error).toBe("You're out of extra usage. Please retry later.");
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('assistant text の一般的な rate limit / 429 記述は rate_limited にしない', async () => {
    // Given
    queryMock.mockReturnValue(
      createMockQuery([
        createAssistantTextMessage('Documented rate limit fallback behavior for issue 429.'),
        createResultMessage({
          subtype: 'success',
          result: 'Documented rate limit fallback behavior for issue 429.',
        }),
      ]),
    );
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(true);
    expect(result.content).toBe('Documented rate limit fallback behavior for issue 429.');
    expect(result.errorKind).toBeUndefined();
  });

  it('stream 本文の rate limit マーカーを検出した時点で購読を打ち切り rate_limited として返す', async () => {
    // Given
    const query = createMockQueryThatFailsAfterFirstMessage(
      createAssistantTextMessage("You're out of extra usage · resets 2:30pm (Asia/Tokyo)"),
    );
    queryMock.mockReturnValue(query);
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', { cwd: '/tmp/project' });

    // Then
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
    expect(result.error).toBe("You're out of extra usage · resets 2:30pm (Asia/Tokyo)");
    expect(result.errorKind).toBe('rate_limit');
    expect(query.state.afterMarkerPulled).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('sessionId 付き実行で RateLimit を観測した場合は no-resume retry を行わない', async () => {
    // Given
    queryMock.mockImplementation(() => (
      createMockQuery([createAssistantRateLimitMessage()], new Error(EXIT_CODE_MESSAGE))
    ));
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
    });

    // Then
    expect(result.error).toBe(RATE_LIMIT_MESSAGE);
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(
      (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBe('resume-session-1');
  });

  it('sessionId 付き実行で rejected の rate_limit_event を観測した場合も no-resume retry を行わない', async () => {
    // Given
    queryMock.mockImplementation(() => (
      createMockQuery([
        createRateLimitEventMessage({ status: 'rejected' }),
      ], new Error(EXIT_CODE_MESSAGE))
    ));
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
    });

    // Then
    expect(result.error).toContain('Claude SDK rate limit event: status=rejected');
    expect(result.errorKind).toBe('rate_limit');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(
      (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBe('resume-session-1');
  });

  it('RateLimit シグナルがない generic exit code error は既存どおり no-resume retry する', async () => {
    // Given
    queryMock.mockImplementation(() => createMockQuery([], new Error(EXIT_CODE_MESSAGE)));
    const executor = new QueryExecutor();

    // When
    const result = await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
    });

    // Then
    expect(result.error).toBe(EXIT_CODE_MESSAGE);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(
      (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBe('resume-session-1');
    expect(
      (queryMock.mock.calls[1]?.[0] as { options?: { resume?: string } }).options?.resume,
    ).toBeUndefined();
  });

  it('Skills 無効の resume 失敗を再試行するときも、SDK の空の Skill allowlist を維持する', async () => {
    queryMock.mockImplementation(() => createMockQuery([], new Error(EXIT_CODE_MESSAGE)));
    const executor = new QueryExecutor();

    await executor.execute('test prompt', {
      cwd: '/tmp/project',
      sessionId: 'resume-session-1',
      skillsEnabled: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect((queryMock.mock.calls[0]?.[0] as { options?: { skills?: unknown } }).options?.skills).toEqual([]);
    expect((queryMock.mock.calls[1]?.[0] as { options?: { skills?: unknown } }).options?.skills).toEqual([]);
  });

  it('strict read-only 隔離では Skills 有効指定より空の Skill allowlist を優先する', async () => {
    queryMock.mockImplementation(() => createMockQuery([]));
    const executor = new QueryExecutor();

    await executor.execute('test prompt', {
      cwd: '/tmp/project',
      internalAgentIsolation: 'strict-readonly',
      skillsEnabled: true,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0]?.[0] as { options?: { skills?: unknown } }).options?.skills).toEqual([]);
  });

  it.each([
    ['allowed', 'allowed'],
    ['allowed_warning', 'allowed_warning'],
    ['allowed', 'allowed_warning'],
    // overage 未提供のため overageStatus が恒常的に rejected だが、ベースは通っている
    ['allowed', 'rejected'],
    ['allowed_warning', 'rejected'],
    // ベースは超過しているが overage で救済される
    ['rejected', 'allowed'],
    ['rejected', 'allowed_warning'],
  ] as const)(
    'rate_limit_event status=%s overageStatus=%s は失敗扱いせず generic error と no-resume retry を維持する',
    async (status, overageStatus) => {
      // Given
      queryMock.mockImplementation(() => (
        createMockQuery([
          createRateLimitEventMessage({ status, overageStatus }),
        ], new Error(EXIT_CODE_MESSAGE))
      ));
      const executor = new QueryExecutor();

      // When
      const result = await executor.execute('test prompt', {
        cwd: '/tmp/project',
        sessionId: 'resume-session-1',
      });

      // Then
      expect(result.error).toBe(EXIT_CODE_MESSAGE);
      expect(result.errorKind).toBeUndefined();
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(
        (queryMock.mock.calls[0]?.[0] as { options?: { resume?: string } }).options?.resume,
      ).toBe('resume-session-1');
      expect(
        (queryMock.mock.calls[1]?.[0] as { options?: { resume?: string } }).options?.resume,
      ).toBeUndefined();
    },
  );
});

describe('sdkMessageToStreamEvent', () => {
  it('assistant.error を assistant_error イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'assistant',
        message: { content: [] },
        error: 'rate_limit',
        uuid: 'uuid-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
      },
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'assistant_error',
      data: {
        error: 'rate_limit',
        sessionId: 'session-1',
      },
    });
  });

  it('rate_limit_event を rate_limit イベントとして流す', () => {
    const callback = vi.fn<(event: StreamEvent) => void>();

    sdkMessageToStreamEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          resetsAt: 1775059200,
          overageResetsAt: 1775059200,
          isUsingOverage: false,
        },
        uuid: 'uuid-2',
        session_id: 'session-2',
      },
      callback,
      true,
    );

    expect(callback).toHaveBeenCalledWith({
      type: 'rate_limit',
      data: {
        sessionId: 'session-2',
        status: 'rejected',
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        resetsAt: 1775059200,
        overageResetsAt: 1775059200,
        isUsingOverage: false,
      },
    });
  });
});
