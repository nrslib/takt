import type { AgentWorkflowStep, WorkflowPromotionEntry } from '../../models/types.js';

function matchesAt(entry: WorkflowPromotionEntry, stepIteration: number): boolean {
  return entry.at !== undefined && stepIteration >= entry.at;
}

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
