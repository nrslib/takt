import { describe, expect, it } from 'vitest';
import {
  countMatchedLadderStages,
  evaluatePromotion,
} from '../core/workflow/promotion/PromotionEvaluator.js';
import type { AgentWorkflowStep } from '../core/models/index.js';

function makePromotionStep(
  promotion?: Array<{ at: number }>,
): AgentWorkflowStep {
  return {
    name: 'implement',
    kind: 'agent',
    personaDisplayName: 'coder',
    instruction: '{task}',
    passPreviousResponse: true,
    promotion,
  } as AgentWorkflowStep;
}

describe('evaluatePromotion', () => {
  it('matches the last reached runtime ladder entry', async () => {
    const step = makePromotionStep([{ at: 2 }, { at: 5 }, { at: 8 }]);

    await expect(evaluatePromotion(step, { stepIteration: 5 })).resolves.toEqual({ at: 5 });
    expect(countMatchedLadderStages(step, 5)).toBe(2);
  });

  it('does not match a ladder entry before its iteration', async () => {
    const step = makePromotionStep([{ at: 3 }]);

    await expect(evaluatePromotion(step, { stepIteration: 2 })).resolves.toBeUndefined();
    expect(countMatchedLadderStages(step, 2)).toBe(0);
  });

  it('has no AI condition evaluation path', async () => {
    const step = makePromotionStep([{ at: 1 }]);

    await expect(evaluatePromotion(step, { stepIteration: 1 })).resolves.toEqual({ at: 1 });
  });
});
