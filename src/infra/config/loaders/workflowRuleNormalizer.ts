import type { WorkflowRule } from '../../../core/models/index.js';
import {
  parseAggregateConditionArgs,
  parseAggregateConditionExpression,
  parseAiConditionExpression,
} from '../../../core/models/workflow-condition-expression.js';

export function normalizeRule(rule: {
  condition?: string;
  when?: string;
  next?: string;
  return?: string;
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): WorkflowRule {
  const condition = rule.condition ?? rule.when;
  if (!condition) {
    throw new Error('Workflow rule requires condition or when');
  }
  const next = rule.next ?? '';
  const aiExpression = parseAiConditionExpression(condition);
  if (aiExpression) {
    return {
      condition,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAiCondition: true,
      aiConditionText: aiExpression.text,
    };
  }

  const aggregateExpression = parseAggregateConditionExpression(condition);
  if (aggregateExpression) {
    const conditions = parseAggregateConditionArgs(aggregateExpression.argsText);
    return {
      condition,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAggregateCondition: true,
      aggregateType: aggregateExpression.type,
      aggregateConditionText: conditions.length === 1 ? conditions[0]! : conditions,
      ...(aggregateExpression.guardCondition !== undefined
        ? { aggregateGuardCondition: aggregateExpression.guardCondition }
        : {}),
    };
  }

  return {
    condition,
    next,
    returnValue: rule.return,
    appendix: rule.appendix,
    requiresUserInput: rule.requires_user_input,
    interactiveOnly: rule.interactive_only,
  };
}
