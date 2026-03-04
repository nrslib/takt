/**
 * Claude SDK layer structured output tests.
 *
 * Tests two internal components:
 * 1. SdkOptionsBuilder — outputSchema → outputFormat conversion
 * 2. QueryExecutor — structured_output extraction from SDK result messages
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ===== SdkOptionsBuilder tests (no mock needed) =====

import { buildSdkOptions } from '../infra/claude/options-builder.js';

describe('SdkOptionsBuilder — outputFormat 変換', () => {
  it('outputSchema が outputFormat に変換される', () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    const sdkOptions = buildSdkOptions({ cwd: '/tmp', outputSchema: schema });

    expect((sdkOptions as Record<string, unknown>).outputFormat).toEqual({
      type: 'json_schema',
      schema,
    });
  });

  it('outputSchema 未設定なら outputFormat は含まれない', () => {
    const sdkOptions = buildSdkOptions({ cwd: '/tmp' });
    expect(sdkOptions).not.toHaveProperty('outputFormat');
  });
});

// ===== QueryExecutor tests (mock @anthropic-ai/claude-agent-sdk) =====

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'AbortError';
    }
  },
}));

// QueryExecutor は executor.ts 内で query() を使うため、mock 後にインポート
const { QueryExecutor } = await import('../infra/claude/executor.js');

/**
 * query() が返す Query オブジェクト（async iterable + interrupt）のモック
 */
function createMockQuery(messages: Array<Record<string, unknown>>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
    interrupt: vi.fn(),
  };
}

describe('QueryExecutor — structuredOutput 抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('result メッセージの structured_output (snake_case) を抽出する', async () => {
    mockQuery.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: { step: 2 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('result メッセージの structuredOutput (camelCase) を抽出する', async () => {
    mockQuery.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structuredOutput: { step: 3 } },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toEqual({ step: 3 });
  });

  it('structured_output が snake_case 優先 (snake_case と camelCase 両方ある場合)', async () => {
    mockQuery.mockReturnValue(createMockQuery([
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
    mockQuery.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'plain text' },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が配列の場合は無視する', async () => {
    mockQuery.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: [1, 2, 3] },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('structured_output が null の場合は無視する', async () => {
    mockQuery.mockReturnValue(createMockQuery([
      { type: 'result', subtype: 'success', result: 'done', structured_output: null },
    ]));

    const executor = new QueryExecutor();
    const result = await executor.execute('test', { cwd: '/tmp' });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('assistant テキストと structured_output を同時に取得する', async () => {
    mockQuery.mockReturnValue(createMockQuery([
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
    mockQuery.mockReturnValue(createMockQuery([
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
    mockQuery.mockReturnValue(createMockQuery([
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
});
