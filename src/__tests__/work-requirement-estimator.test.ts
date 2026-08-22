import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkRequirementEstimator } from '../agents/auto-routing-usecase.js';
import { runAgent } from '../agents/runner.js';
import type { RoutingModelInput } from '../core/workflow/auto-routing/contracts.js';
import { StructuredOutputSchemaError } from '../core/workflow/engine/structured-output-schema-validator.js';

const { assertStrictStructuredOutputSchema } = vi.hoisted(() => ({
  assertStrictStructuredOutputSchema: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/engine/structured-output-schema-validator.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/engine/structured-output-schema-validator.js')>(),
  assertStrictStructuredOutputSchema,
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
    remainingWork: [{ source: 'task', description: 'A validation branch is incomplete.' }],
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

  it('Given the estimator output schema is invalid, When constructing the estimator, Then it fails before calling a provider', () => {
    const schemaError = new StructuredOutputSchemaError('Structured output schema is not strict');
    assertStrictStructuredOutputSchema.mockImplementationOnce(() => {
      throw schemaError;
    });

    expect(() => createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'codex',
      model: 'gpt-5.6-luna',
    })).toThrow(schemaError);
    expect(runAgent).not.toHaveBeenCalled();
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

  it('Given a router without native structured output, When confidence is null, Then the estimate is accepted', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({
        required_tier: 'medium',
        reason_codes: ['focused-change'],
        confidence: null,
      }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'cursor',
      model: 'cursor/gpt-5',
    });

    await expect(estimator.estimate(createModelInput())).resolves.toEqual({
      requiredTier: 'medium',
      reasonCodes: ['focused-change'],
    });
  });

  it('Given provider-native structured output, When content is not JSON, Then the structured estimate is used', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: 'The estimate is available in structured output.',
      structuredOutput: {
        required_tier: 'high',
        reason_codes: ['complex-work'],
        confidence: null,
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
      reasonCodes: ['complex-work'],
    });
  });

  it('Given normalized work input, When the estimator prompts the router, Then it does not disclose candidates, models, pools, or repository identifiers', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({
        required_tier: 'high',
        reason_codes: ['complex-work'],
        confidence: null,
      }),
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
    expect(prompt).not.toMatch(/terra|sol|candidate_pool|gpt-5|\/repo/i);
    expect(options).toMatchObject({
      cwd: '/repo',
      resolvedExecution: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
      language: 'ja',
      childProcessEnv: { TAKT_TEST: '1' },
      outputSchema: {
        properties: {
          required_tier: { type: 'string' },
          reason_codes: { type: 'array' },
          confidence: { type: ['number', 'null'] },
        },
        required: ['required_tier', 'reason_codes', 'confidence'],
      },
    });
    const outputProperties = options?.outputSchema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(outputProperties?.reason_codes).not.toHaveProperty('maxItems');
    expect(outputProperties?.reason_codes?.items).not.toHaveProperty('maxLength');
  });

  it('Given a Codex router, When the strict output schema is submitted, Then the estimator returns a dynamic tier instead of failing', async () => {
    vi.mocked(runAgent).mockImplementation(async (_persona, _prompt, options) => {
      const schema = options?.outputSchema;
      const properties = schema?.properties;
      const required = schema?.required;
      if (typeof properties !== 'object' || properties === null || !Array.isArray(required)) {
        throw new Error('Codex rejected an invalid structured output schema');
      }
      expect(new Set(required)).toEqual(new Set(Object.keys(properties)));
      expect(properties).toMatchObject({
        confidence: { type: ['number', 'null'] },
      });
      return {
        persona: 'auto-router',
        status: 'done',
        content: JSON.stringify({
          required_tier: 'medium',
          reason_codes: ['focused-change'],
          confidence: null,
        }),
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      };
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'codex',
      model: 'gpt-5.6-luna',
    });

    await expect(estimator.estimate(createModelInput())).resolves.toEqual({
      requiredTier: 'medium',
      reasonCodes: ['focused-change'],
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
      expect(error.message).toMatch(/required_tier.*allowed values/i);
      expect(error.message).not.toContain(rawContent);
      return;
    }
    throw new Error('Expected invalid estimator response to reject');
  });

  it.each([
    {
      name: 'too many reason codes',
      reasonCodes: Array.from({ length: 5 }, () => 'focused-change'),
    },
    {
      name: 'an oversized reason code',
      reasonCodes: ['x'.repeat(33)],
    },
  ])('Given $name, When parsing the estimate, Then runtime validation rejects it', async ({ reasonCodes }) => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({
        required_tier: 'medium',
        reason_codes: reasonCodes,
        confidence: null,
      }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    await expect(estimator.estimate(createModelInput())).rejects.toThrow(/reason_codes/);
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

  it('passes deadline-scoped stream and activity callbacks to the structured provider call', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: '{}',
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
      structuredOutput: {
        required_tier: 'low',
        reason_codes: ['focused-change'],
        confidence: null,
      },
    });
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });
    const onStream = vi.fn();
    const onActivity = vi.fn();

    await estimator.estimate(createModelInput(), { onStream, onActivity });

    expect(runAgent).toHaveBeenCalledWith(
      'auto-router',
      expect.any(String),
      expect.objectContaining({ onStream, onActivity }),
    );
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
