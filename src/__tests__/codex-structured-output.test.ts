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

vi.mock('@openai/codex-sdk', () => {
  return {
    Codex: class MockCodex {
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
});
