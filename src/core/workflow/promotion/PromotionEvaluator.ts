import type { AgentWorkflowStep, WorkflowPromotionEntry } from '../../models/types.js';

export interface PromotionEvaluationContext {
  stepIteration: number;
}

function matchesAt(entry: WorkflowPromotionEntry, stepIteration: number): boolean {
  return entry.at !== undefined && stepIteration >= entry.at;
}

/**
 */
export function countMatchedLadderStages(
  step: AgentWorkflowStep,
  stepIteration: number,
): number {
  if (!step.promotion) {
    return 0;
  }
  let count = 0;
  for (const entry of step.promotion) {
    if (entry && matchesAt(entry, stepIteration)) {
      count++;
    }
  }
  return count;
}

export async function evaluatePromotion(
  step: AgentWorkflowStep,
  context: PromotionEvaluationContext,
): Promise<WorkflowPromotionEntry | undefined> {
  if (!step.promotion || step.promotion.length === 0) {
    return undefined;
  }

  for (let index = step.promotion.length - 1; index >= 0; index--) {
    const entry = step.promotion[index];
    if (!entry) {
      continue;
    }
    if (matchesAt(entry, context.stepIteration)) {
      return entry;
    }
  }

  return undefined;
}
