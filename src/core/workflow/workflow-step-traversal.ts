import type {
  WorkflowCallStep,
  WorkflowStep,
} from '../models/types.js';
import { getAllParallelSubSteps } from '../models/types.js';
import type { WorkflowEffect } from '../models/workflow-system-input-types.js';
import { isWorkflowCallStep } from './step-kind.js';

export function hasCacciaEffect(steps: readonly WorkflowStep[]): boolean {
  return hasWorkflowEffect(steps, 'caccia');
}

function hasWorkflowEffect(steps: readonly WorkflowStep[], type: WorkflowEffect['type']): boolean {
  return steps.some((step) => (
    (step.kind === 'system' && step.effects?.some((effect) => effect.type === type) === true)
    || (step.parallel !== undefined && hasWorkflowEffect(getAllParallelSubSteps(step.parallel), type))
  ));
}

export function collectWorkflowCallSteps(
  steps: readonly WorkflowStep[],
): WorkflowCallStep[] {
  const matches: WorkflowCallStep[] = [];
  for (const step of steps) {
    if (isWorkflowCallStep(step)) {
      matches.push(step);
    }
    matches.push(...collectWorkflowCallSteps(
      step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel),
    ));
  }
  return matches;
}
