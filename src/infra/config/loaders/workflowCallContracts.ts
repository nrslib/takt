import type { WorkflowCallStep, WorkflowConfig } from '../../../core/models/index.js';
import { formatWorkflowRuleCondition, terminalLabelOf } from '../../../core/models/workflow-rule-condition.js';

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
    const terminalLabel = terminalLabelOf(rule.condition);
    if (terminalLabel === undefined || !allowedConditions.has(terminalLabel)) {
      throw new Error(
        `workflow_call step "${step.name}" cannot route on unsupported child result "${formatWorkflowRuleCondition(rule.condition)}"`,
      );
    }
  }
}
