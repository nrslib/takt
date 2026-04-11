import type { WorkflowRule } from '../../../core/models/index.js';

const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;
const AGGREGATE_CONDITION_REGEX = /^(all|any)\((.+)\)$/;

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
  appendix?: string;
  requires_user_input?: boolean;
  interactive_only?: boolean;
}): WorkflowRule {
  const condition = rule.condition ?? rule.when;
  if (!condition) {
    throw new Error('Workflow rule requires condition or when');
  }
  const next = rule.next ?? '';
  const aiMatch = condition.match(AI_CONDITION_REGEX);
  if (aiMatch?.[1]) {
    return {
      condition,
      next,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAiCondition: true,
      aiConditionText: aiMatch[1],
    };
  }

  const aggregateMatch = condition.match(AGGREGATE_CONDITION_REGEX);
  if (aggregateMatch?.[1] && aggregateMatch[2]) {
    const conditions = parseAggregateConditions(aggregateMatch[2]);
    return {
      condition,
      next,
      appendix: rule.appendix,
      requiresUserInput: rule.requires_user_input,
      interactiveOnly: rule.interactive_only,
      isAggregateCondition: true,
      aggregateType: aggregateMatch[1] as 'all' | 'any',
      aggregateConditionText: conditions.length === 1 ? conditions[0]! : conditions,
    };
  }

  return {
    condition,
    next,
    appendix: rule.appendix,
    requiresUserInput: rule.requires_user_input,
    interactiveOnly: rule.interactive_only,
  };
}
