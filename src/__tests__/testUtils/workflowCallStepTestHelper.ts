import type { WorkflowCallStep, WorkflowConfig, WorkflowStep } from '../../core/models/index.js';

export function findWorkflowCallStep(
  workflow: WorkflowConfig,
  stepName: string,
  call?: string,
): WorkflowCallStep {
  const visit = (steps: readonly WorkflowStep[]): WorkflowCallStep | undefined => {
    for (const step of steps) {
      if (step.kind === 'workflow_call' && step.name === stepName && (call === undefined || step.call === call)) {
        return step;
      }
      const nested = visit(step.parallel ?? []);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };
  const step = visit(workflow.steps);
  if (!step) {
    throw new Error(`workflow_call step "${stepName}" was not found in test workflow "${workflow.name}"`);
  }
  return step;
}
