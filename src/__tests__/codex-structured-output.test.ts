/**
 * Codex SDK layer structured output tests.
 *
 * Tests CodexClient's extraction of structuredOutput by parsing
 * JSON text from agent_message items when outputSchema is provided.
 *
 * Codex SDK returns structured output as JSON text in agent_message
 * items (not via turn.completed.finalResponse which doesn't exist
 * on TurnCompletedEvent).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ===== Codex SDK mock =====

let mockEvents: Array<Record<string, unknown>> = [];
let lastThreadOptions: Record<string, unknown> | undefined;
let lastCodexConstructorOptions: Record<string, unknown> | undefined;

vi.mock('@openai/codex-sdk', () => {
  return {
    Codex: class MockCodex {
      constructor(options?: Record<string, unknown>) {
        lastCodexConstructorOptions = options;
      }
      async startThread(options?: Record<string, unknown>) {
        lastThreadOptions = options;
        return {
          id: 'thread-mock',
          runStreamed: async () => ({
            events: (async function* () {
              for (const event of mockEvents) {
                yield event;
              }
            })(),
          }),
        };
      }
      async resumeThread() {
        return this.startThread();
      }
    },
  };
});

// CodexClient は @openai/codex-sdk をインポートするため、mock 後にインポート
const { CodexClient } = await import('../infra/codex/client.js');

describe('CodexClient — structuredOutput 抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvents = [];
    lastThreadOptions = undefined;
    lastCodexConstructorOptions = undefined;
    delete process.env.TAKT_OBSERVABILITY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('outputSchema 指定時に agent_message の JSON テキストを structuredOutput として返す', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 2, "reason": "approved"}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ step: 2, reason: 'approved' });
  });

  it('複数の agent_message JSON がある場合は最後の JSON を structuredOutput として返す', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 1, "reason": "stale"}' },
      },
      {
        type: 'item.completed',
        item: { id: 'msg-2', type: 'agent_message', text: '{"step": 2, "reason": "final"}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ step: 2, reason: 'final' });
  });

  it('最後の agent_message が JSON でない場合は途中の JSON を structuredOutput として採用しない', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 1, "reason": "stale"}' },
      },
      {
        type: 'item.completed',
        item: { id: 'msg-2', type: 'agent_message', text: 'plain text final response' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('item.updated の agent_message JSON は structuredOutput として採用しない', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.updated',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 1, "reason": "draft"}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.content).toBe('{"step": 1, "reason": "draft"}');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('複数の agent_message がある場合も content は全テキストを改行連結して返す', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 1, "reason": "stale"}' },
      },
      {
        type: 'item.completed',
        item: { id: 'msg-2', type: 'agent_message', text: '{"step": 2, "reason": "final"}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.content).toBe('{"step": 1, "reason": "stale"}\n{"step": 2, "reason": "final"}');
  });

  it('outputSchema なしの場合はテキストを JSON パースしない', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 2}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('run-local observability snapshot だけを Codex CLI env に渡す', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-user:pass@collector.example.test';
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'done' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-collector.example.test',
      },
    });

    const env = lastCodexConstructorOptions?.env as Record<string, string> | undefined;
    expect(env?.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
    expect(env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-collector.example.test');
  });

  it('agent_message が JSON でない場合は undefined', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'plain text response' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('JSON が配列の場合は無視する', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '[1, 2, 3]' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('agent_message がない場合は structuredOutput なし', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('outputSchema 付きで呼び出して structuredOutput が返る', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 1}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', {
      cwd: '/tmp',
      outputSchema: schema,
    });

    expect(result.structuredOutput).toEqual({ step: 1 });
  });

  it('provider_options.codex.network_access が ThreadOptions に反映される', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      networkAccess: true,
    });

    expect(lastThreadOptions).toMatchObject({
      networkAccessEnabled: true,
    });
  });

  it('provider_options.codex.reasoningEffort が ThreadOptions に反映される', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      reasoningEffort: 'medium',
    });

    expect(lastThreadOptions).toMatchObject({
      modelReasoningEffort: 'medium',
    });
  });

  it('codexPathOverride が Codex constructor options に反映される', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      codexPathOverride: '/opt/codex/bin/codex',
    });

    expect(lastCodexConstructorOptions).toMatchObject({
      codexPathOverride: '/opt/codex/bin/codex',
    });
  });

  it('turn.completed の usage を providerUsage として返す', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 3 },
      },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
      cachedInputTokens: 3,
      usageMissing: false,
    });
  });

  it('turn.completed に usage がない場合は usageMissing=true と reason を返す', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed' },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp' });
    const providerUsage = result.providerUsage;

    expect(providerUsage).toMatchObject({
      usageMissing: true,
      reason: 'usage_not_available',
    });
  });
});
