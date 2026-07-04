import type { WorkflowRule } from '../../../core/models/index.js';
import {
  parseAggregateConditionArgs,
  parseAggregateConditionExpression,
  parseAiConditionExpression,
} from '../../../core/models/workflow-condition-expression.js';
import { isFindingsCondition } from '../../../core/workflow/evaluation/rule-utils.js';

/**
 * Split a plain compound condition "<tag text> && <findings guard>" into its
 * tag-matching text and deterministic guard. The when-evaluator cannot parse
 * bare status text as an operand, so compounds must be decomposed here.
 * Returns undefined when the condition is not in that shape.
 */
function splitTagFindingsCondition(condition: string): { tagText: string; guard: string } | undefined {
  const clauses = condition.split('&&').map((clause) => clause.trim());
  if (clauses.length < 2 || clauses.some((clause) => clause.length === 0)) {
    return undefined;
  }
  const [tagText, ...guardClauses] = clauses;
  if (tagText === undefined || isFindingsCondition(tagText)) {
    return undefined;
  }
  const guard = guardClauses.join(' && ');
  if (!isFindingsCondition(guard)) {
    return undefined;
  }
  return { tagText, guard };
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

  const compound = splitTagFindingsCondition(condition);
  if (compound) {
    return {
      condition: compound.tagText,
      next,
      returnValue: rule.return,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      guardCondition: compound.guard,
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
