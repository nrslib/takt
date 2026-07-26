import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkRequirementEstimator } from '../agents/auto-routing-usecase.js';
import { runAgent } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

function createModelInput() {
  return {
    version: 'routing-model-input/v1',
    goal: 'Implement the requested change',
    step: { name: 'implement', tags: ['implementation'], stepType: 'normal' as const, edit: true },
    remainingWork: [{ source: 'finding' as const, severity: 'high', description: 'A focused implementation fix remains.' }],
    progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
  };
}

function createEstimator(abortSignal?: AbortSignal) {
  return createWorkRequirementEstimator({
    cwd: '/repo', provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001',
    language: 'ja', childProcessEnv: { TAKT_TEST: '1' }, abortSignal,
  });
}

describe('createWorkRequirementEstimator', () => {
  beforeEach(() => vi.resetAllMocks());

  it('Given normalized work input, When the router returns a structured estimate, Then it returns requiredTier instead of a candidate name', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router', status: 'done',
      content: JSON.stringify({ required_tier: 'high', reason_codes: ['critical-finding'], confidence: 0.9 }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(createEstimator().estimate(createModelInput())).resolves.toEqual({
      requiredTier: 'high', reasonCodes: ['critical-finding'], confidence: 0.9,
    });
  });

  it('Given normalized work input, When invoking the router, Then it uses readonly structured output without candidate configuration', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router', status: 'done', content: '{"required_tier":"medium","reason_codes":["focused-change"]}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await createEstimator().estimate(createModelInput());

    const [persona, prompt, options] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(persona).toBe('auto-router');
    expect(prompt).toContain('required_tier');
    expect(prompt).not.toMatch(/candidate|coding|claude-haiku|\/repo/i);
    expect(options).toMatchObject({
      cwd: '/repo', provider: 'claude-sdk', resolvedProvider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001',
      permissionMode: 'readonly', language: 'ja', childProcessEnv: { TAKT_TEST: '1' },
      outputSchema: {
        properties: { required_tier: { type: 'string' }, reason_codes: { type: 'array' } },
        required: ['required_tier', 'reason_codes'],
      },
    });
  });

  it('Given an invalid estimator response, When parsing it, Then it rejects without disclosing raw router content', async () => {
    const rawContent = '{"required_tier":"candidate=Authorization: Bearer sk-test","reason_codes":[]}';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router', status: 'done', content: rawContent,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    try {
      await createEstimator().estimate(createModelInput());
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/invalid required_tier/i);
      expect((error as Error).message).not.toContain(rawContent);
      return;
    }
    throw new Error('Expected invalid estimator response to reject');
  });

  it('Given an already aborted parent signal, When estimating work requirements, Then no provider call starts', async () => {
    const controller = new AbortController();
    const reason = new Error('routing cancelled');
    controller.abort(reason);

    await expect(createEstimator(controller.signal).estimate(createModelInput())).rejects.toBe(reason);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
