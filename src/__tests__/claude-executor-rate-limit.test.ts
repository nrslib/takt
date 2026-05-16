import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
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
