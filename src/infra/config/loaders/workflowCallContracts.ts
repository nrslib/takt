import type { WorkflowCallStep, WorkflowConfig } from '../../../core/models/index.js';
import { formatWorkflowRuleCondition, terminalLabelOf } from '../../../core/models/workflow-rule-condition.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';

export function validateWorkflowCallRulesAgainstChildReturns(
  step: WorkflowCallStep,
  childWorkflow: WorkflowConfig,
  stepPath?: readonly PropertyKey[],
): void {
  const allowedConditions = new Set([
    'COMPLETE',
    'ABORT',
    ...(childWorkflow.subworkflow?.returns ?? []),
  ]);

  for (const [ruleIndex, rule] of (step.rules ?? []).entries()) {
    const terminalLabel = terminalLabelOf(rule.condition);
    if (terminalLabel === undefined || !allowedConditions.has(terminalLabel)) {
      const error = new Error(
        `workflow_call step "${step.name}" cannot route on unsupported child result "${formatWorkflowRuleCondition(rule.condition)}"`,
      );
      throw stepPath ? withWorkflowStepErrorPath(error, [...stepPath, 'rules', ruleIndex]) : error;
    }
  }
}
