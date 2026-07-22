import type { WorkflowStep, WorkflowState } from '../../models/types.js';
import {
  formatWorkflowRuleCondition,
  type WorkflowRuleCondition,
} from '../../models/workflow-rule-condition.js';

export class AggregateEvaluator {
  constructor(private readonly step: WorkflowStep, private readonly state: WorkflowState) {}

  evaluateCondition(condition: WorkflowRuleCondition): boolean {
    if (condition.kind !== 'aggregate') return false;
    const subSteps = this.step.parallel;
    if (subSteps === undefined || subSteps.length === 0) return false;
    const matchedConditions = subSteps.map((subStep) => {
      const output = this.state.stepOutputs.get(subStep.name);
      const rule = output?.matchedRuleIndex === undefined ? undefined : subStep.rules?.[output.matchedRuleIndex];
      return rule === undefined ? undefined : formatWorkflowRuleCondition(rule.condition);
    });
    const expectedConditions = condition.targetConditions.map(formatWorkflowRuleCondition);
    if (condition.aggregate === 'all') {
      return expectedConditions.length === 1
        ? matchedConditions.every((matchedCondition) => matchedCondition === expectedConditions[0])
        : matchedConditions.length === expectedConditions.length
          && matchedConditions.every((matchedCondition, index) => matchedCondition === expectedConditions[index]);
    }
    return matchedConditions.some((matchedCondition) => (
      matchedCondition !== undefined && expectedConditions.includes(matchedCondition)
    ));
  }
}
