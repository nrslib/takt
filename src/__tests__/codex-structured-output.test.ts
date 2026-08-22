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
import type { CodexCallOptions } from '../infra/codex/types.js';

const { mockBuildCodexSkillConfig } = vi.hoisted(() => ({
  mockBuildCodexSkillConfig: vi.fn(),
}));

// ===== Codex SDK mock =====

let mockEvents: Array<Record<string, unknown>> = [];
let lastThreadOptions: Record<string, unknown> | undefined;
let lastTurnOptions: Record<string, unknown> | undefined;
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
          runStreamed: async (_input: unknown, options?: Record<string, unknown>) => {
            lastTurnOptions = options;
            return {
            events: (async function* () {
              for (const event of mockEvents) {
                yield event;
              }
            })(),
            };
          },
        };
      }
      async resumeThread() {
        return this.startThread();
      }
    },
  };
});

vi.mock('../infra/codex/skill-config.js', () => ({
  buildCodexSkillConfig: mockBuildCodexSkillConfig,
}));

// CodexClient は @openai/codex-sdk をインポートするため、mock 後にインポート
const { CodexClient } = await import('../infra/codex/client.js');

describe('CodexClient — structuredOutput 抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildCodexSkillConfig.mockReset();
    mockEvents = [];
    lastThreadOptions = undefined;
    lastTurnOptions = undefined;
    lastCodexConstructorOptions = undefined;
    delete process.env.TAKT_OBSERVABILITY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('outputSchema 指定時に agent_message の JSON テキストを structuredOutput として返す', async () => {
    const schema = { type: 'object', properties: { step: { type: 'integer' } } };
    const onStream = vi.fn();
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'reasoning-1', type: 'reasoning', text: 'internal reasoning summary' },
      },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{"step": 2, "reason": "approved"}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    const result = await client.call('coder', 'prompt', { cwd: '/tmp', outputSchema: schema, onStream });

    expect(result.status).toBe('done');
    expect(result.structuredOutput).toEqual({ step: 2, reason: 'approved' });
    expect(result.content).not.toContain('internal reasoning summary');
    expect(onStream).toHaveBeenCalledWith({
      type: 'thinking',
      data: { thinking: 'internal reasoning summary\n' },
    });
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

  it('read-only structured callをsandboxとapproval policyへ反映する', async () => {
    const schema = { type: 'object', additionalProperties: false };
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '{}' },
      },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('selector', 'prompt', {
      cwd: '/tmp',
      permissionMode: 'readonly',
      outputSchema: schema,
    });

    expect(lastThreadOptions).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    expect(lastTurnOptions).toMatchObject({ outputSchema: schema });
  });

  it('permission_control=codex は sandbox と network の指定を省略し approval policy は維持する', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('selector', 'prompt', {
      cwd: '/tmp',
      permissionMode: 'readonly',
      permissionControl: 'codex',
    });

    expect(lastThreadOptions).toMatchObject({ approvalPolicy: 'never' });
    expect(lastThreadOptions).not.toHaveProperty('sandboxMode');
    expect(lastThreadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('permission_control=codex と network_access の直接指定も fail fast する', async () => {
    const client = new CodexClient();

    await expect(client.call('coder', 'prompt', {
      cwd: '/tmp',
      permissionControl: 'codex',
      networkAccess: false,
    })).rejects.toThrow();
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

  it('permission_control 省略時は従来どおり TAKT sandbox mapping を使う', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', { cwd: '/tmp', permissionMode: 'edit' });

    expect(lastThreadOptions).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
    expect(lastThreadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('permission_control=takt は従来の sandbox と network mapping を明示的に維持する', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      permissionMode: 'readonly',
      permissionControl: 'takt',
      networkAccess: true,
    });

    expect(lastThreadOptions).toMatchObject({
      sandboxMode: 'read-only',
      networkAccessEnabled: true,
      approvalPolicy: 'never',
    });
  });

  it('provider_options.codex.reasoningEffort が安全な config override に反映される', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      reasoningEffort: 'vendor"level',
    });

    expect(lastCodexConstructorOptions).toMatchObject({
      config: {
        model_reasoning_effort: 'vendor"level',
        model_reasoning_summary: 'auto',
      },
    });
    expect(lastThreadOptions).not.toHaveProperty('modelReasoningEffort');
  });

  it('reasoningEffort がなくても Codex config に reasoning summary を設定する', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];

    const client = new CodexClient();
    await client.call('coder', 'prompt', { cwd: '/tmp' });

    expect(lastCodexConstructorOptions).toMatchObject({
      config: {
        model_reasoning_summary: 'auto',
      },
    });
  });

  it.each([true, false])('fastMode=%s は Codex config の features.fast_mode に反映される', async (fastMode) => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];
    mockBuildCodexSkillConfig.mockReturnValue({
      skills: {
        config: [{ path: '/tmp/example/SKILL.md', enabled: false }],
      },
    });
    const callOptions: CodexCallOptions = {
      cwd: '/tmp',
      fastMode,
      reasoningEffort: 'high',
      skills: { repo: false, user: false },
    };

    const client = new CodexClient();
    await client.call('coder', 'prompt', callOptions);

    expect(lastCodexConstructorOptions).toMatchObject({
      config: {
        skills: {
          config: [{ path: '/tmp/example/SKILL.md', enabled: false }],
        },
        features: { fast_mode: fastMode },
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'auto',
      },
    });
  });

  it('fastMode 未指定時は Codex config に features.fast_mode を追加しない', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];
    mockBuildCodexSkillConfig.mockReturnValue({
      skills: {
        config: [{ path: '/tmp/example/SKILL.md', enabled: false }],
      },
    });

    const client = new CodexClient();
    await client.call('coder', 'prompt', {
      cwd: '/tmp',
      reasoningEffort: 'high',
      skills: { repo: false, user: false },
    });

    expect(lastCodexConstructorOptions).toMatchObject({
      config: {
        skills: {
          config: [{ path: '/tmp/example/SKILL.md', enabled: false }],
        },
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'auto',
      },
    });
    expect(lastCodexConstructorOptions?.config).not.toHaveProperty('features.fast_mode');
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

  it('baseUrl が Codex constructor options に反映される', async () => {
    mockEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
    ];
    const callOptions = {
      cwd: '/tmp',
      baseUrl: 'http://127.0.0.1:8787/v1',
    } as unknown as CodexCallOptions;

    const client = new CodexClient();
    await client.call('coder', 'prompt', callOptions);

    expect(lastCodexConstructorOptions).toMatchObject({
      baseUrl: 'http://127.0.0.1:8787/v1',
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
