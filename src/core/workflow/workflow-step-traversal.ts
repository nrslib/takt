import type {
  WorkflowCallStep,
  WorkflowStep,
} from '../models/types.js';
import { getAllParallelSubSteps } from '../models/types.js';
import { isWorkflowCallStep } from './step-kind.js';

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
