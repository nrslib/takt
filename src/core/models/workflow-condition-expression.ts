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
      if (!isEscapedQuote(value, index)) {
        inString = !inString;
      }
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

export function isEscapedQuote(value: string, quoteIndex: number): boolean {
  let slashCount = 0;
  for (let index = quoteIndex - 1; index >= 0 && value[index] === '\\'; index--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

export function parseAggregateConditionArgs(argsText: string): string[] {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }

  if (!startsWithAggregateStringDelimiter(trimmed)) {
    return parseUnquotedConditionArgs(trimmed);
  }

  const conditions = parseDoubleQuotedArgs(trimmed);

  if (conditions.length > 0) {
    return conditions;
  }

  const escapedConditions = parseBackslashQuotedArgs(trimmed);
  if (escapedConditions.length === 0) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }
  return escapedConditions;
}

function startsWithAggregateStringDelimiter(argsText: string): boolean {
  return argsText.startsWith('"') || argsText.startsWith('\\"');
}

function parseDoubleQuotedArgs(argsText: string): string[] {
  const conditions: string[] = [];

  for (let index = 0; index < argsText.length; index++) {
    if (argsText[index] !== '"') {
      continue;
    }
    const start = index + 1;
    for (index = start; index < argsText.length; index++) {
      if (argsText[index] === '"' && !isEscapedQuote(argsText, index)) {
        const condition = unescapeAggregateStringArg(argsText.slice(start, index));
        if (condition.length > 0) {
          conditions.push(condition);
        }
        break;
      }
    }
  }

  return conditions;
}

function parseBackslashQuotedArgs(argsText: string): string[] {
  const conditions: string[] = [];

  for (let index = 0; index < argsText.length - 1; index++) {
    if (!isBackslashQuoteDelimiter(argsText, index)) {
      continue;
    }
    const start = index + 2;
    for (index = start; index < argsText.length - 1; index++) {
      if (isBackslashQuoteDelimiter(argsText, index)) {
        const condition = unescapeAggregateStringArg(argsText.slice(start, index));
        if (condition.length > 0) {
          conditions.push(condition);
        }
        index++;
        break;
      }
    }
  }

  return conditions;
}

function parseUnquotedConditionArgs(argsText: string): string[] {
  const conditions: string[] = [];
  let start = 0;
  let inString = false;
  let depth = 0;

  for (let index = 0; index < argsText.length; index++) {
    const current = argsText[index];
    if (current === '"' && !isEscapedQuote(argsText, index)) {
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
      continue;
    }
    if (current === ',' && depth === 0) {
      conditions.push(argsText.slice(start, index).trim());
      start = index + 1;
    }
  }

  conditions.push(argsText.slice(start).trim());
  if (conditions.some((condition) => condition.length === 0)) {
    throw new Error(`Invalid aggregate condition format: ${argsText}`);
  }
  return conditions;
}

function unescapeAggregateStringArg(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const current = value[index];
    const next = value[index + 1];
    if (current === '\\' && (next === '"' || next === '\\')) {
      result += next;
      index++;
      continue;
    }
    result += current;
  }
  return result;
}

function isBackslashQuoteDelimiter(value: string, slashIndex: number): boolean {
  if (value[slashIndex] !== '\\' || value[slashIndex + 1] !== '"') {
    return false;
  }
  let precedingSlashCount = 0;
  for (let index = slashIndex - 1; index >= 0 && value[index] === '\\'; index--) {
    precedingSlashCount++;
  }
  return precedingSlashCount % 2 === 0;
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
