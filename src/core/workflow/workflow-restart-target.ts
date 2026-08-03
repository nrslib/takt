import type { WorkflowStep } from '../models/types.js';
import { isSystemWorkflowStep } from './step-kind.js';

export function isWorkflowRestartTarget(step: WorkflowStep): boolean {
  if (step.engineSynthesized === true) {
    return false;
  }
  if (!isSystemWorkflowStep(step)) {
    return true;
  }
  return step.effects === undefined || step.effects.length === 0;
}
