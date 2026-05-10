import type { WorkflowRule } from '../../../core/models/index.js';
import {
  parseAggregateConditionExpression,
  parseAiConditionExpression,
} from '../../../core/models/workflow-condition-expression.js';

function parseAggregateConditions(argsText: string): string[] {
  const conditions: string[] = [];
  const regex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(argsText)) !== null) {
    if (match[1]) {
      conditions.push(match[1]);
    }
  }
  if (conditions.length === 0) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }
  return conditions;
}

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
    const conditions = parseAggregateConditions(aggregateExpression.argsText);
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
