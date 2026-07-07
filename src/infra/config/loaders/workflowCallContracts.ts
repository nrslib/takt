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
    // workflow_call の遷移判定は子ワークフローの結果名との文字列一致で行われ、
    // findings ガードを評価する経路がない。黙って無視するより設定時に拒否する。
    if (rule.guardCondition !== undefined) {
      throw new Error(
        `workflow_call step "${step.name}" does not support findings guards on rules (condition "${rule.condition}"): route to a normal step and guard there instead`,
      );
    }
    if (!allowedConditions.has(rule.condition)) {
      throw new Error(
        `workflow_call step "${step.name}" cannot route on unsupported child result "${rule.condition}"`,
      );
    }
  }
}
