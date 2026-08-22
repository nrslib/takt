import type { WorkflowRule } from '../../../core/models/index.js';
import {
  hasCompanionReference,
  parseWorkflowRuleCondition,
} from '../../../core/models/workflow-rule-condition.js';

export function normalizeRule(rule: {
  condition?: string;
  next?: string;
  return?: string;
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): WorkflowRule {
  if (rule.condition === undefined) throw new Error('Workflow rule requires condition');
  const condition = parseWorkflowRuleCondition(rule.condition);
  if (hasCompanionReference(condition)) {
    throw new Error('Workflow transition rules cannot reference advisory companion state');
  }
  return {
    condition,
    ...(rule.next === undefined ? {} : { next: rule.next }),
    returnValue: rule.return,
    appendix: rule.appendix,
    requiresUserInput: rule.requires_user_input,
    interactiveOnly: rule.interactive_only,
  };
}
