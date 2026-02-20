/**
 * OpenCode real E2E conversation test.
 *
 * Tests the full stack with a real OpenCode server:
 *   OpenCodeProvider → callOpenCode → OpenCodeClient → createOpencode (real server)
 *
 * Skipped automatically if the opencode binary is not found.
 * Run with: npm run test:e2e:opencode
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resetSharedServer } from '../../src/infra/opencode/client.js';
import { OpenCodeProvider } from '../../src/infra/providers/opencode.js';

function isOpencodeAvailable(): boolean {
  try {
    execSync('which opencode', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const MODEL = process.env.OPENCODE_E2E_MODEL ?? 'minimax/MiniMax-M2.5-highspeed';
const enabled = isOpencodeAvailable();

describe.skipIf(!enabled)('OpenCode real E2E conversation', () => {
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
});
