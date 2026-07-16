import { describe, it, expect, afterAll } from 'vitest';
import { getOpenCodeSessionMessages, getOpenCodeSessionSnapshot, resetSharedServer } from '../../src/infra/opencode/client.js';
import { OpenCodeProvider } from '../../src/infra/providers/opencode.js';

const MODEL = process.env.TAKT_E2E_MODEL ?? process.env.OPENCODE_E2E_MODEL ?? 'ollama-cloud/qwen3-coder-next';
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

  it('should reuse the session and hide tools per prompt when allowedTools is empty', async () => {
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
    // セッション permission は edit/write を許可し external_directory を deny する
    // 緩和済みルールセット（フェーズ制限は per-prompt tools マップが担う）
    expect(streamEvents).toContainEqual({
      type: 'permission_summary',
      data: expect.objectContaining({
        allowedTools: ['Read'],
        resolvedPermissions: [
          { permission: '*', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'allow' },
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'write', pattern: '*', action: 'allow' },
          { permission: 'external_directory', pattern: '*', action: 'deny' },
        ],
      }),
    });

    const secondTurnStartIndex = streamEvents.length;
    const result2 = await agent.call(
      'Use the OpenCode read tool to inspect package.json. If you have no read tool available, reply exactly NO-READ-TOOL.',
      {
        cwd: process.cwd(),
        model: MODEL,
        sessionId,
        allowedTools: [],
        onStream: (event) => streamEvents.push(event),
      },
    );

    expect(result2.status).toBe('done');
    // セッションは再作成されず、同一 ID のまま継続する
    expect(result2.sessionId).toBe(sessionId);
    // 再開ターンでは permission_summary は再発行されない（セッション権限は不変）
    const secondTurnEvents = streamEvents.slice(secondTurnStartIndex);
    expect(secondTurnEvents.some((event) => event.type === 'permission_summary')).toBe(false);
    // tools マップにより read が不可視になっている。文字列不在ではなく、
    // 記録されたメッセージ（観測単位）でターン2にツールパートが一切ないことを検証する
    expect(result2.content).toContain('NO-READ-TOOL');
    const messages = await getOpenCodeSessionMessages(MODEL, sessionId, process.cwd());
    const lastUserIndex = messages.reduce(
      (last, message, index) => (message.info.role === 'user' ? index : last),
      -1,
    );
    expect(lastUserIndex).toBeGreaterThan(0);
    const secondTurnParts = messages.slice(lastUserIndex + 1).flatMap((message) => message.parts);
    expect(secondTurnParts.length).toBeGreaterThan(0);
    expect(secondTurnParts.filter((part) => part.type === 'tool')).toEqual([]);
    // OpenCode (>=1.17) rewrites session.permission from the prompt's tools map
    // on every turn that carries one. After this empty-map turn the snapshot
    // collapses to all-deny (matching the NO-READ-TOOL result above), so it no
    // longer retains turn-1's relaxed rules. external_directory denial is not
    // enforced through this snapshot but through the server-config layer
    // (client.ts `permission: { external_directory: 'deny' }`); turn 1's
    // permission_summary above already asserts resolvedPermissions carries
    // external_directory:deny, and out-of-workspace reads are blocked at the
    // tool layer regardless of the session snapshot.
    const session = await getOpenCodeSessionSnapshot(MODEL, sessionId, process.cwd());
    if (!session.permission) {
      throw new Error('OpenCode session permission is required for verification');
    }
    const permissions = session.permission as Array<{ permission?: unknown; action?: unknown }>;
    // The empty tools map materialized into the session: nothing stays allowed.
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.some((rule) => rule.action === 'allow')).toBe(false);
  }, 180_000);
});
