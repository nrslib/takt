/**
 * A failed exec turn has to say why. The reason lives in the provider's own
 * message, and replacing it with a fixed sentence at this seam is how a user
 * ends up with "the call failed" and nothing to act on.
 */

import { describe, expect, it, vi } from 'vitest';

const { mockCallAIWithRetry } = vi.hoisted(() => ({ mockCallAIWithRetry: vi.fn() }));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

import { askExecAssistant } from '../features/exec/assistantSession.js';

const CTX = {
  provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
  providerType: 'mock',
  model: 'mock-model',
  lang: 'en',
  personaName: 'exec-assistant',
  sessionId: undefined,
} as never;

describe('askExecAssistant', () => {
  it('should throw the reason the call reported', async () => {
    mockCallAIWithRetry.mockResolvedValue({
      result: null,
      sessionId: undefined,
      error: 'opencode server did not start',
    });

    await expect(askExecAssistant('/repo', CTX, 'prompt', 'system'))
      .rejects.toThrow('opencode server did not start');
  });

  it('should fall back to its own wording only when there is no reason', async () => {
    mockCallAIWithRetry.mockResolvedValue({ result: null, sessionId: undefined });

    await expect(askExecAssistant('/repo', CTX, 'prompt', 'system'))
      .rejects.toThrow('Exec assistant call failed.');
  });

  it('should throw what the provider said when it answered with a failure', async () => {
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: 'model moonshotai/kimi-k3 is not available', sessionId: undefined, success: false },
      sessionId: undefined,
    });

    await expect(askExecAssistant('/repo', CTX, 'prompt', 'system'))
      .rejects.toThrow('model moonshotai/kimi-k3 is not available');
  });

  it('should pass the caller through to the AI call unchanged', async () => {
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: '  an answer  ', sessionId: 'session-2', success: true },
      sessionId: 'session-2',
    });
    const onStream = vi.fn();

    const answer = await askExecAssistant('/repo', CTX, 'prompt', 'system', {
      outputMode: 'silent',
      onStream,
    });

    expect(answer).toEqual({ content: 'an answer', sessionId: 'session-2' });
    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      'prompt',
      'system',
      [],
      '/repo',
      CTX,
      expect.objectContaining({ outputMode: 'silent', onStream }),
    );
  });
});
