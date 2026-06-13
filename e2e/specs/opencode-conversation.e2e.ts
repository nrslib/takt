import { describe, it, expect, afterAll } from 'vitest';
import { getOpenCodeSessionSnapshot, resetSharedServer } from '../../src/infra/opencode/client.js';
import { OpenCodeProvider } from '../../src/infra/providers/opencode.js';

const MODEL = process.env.TAKT_E2E_MODEL ?? process.env.OPENCODE_E2E_MODEL ?? 'opencode/big-pickle';
const DENY_OR_FAILURE_PATTERN = /denied|deny|permission|not allowed|forbidden|reject|failed/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function hasRuntimeDenyOrFailureEvent(
  events: Array<{ type: string; data?: unknown }>,
  sessionId: string,
): boolean {
  return events.some((event) => {
    const data = asRecord(event.data);
    if (!data) {
      return false;
    }

    if (event.type === 'permission_asked') {
      return (
        data.sessionId === sessionId
        && (data.reply === 'reject' || data.reply === 'deny')
      );
    }

    if (event.type === 'tool_result') {
      const content = String(data.content ?? '');
      return data.isError === true && DENY_OR_FAILURE_PATTERN.test(content);
    }

    return false;
  });
}

function expectDenyOnlyRuleset(ruleset: unknown): void {
  expect(Array.isArray(ruleset)).toBe(true);
  const permissions = ruleset as Array<{ permission?: unknown; action?: unknown }>;
  expect(permissions.length).toBeGreaterThan(0);
  expect(permissions.every((rule) => rule.action === 'deny')).toBe(true);
  expect(permissions.some((rule) => rule.permission === 'read')).toBe(true);
}

describe('OpenCode real E2E conversation', () => {
  afterAll(() => {
    resetSharedServer();
  });

  it('should complete a two-turn conversation with sessionId inheritance', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'You are a concise assistant. Keep all responses under 20 words.',
    });

    // 1ターン目
    const result1 = await agent.call('Say only the word "apple".', {
      cwd: process.cwd(),
      model: MODEL,
    });

    expect(result1.status).toBe('done');
    expect(result1.sessionId).toBeDefined();

    // 2ターン目: sessionId を引き継いで送る（conversationLoop と同じ）
    const result2 = await agent.call('What fruit did I ask you about?', {
      cwd: process.cwd(),
      model: MODEL,
      sessionId: result1.sessionId,
    });

    expect(result2.status).toBe('done');
    // 同じセッションを再利用している
    expect(result2.sessionId).toBe(result1.sessionId);
    // 会話が引き継がれていれば "apple" に言及するはず
    expect(result2.content.toLowerCase()).toContain('apple');
  }, 120_000);

  it('should complete a three-turn conversation without hanging', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'You are a concise assistant. Keep all responses under 20 words.',
    });

    const results = [];
    let prevSessionId: string | undefined;

    const prompts = [
      'Remember the number 42.',
      'What number did I ask you to remember?',
      'Double that number.',
    ];

    for (const prompt of prompts) {
      const result = await agent.call(prompt, {
        cwd: process.cwd(),
        model: MODEL,
        sessionId: prevSessionId,
      });

      expect(result.status).toBe('done');
      results.push(result);
      prevSessionId = result.sessionId;
    }

    // すべてのターンが同じセッションを使っている
    expect(results[1].sessionId).toBe(results[0].sessionId);
    expect(results[2].sessionId).toBe(results[0].sessionId);

    // 会話が引き継がれている
    expect(results[1].content).toMatch(/42/);
    expect(results[2].content).toMatch(/84/);
  }, 180_000);

  it('should use a deny-only permission session when allowedTools is empty', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'You are a concise assistant. Use OpenCode tools when asked to inspect files. Keep final responses under 10 words.',
    });
    const streamEvents: Array<{ type: string; data?: unknown }> = [];

    const result1 = await agent.call('Say only "ready".', {
      cwd: process.cwd(),
      model: MODEL,
      allowedTools: ['Read'],
      onStream: (event) => streamEvents.push(event),
    });

    expect(result1.status).toBe('done');
    expect(result1.sessionId).toBeDefined();
    const sessionId = result1.sessionId;
    if (!sessionId) {
      throw new Error('OpenCode session ID is required for permission verification');
    }
    expect(streamEvents).toContainEqual({
      type: 'permission_summary',
      data: expect.objectContaining({
        allowedTools: ['Read'],
        resolvedPermissions: [
          { permission: '*', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'allow' },
        ],
      }),
    });

    const secondTurnStartIndex = streamEvents.length;
    const result2 = await agent.call('Use the OpenCode read tool to inspect package.json before answering with only the package name.', {
      cwd: process.cwd(),
      model: MODEL,
      sessionId,
      allowedTools: [],
      onStream: (event) => streamEvents.push(event),
    });

    expect(result2.sessionId).toBeDefined();
    const permissionSessionId = result2.sessionId;
    if (!permissionSessionId) {
      throw new Error('OpenCode permission session ID is required for deny-all verification');
    }
    const secondTurnEvents = streamEvents.slice(secondTurnStartIndex);
    const hasRuntimeDenyEvent = hasRuntimeDenyOrFailureEvent(secondTurnEvents, permissionSessionId);
    expect(hasRuntimeDenyEvent).toBe(true);
    const permissionSummary = secondTurnEvents.find((event) => (
      event.type === 'permission_summary'
      && asRecord(event.data)?.sessionId === permissionSessionId
    ));
    expect(permissionSummary).toBeDefined();
    const permissionSummaryData = asRecord(permissionSummary?.data);
    expect(permissionSummaryData).toEqual(expect.objectContaining({
      sessionId: permissionSessionId,
      allowedTools: [],
    }));
    expectDenyOnlyRuleset(permissionSummaryData?.resolvedPermissions);
    const session = await getOpenCodeSessionSnapshot(MODEL, permissionSessionId, process.cwd());
    if (!session.permission) {
      throw new Error('OpenCode session permission is required for deny-all verification');
    }
    expectDenyOnlyRuleset(session.permission);
  }, 180_000);
});
