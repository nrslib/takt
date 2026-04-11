import type { WorkflowStep } from '../../models/types.js';

export async function waitForStepDelay(step: WorkflowStep): Promise<void> {
  if (step.delayBeforeMs == null || step.delayBeforeMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, step.delayBeforeMs));
}
