import type { WorkflowCallStep, WorkflowConfig } from '../../../core/models/index.js';

export function validateWorkflowCallRulesAgainstChildReturns(
  step: WorkflowCallStep,
  childWorkflow: WorkflowConfig,
): void {
  const allowedConditions = new Set([
    'COMPLETE',
    'ABORT',
    ...(childWorkflow.subworkflow?.returns ?? []),
  ]);

  for (const rule of step.rules ?? []) {
    if (!allowedConditions.has(rule.condition)) {
      throw new Error(
        `workflow_call step "${step.name}" cannot route on unsupported child result "${rule.condition}"`,
      );
    }
  }
}
