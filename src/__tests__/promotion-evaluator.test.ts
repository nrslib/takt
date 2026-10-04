import { describe, expect, it } from 'vitest';
import { countMatchedLadderStages } from '../core/workflow/promotion/PromotionEvaluator.js';
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

describe('countMatchedLadderStages', () => {
  it('counts every reached runtime ladder entry', () => {
    const step = makePromotionStep([{ at: 2 }, { at: 5 }, { at: 8 }]);

    expect(countMatchedLadderStages(step, 5)).toBe(2);
  });

  it('returns zero before the first ladder entry', () => {
    const step = makePromotionStep([{ at: 3 }]);

    expect(countMatchedLadderStages(step, 2)).toBe(0);
  });
});
