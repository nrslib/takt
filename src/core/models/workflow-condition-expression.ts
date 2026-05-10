export interface AiConditionExpression {
  text: string;
}

export interface AggregateConditionExpression {
  type: 'all' | 'any';
  argsText: string;
}

const AI_CONDITION_EXPRESSION_REGEX = /^ai\("(.+)"\)$/;
const AGGREGATE_CONDITION_EXPRESSION_REGEX = /^(all|any)\((.+)\)$/;

export function parseAiConditionExpression(value: string): AiConditionExpression | undefined {
  const match = value.match(AI_CONDITION_EXPRESSION_REGEX);
  if (!match?.[1]) {
    return undefined;
  }
  return { text: match[1] };
}

export function isAiConditionExpression(value: string): boolean {
  return parseAiConditionExpression(value) !== undefined;
}

export function parseAggregateConditionExpression(value: string): AggregateConditionExpression | undefined {
  const match = value.match(AGGREGATE_CONDITION_EXPRESSION_REGEX);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    type: match[1] as AggregateConditionExpression['type'],
    argsText: match[2],
  };
}

export function isAggregateConditionExpression(value: string): boolean {
  return parseAggregateConditionExpression(value) !== undefined;
}
