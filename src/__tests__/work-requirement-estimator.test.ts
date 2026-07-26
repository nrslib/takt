import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkRequirementEstimator } from '../agents/auto-routing-usecase.js';
import { runAgent } from '../agents/runner.js';
import type { RoutingModelInput } from '../core/workflow/auto-routing/contracts.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

function createModelInput(): RoutingModelInput {
  return {
    version: 'routing-model-input/v1',
    goal: 'Implement a focused validation fix',
    step: {
      name: 'implement',
      tags: ['implementation'],
      stepType: 'normal',
      edit: true,
    },
    remainingWork: [{ source: 'finding', description: 'A validation branch is incomplete.' }],
    progress: {
      previousAttemptFailed: false,
      noProgress: false,
      retryingSameWork: false,
    },
  };
}

describe('createWorkRequirementEstimator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given a normalized model input, When the router returns a tier estimate, Then the adapter returns requiredTier and reason codes', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({
        required_tier: 'medium',
        reason_codes: ['focused-change'],
        confidence: 0.8,
      }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    const estimate = await estimator.estimate(createModelInput());

    expect(estimate).toEqual({
      requiredTier: 'medium',
      reasonCodes: ['focused-change'],
      confidence: 0.8,
    });
  });

  it('Given provider-native structured output, When content is not JSON, Then the structured estimate is used', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: 'The estimate is available in structured output.',
      structuredOutput: {
        required_tier: 'high',
        reason_codes: ['critical-finding'],
      },
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    await expect(estimator.estimate(createModelInput())).resolves.toEqual({
      requiredTier: 'high',
      reasonCodes: ['critical-finding'],
    });
  });

  it('Given normalized work input, When the estimator prompts the router, Then it does not disclose candidates, models, pools, or repository identifiers', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({ required_tier: 'high', reason_codes: ['critical-finding'] }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      language: 'ja',
      childProcessEnv: { TAKT_TEST: '1' },
    });

    await estimator.estimate(createModelInput());

    const [, prompt, options] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(prompt).toContain('required_tier');
    expect(prompt).not.toMatch(/terra|sol|candidate_pool|gpt-5|\/repo/i);
    expect(options).toMatchObject({
      cwd: '/repo',
      provider: 'claude-sdk',
      resolvedProvider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      resolvedModel: 'claude-haiku-4-5-20251001',
      permissionMode: 'readonly',
      language: 'ja',
      childProcessEnv: { TAKT_TEST: '1' },
      outputSchema: {
        properties: {
          required_tier: { type: 'string' },
          reason_codes: { type: 'array' },
        },
        required: ['required_tier', 'reason_codes'],
      },
    });
  });

  it('Given an invalid estimator response, When parsing it, Then it rejects without disclosing raw router content', async () => {
    const rawContent = '{"required_tier":"candidate=Authorization: Bearer sk-test","reason_codes":[]}';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: rawContent,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    try {
      await estimator.estimate(createModelInput());
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toMatch(/invalid required_tier/i);
      expect(error.message).not.toContain(rawContent);
      return;
    }
    throw new Error('Expected invalid estimator response to reject');
  });

  it('Given an already aborted parent signal, When estimating work requirements, Then no provider call starts', async () => {
    const controller = new AbortController();
    const reason = new Error('routing cancelled');
    controller.abort(reason);
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      abortSignal: controller.signal,
    });

    await expect(estimator.estimate(createModelInput())).rejects.toBe(reason);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('Given a call-scoped abort signal, When routing is cancelled, Then the estimator stops before a response arrives', async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });
    const controller = new AbortController();

    const estimate = estimator.estimate(createModelInput(), {
      abortSignal: controller.signal,
    });
    controller.abort(new Error('cancel routing'));

    await expect(estimate).rejects.toThrow('cancel routing');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('Given the router never responds, When the estimator timeout elapses, Then it fails instead of hanging the workflow', async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    const estimate = estimator.estimate(createModelInput());
    const rejection = expect(estimate).rejects.toThrow('timed out after 30000ms');
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });
});
