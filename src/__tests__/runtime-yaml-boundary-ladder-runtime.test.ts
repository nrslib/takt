import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkflowStep, WorkflowStep } from '../core/models/types.js';
import type { ProviderLadderConfig, TagRoutingConflictPolicy } from '../core/models/config-types.js';
import type { ProviderResolutionSource } from '../core/workflow/provider-options-trace.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../core/workflow/types.js';
import type { StructuredCaller } from '../agents/structured-caller.js';

/**
 * Issue #1208 Stage 1 — runtime consumption of `ladder` assignments (CT-LAD-2/3/4). A matched
 * target-less `{at:N}` promotion advances the GOVERNING ladder to the stage matching the number
 * of reached `{at}` entries, across every assignment path (steps / tags / personas / defaults). A
 * profile/pool direct assignment or a stage index past the ladder end is a no-op with a warning
 * (INV-B), and target-less `{at}` promotion never invokes the AI judge (INV-C).
 */

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createLogger: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      enter: vi.fn(),
      exit: vi.fn(),
    }),
  };
});

const { resolvePromotionRuntime } = await import('../core/workflow/promotion/promotion-runtime.js');

const MAIN: StepProviderInfo = { provider: 'opencode', model: 'ollama-cloud/glm-5.2' };
const STRONG = { provider: 'claude', model: 'opus' } as const;
const STRONGER = { provider: 'codex', model: 'gpt-5.5' } as const;

function makeStep(overrides: Partial<AgentWorkflowStep>): AgentWorkflowStep {
  return {
    name: 'development-core/fix',
    kind: 'agent',
    personaDisplayName: 'coder',
    instruction: '{task}',
    passPreviousResponse: true,
    ...overrides,
  } as AgentWorkflowStep;
}

function rejectingCaller(): { caller: StructuredCaller; evaluateCondition: ReturnType<typeof vi.fn> } {
  const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge must not run for a ladder promotion'));
  return { caller: { evaluateCondition } as unknown as StructuredCaller, evaluateCondition };
}

function makeContext(options: {
  baseSource: ProviderResolutionSource;
  providerLadders?: ProviderLadderConfig;
  evaluateCondition?: ReturnType<typeof vi.fn>;
  providerRoutingTagConflictPolicy?: TagRoutingConflictPolicy;
}) {
  const resolveStepProviderModel = (_step: WorkflowStep, _runtime?: RuntimeStepResolution): StepProviderInfo => ({
    provider: MAIN.provider,
    model: MAIN.model,
    providerSource: options.baseSource,
    modelSource: options.baseSource,
  });
  return {
    cwd: '/tmp/project',
    previousResponseContent: 'previous output',
    structuredCaller: options.evaluateCondition
      ? ({ evaluateCondition: options.evaluateCondition } as unknown as StructuredCaller)
      : undefined,
    resolveStepProviderModel,
    ...(options.providerLadders !== undefined ? { providerLadders: options.providerLadders } : {}),
    ...(options.providerRoutingTagConflictPolicy !== undefined
      ? { providerRoutingTagConflictPolicy: options.providerRoutingTagConflictPolicy }
      : {}),
  };
}

beforeEach(() => {
  warnSpy.mockClear();
});

describe('ladder stage progression across every assignment path (INV-A)', () => {
  it('carries the promoted ladder profile permission mode with its provider identity', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: {
          steps: {
            'development-core/fix': [
              { ...MAIN, permissionMode: 'readonly' },
              { ...STRONG, permissionMode: 'edit' },
            ],
          },
        },
      }),
      makeStep({ promotion: [{ at: 1 }] }),
      1,
      undefined,
    );

    expect(result?.providerInfo).toMatchObject({
      provider: 'claude',
      model: 'opus',
      permissionMode: 'edit',
    });
  });

  const cases: Array<{
    path: string;
    baseSource: ProviderResolutionSource;
    step: Partial<AgentWorkflowStep>;
    providerLadders: ProviderLadderConfig;
  }> = [
    {
      path: 'steps',
      baseSource: 'provider_routing.steps',
      step: { name: 'fix' },
      providerLadders: {
        workflowName: 'development-core',
        steps: { 'development-core/fix': [MAIN, STRONG] },
      },
    },
    {
      path: 'tags',
      baseSource: 'provider_routing.tags',
      step: { tags: ['heavy'] },
      providerLadders: { tags: { heavy: [MAIN, STRONG] } },
    },
    {
      path: 'personas',
      baseSource: 'persona_providers',
      step: { personaDisplayName: 'coder' },
      providerLadders: { personas: { coder: [MAIN, STRONG] } },
    },
    {
      path: 'defaults',
      baseSource: 'runtime-v1',
      step: {},
      providerLadders: { defaults: [MAIN, STRONG] },
    },
  ];

  for (const { path, baseSource, step, providerLadders } of cases) {
    it(`should promote to ladder stage 1 when a ${path} ladder is governing and {at:3} is reached`, async () => {
      const { evaluateCondition } = rejectingCaller();
      const result = await resolvePromotionRuntime(
        makeContext({ baseSource, providerLadders, evaluateCondition }),
        makeStep({ ...step, promotion: [{ at: 3 }] }),
        3,
        undefined,
      );
      expect(result?.providerInfo).toMatchObject({
        provider: STRONG.provider,
        model: STRONG.model,
        providerSource: 'promotion',
        modelSource: 'promotion',
      });
      // INV-C: an at-only ladder promotion is deterministic and never calls the AI judge.
      expect(evaluateCondition).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it(`should stay at ladder stage 0 when a ${path} ladder is governing and the step is below the {at} threshold`, async () => {
      const result = await resolvePromotionRuntime(
        makeContext({ baseSource, providerLadders }),
        makeStep({ ...step, promotion: [{ at: 3 }] }),
        2,
        undefined,
      );
      expect(result).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  }

  it('should advance the ladder two stages when both {at} thresholds are reached', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: { steps: { 'development-core/fix': [MAIN, STRONG, STRONGER] } },
      }),
      makeStep({ promotion: [{ at: 3 }, { at: 6 }] }),
      6,
      undefined,
    );
    expect(result?.providerInfo).toMatchObject({
      provider: STRONGER.provider,
      model: STRONGER.model,
      providerSource: 'promotion',
    });
  });

  it('should advance the ladder one stage when only the first {at} threshold is reached', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: { steps: { 'development-core/fix': [MAIN, STRONG, STRONGER] } },
      }),
      makeStep({ promotion: [{ at: 3 }, { at: 6 }] }),
      4,
      undefined,
    );
    expect(result?.providerInfo).toMatchObject({
      provider: STRONG.provider,
      model: STRONG.model,
    });
  });
});

