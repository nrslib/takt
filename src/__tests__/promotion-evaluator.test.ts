import { describe, expect, it, vi } from 'vitest';
import { evaluatePromotion } from '../core/workflow/promotion/PromotionEvaluator.js';
import type { AgentWorkflowStep, StepProviderOptions } from '../core/models/index.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { ProviderType } from '../shared/types/provider.js';

type PromotionEntry = {
  at?: number;
  condition?: string;
  aiConditionText?: string;
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
};

function makePromotionStep(promotion?: PromotionEntry[]): AgentWorkflowStep {
  return {
    name: 'implement',
    kind: 'agent',
    personaDisplayName: 'coder',
    instruction: '{task}',
    passPreviousResponse: true,
    promotion,
  } as AgentWorkflowStep & { promotion?: PromotionEntry[] };
}

function makeStructuredCaller(
  evaluateCondition = vi.fn().mockResolvedValue(-1),
): StructuredCaller {
  return {
    evaluateCondition,
  } as unknown as StructuredCaller;
}

function makeContext(overrides: {
  stepIteration: number;
  previousResponseContent?: string;
  structuredCaller?: StructuredCaller;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
}) {
  return {
    cwd: '/tmp/project',
    stepIteration: overrides.stepIteration,
    previousResponseContent: overrides.previousResponseContent ?? 'previous output',
    structuredCaller: overrides.structuredCaller ?? makeStructuredCaller(),
    resolvedProvider: overrides.resolvedProvider,
    resolvedModel: overrides.resolvedModel,
  };
}

describe('evaluatePromotion', () => {
  it('matches an at-only promotion when the step iteration reaches the threshold without calling AI', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const step = makePromotionStep([
      {
        at: 3,
        model: 'gpt-5.5',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 3,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toMatchObject({ at: 3, model: 'gpt-5.5' });
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('does not match an at-only promotion before the step iteration reaches the threshold', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const step = makePromotionStep([
      {
        at: 3,
        model: 'gpt-5.5',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 2,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toBeUndefined();
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('matches a condition-only promotion through structuredCaller using previous response content', async () => {
    const evaluateCondition = vi.fn().mockImplementation(async (
      _content: string,
      conditions: Array<{ index: number; text: string }>,
    ) => conditions[0]?.index ?? -1);
    const step = makePromotionStep([
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        model: 'gpt-5.5',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 1,
      previousResponseContent: 'review output',
      structuredCaller: makeStructuredCaller(evaluateCondition),
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    }));

    expect(result).toMatchObject({ model: 'gpt-5.5' });
    expect(evaluateCondition).toHaveBeenCalledWith(
      'review output',
      [expect.objectContaining({ text: 'review found an architectural blocker' })],
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.4',
      }),
    );
  });

  it('treats at and condition on the same entry as OR and short-circuits AI when at matches', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const step = makePromotionStep([
      {
        at: 2,
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        model: 'gpt-5.5',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 2,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toMatchObject({ at: 2, model: 'gpt-5.5' });
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('uses the last matching promotion entry and skips earlier AI entries when a later at entry matches', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('earlier AI entry should not run'));
    const step = makePromotionStep([
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        model: 'gpt-5.5',
      },
      {
        at: 5,
        provider: 'claude',
        model: 'opus',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 5,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toMatchObject({ at: 5, provider: 'claude', model: 'opus' });
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it('does not require structuredCaller when a later at entry matches before earlier AI entries', async () => {
    const step = makePromotionStep([
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        model: 'gpt-5.5',
      },
      {
        at: 5,
        provider: 'claude',
        model: 'opus',
      },
    ]);

    const result = await evaluatePromotion(step, {
      cwd: '/tmp/project',
      stepIteration: 5,
      previousResponseContent: 'previous output',
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    });

    expect(result).toMatchObject({ at: 5, provider: 'claude', model: 'opus' });
  });

  it('fails fast when an AI promotion condition must be evaluated without structuredCaller', async () => {
    const step = makePromotionStep([
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        model: 'gpt-5.5',
      },
    ]);

    await expect(evaluatePromotion(step, {
      cwd: '/tmp/project',
      stepIteration: 1,
      previousResponseContent: 'previous output',
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    })).rejects.toThrow('requires structuredCaller');
  });

  it('requires AI promotion conditions to be normalized before runtime evaluation', async () => {
    const step = makePromotionStep([
      {
        condition: 'ai("review found an architectural blocker")',
        model: 'gpt-5.5',
      },
    ]);

    await expect(evaluatePromotion(step, makeContext({
      stepIteration: 1,
      structuredCaller: makeStructuredCaller(),
    }))).rejects.toThrow('is not normalized');
  });

  it('lets a later condition entry override an earlier at entry', async () => {
    const evaluateCondition = vi.fn().mockImplementation(async (
      _content: string,
      conditions: Array<{ index: number; text: string }>,
    ) => conditions[0]?.index ?? -1);
    const step = makePromotionStep([
      {
        at: 2,
        model: 'gpt-5.5',
      },
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        provider: 'claude',
        model: 'opus',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 2,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(evaluateCondition).toHaveBeenCalledWith(
      'previous output',
      [expect.objectContaining({ text: 'review found an architectural blocker' })],
      expect.any(Object),
    );
  });

  it('falls back to an earlier at entry when a later condition entry does not match', async () => {
    const evaluateCondition = vi.fn().mockResolvedValue(-1);
    const step = makePromotionStep([
      {
        at: 2,
        model: 'gpt-5.5',
      },
      {
        condition: 'ai("review found an architectural blocker")',
        aiConditionText: 'review found an architectural blocker',
        provider: 'claude',
        model: 'opus',
      },
    ]);

    const result = await evaluatePromotion(step, makeContext({
      stepIteration: 2,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toMatchObject({ at: 2, model: 'gpt-5.5' });
    expect(evaluateCondition).toHaveBeenCalledOnce();
  });

  it('returns undefined without calling AI when the step has no promotion entries', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));

    const result = await evaluatePromotion(makePromotionStep(), makeContext({
      stepIteration: 1,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    }));

    expect(result).toBeUndefined();
    expect(evaluateCondition).not.toHaveBeenCalled();
  });
});
