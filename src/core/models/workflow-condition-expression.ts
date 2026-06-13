export interface AiConditionExpression {
  text: string;
}

export interface AggregateConditionExpression {
  type: 'all' | 'any';
  argsText: string;
  guardCondition?: string;
}

const AI_CONDITION_EXPRESSION_REGEX = /^ai\("(.+)"\)$/;

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

function findClosingParen(value: string, startIndex: number): number {
  let inString = false;
  let depth = 0;

  for (let index = startIndex; index < value.length; index++) {
    const current = value[index];
    if (current === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (current === '(') {
      depth++;
      continue;
    }
    if (current === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

export function parseAggregateConditionExpression(value: string): AggregateConditionExpression | undefined {
  const trimmed = value.trim();
  const match = trimmed.match(/^(all|any)\(/);
  if (!match?.[1]) {
    return undefined;
  }
  const argsStart = match[0].length - 1;
  const argsEnd = findClosingParen(trimmed, argsStart);
  if (argsEnd < 0) {
    return undefined;
  }
  const argsText = trimmed.slice(argsStart + 1, argsEnd);
  if (argsText.trim().length === 0) {
    return undefined;
  }
  const remainder = trimmed.slice(argsEnd + 1).trim();
  if (remainder.length > 0 && !remainder.startsWith('&&')) {
    return undefined;
  }
  const guardCondition = remainder.length > 0 ? remainder.slice(2).trim() : undefined;
  if (guardCondition === '') {
    return undefined;
  }

  return {
    type: match[1] as AggregateConditionExpression['type'],
    argsText,
    ...(guardCondition !== undefined ? { guardCondition } : {}),
  };
}

export function isAggregateConditionExpression(value: string): boolean {
  return parseAggregateConditionExpression(value) !== undefined;
}