describe('ladder no-op with a warning (INV-B)', () => {
  it('should no-op with a warning when a target-less promotion matches and no ladder is configured', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({ baseSource: 'runtime-v1' }),
      makeStep({ promotion: [{ at: 3 }] }),
      3,
      undefined,
    );
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no ladder governs its assignment'));
  });

  it('should no-op with a warning when a target-less promotion matches and the base assignment is a direct profile', async () => {
    // A direct `profile` assignment records no ladder for the step key, so the governing ladder is
    // absent even though other paths carry ladders.
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: { steps: { 'other/step': [MAIN, STRONG] } },
      }),
      makeStep({ promotion: [{ at: 3 }] }),
      3,
      undefined,
    );
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no ladder governs its assignment'));
  });
});

describe('ladder end clamps to the terminal stage — monotonic escalation (INV-B)', () => {
  it('should clamp to the terminal stage and warn when the requested stage index is past the ladder end', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: { steps: { 'development-core/fix': [MAIN, STRONG] } },
      }),
      makeStep({ promotion: [{ at: 3 }, { at: 6 }] }),
      6,
      undefined,
    );
    // Two thresholds reached → stage index 2, but the ladder only has stages 0 and 1. Promotion is
    // a monotonic escalation, so it clamps to the terminal stage (STRONG) rather than downgrading
    // toward the base assignment (MAIN), and warns that no further stage is available.
    expect(result?.providerInfo).toMatchObject({
      provider: STRONG.provider,
      model: STRONG.model,
      providerSource: 'promotion',
      modelSource: 'promotion',
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('the ladder ends at stage 1'));
  });
});

describe('targeted promotion still wins over the ladder (CT-PROMO-2 preserved)', () => {
  it('should drive provider/model directly and ignore ladders when a targeted {at} entry matches', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.steps',
        providerLadders: { steps: { 'development-core/fix': [MAIN, STRONG] } },
      }),
      makeStep({ promotion: [{ at: 3, provider: 'codex', model: 'gpt-5.5' }] }),
      3,
      undefined,
    );
    expect(result?.providerInfo).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      providerSource: 'promotion',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('tag ladder selection applies the same conflict policy as the base resolution', () => {
  const CONFLICTING_TAGS: ProviderLadderConfig = {
    tags: { heavy: [MAIN, STRONG], slow: [MAIN, STRONGER] },
  };

  it('should fail fast when two equal-priority tags carry different ladders under fail-fast', async () => {
    // Stage 0 is identical on both tags, so the base resolution sees no conflict; without the same
    // check here the later stages would silently pick a winner the base resolution never sanctioned.
    await expect(resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.tags',
        providerLadders: CONFLICTING_TAGS,
        providerRoutingTagConflictPolicy: 'fail-fast',
      }),
      makeStep({ tags: ['heavy', 'slow'], promotion: [{ at: 3 }] }),
      3,
      undefined,
    )).rejects.toThrow(/Conflicting provider ladders for tags \[heavy, slow\]/);
  });

  it('should let the last matched tag win when two equal-priority tags carry different ladders under last-wins', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.tags',
        providerLadders: CONFLICTING_TAGS,
        providerRoutingTagConflictPolicy: 'last-wins',
      }),
      makeStep({ tags: ['heavy', 'slow'], promotion: [{ at: 3 }] }),
      3,
      undefined,
    );
    expect(result?.providerInfo).toMatchObject({ provider: STRONGER.provider, model: STRONGER.model });
  });

  it('should not fail fast when two matched tags carry the identical ladder under fail-fast', async () => {
    const result = await resolvePromotionRuntime(
      makeContext({
        baseSource: 'provider_routing.tags',
        providerLadders: { tags: { heavy: [MAIN, STRONG], slow: [MAIN, STRONG] } },
        providerRoutingTagConflictPolicy: 'fail-fast',
      }),
      makeStep({ tags: ['heavy', 'slow'], promotion: [{ at: 3 }] }),
      3,
      undefined,
    );
    expect(result?.providerInfo).toMatchObject({ provider: STRONG.provider, model: STRONG.model });
  });
});
