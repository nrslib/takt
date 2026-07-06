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
  let index = 0;

  while (index < argsText.length) {
    index = skipWhitespace(argsText, index);
    if (argsText[index] !== '"') {
      return [];
    }
    const start = index + 1;
    const end = findUnescapedQuote(argsText, start);
    if (end < 0) {
      return [];
    }
    const condition = unescapeAggregateStringArg(argsText.slice(start, end));
    if (condition.trim().length === 0) {
      throw new Error(`Invalid aggregate condition format: ${argsText}`);
    }
    conditions.push(condition);
    index = skipWhitespace(argsText, end + 1);
    if (index >= argsText.length) {
      break;
    }
    if (argsText[index] !== ',') {
      return [];
    }
    index++;
    if (skipWhitespace(argsText, index) >= argsText.length) {
      throw new Error(`Invalid aggregate condition format: ${argsText}`);
    }
  }

  return conditions;
}

function findUnescapedQuote(value: string, startIndex: number): number {
  for (let index = startIndex; index < value.length; index++) {
    if (value[index] === '"' && !isEscapedQuote(value, index)) {
      return index;
    }
  }
  return -1;
}

function skipWhitespace(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length) {
    const current = value[index];
    if (current === undefined || !/\s/.test(current)) {
      break;
    }
    index++;
  }
  return index;
}

function parseBackslashQuotedArgs(argsText: string): string[] {
  const conditions: string[] = [];
  let index = 0;

  while (index < argsText.length) {
    index = skipWhitespace(argsText, index);
    if (!isBackslashQuoteDelimiter(argsText, index)) {
      return [];
    }
    const start = index + 2;
    let closed = false;
    for (index = start; index < argsText.length; index++) {
      if (isBackslashQuoteDelimiter(argsText, index)) {
        const condition = unescapeAggregateStringArg(argsText.slice(start, index));
        if (condition.trim().length === 0) {
          throw new Error(`Invalid aggregate condition format: ${argsText}`);
        }
        conditions.push(condition);
        index = skipWhitespace(argsText, index + 2);
        closed = true;
        break;
      }
    }
    if (!closed) {
      return [];
    }
    if (index >= argsText.length) {
      break;
    }
    if (argsText[index] !== ',') {
      return [];
    }
    index++;
    if (skipWhitespace(argsText, index) >= argsText.length) {
      throw new Error(`Invalid aggregate condition format: ${argsText}`);
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
  const guardText = remainder.length > 0 ? remainder.slice(2).trim() : undefined;
  if (guardText === '') {
    return undefined;
  }
  // ガードは when(式) の列として書かれる。内側の式に unwrap して保持し、
  // 評価側（evaluateWhenExpression）は素の式だけを扱う。裸の式は認めない
  // （集約条件のガードに散文はあり得ないため、明示エラーで移行させる）。
  let guardCondition: string | undefined;
  if (guardText !== undefined) {
    const clauses = splitGuardClauses(guardText);
    for (const clause of clauses) {
      if (!isWhenConditionExpression(clause)) {
        throw new Error(
          `Configuration error: aggregate guard clause "${clause}" must be wrapped in when(...), e.g. when(${clause})`,
        );
      }
    }
    guardCondition = clauses.map(unwrapWhenConditionExpression).join(' && ');
  }

  return {
    type: match[1] as AggregateConditionExpression['type'],
    argsText,
    ...(guardCondition !== undefined ? { guardCondition } : {}),
  };
}

/**
 * when(<式>) 形式か（括弧バランスで判定。when(A) && when(B) のような
 * 連結は単一の when 条件ではない）。
 */

/**
 * 括弧・引用符（エスケープ含む）を尊重してトップレベルの論理区切りで分割する。
 * 空節は保持する（壊れた設定の fail-fast 判定は呼び出し側の責務）。
 * parse / normalize / evaluate が同一のトークナイズを共有するための唯一の実装。
 */
export function splitTopLevelClauses(expression: string, separator: '||' | '&&'): string[] {
  const parts: string[] = [];
  let inString = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length - 1; index++) {
    const current = expression[index];
    if (current === '"' && !isEscapedQuote(expression, index)) {
      inString = !inString;
      continue;
    }
    if (!inString && current === '(') { depth++; continue; }
    if (!inString && current === ')') { depth--; continue; }
    if (!inString && depth === 0 && expression.slice(index, index + 2) === separator) {
      parts.push(expression.slice(start, index).trim());
      start = index + 2;
      index++;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts;
}

/** 後方の呼び出し向け: && 専用の別名。 */
export function splitTopLevelAndClauses(expression: string): string[] {
  return splitTopLevelClauses(expression, '&&');
}

/** 分割して空節があれば fail-fast する（subject はエラー文の主語）。 */
export function splitTopLevelClausesOrThrow(
  expression: string,
  separator: '||' | '&&',
  subject: string,
): string[] {
  const clauses = splitTopLevelClauses(expression, separator);
  for (const clause of clauses) {
    if (clause.length === 0) {
      throw new Error(`Configuration error: ${subject} "${expression}" contains an empty clause`);
    }
  }
  return clauses;
}

function splitGuardClauses(expression: string): string[] {
  return splitTopLevelClausesOrThrow(expression, '&&', 'aggregate guard');
}


export function isWhenConditionExpression(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('when(') || !trimmed.endsWith(')')) {
    return false;
  }
  const closing = findClosingParen(trimmed, 'when('.length - 1);
  return closing === trimmed.length - 1;
}

/** when(<式>) の内側を取り出す。when 形式以外の入力は呼び出し側の契約違反として即座に失敗させる。 */
export function unwrapWhenConditionExpression(value: string): string {
  const trimmed = value.trim();
  if (!isWhenConditionExpression(trimmed)) {
    throw new Error(`unwrapWhenConditionExpression requires a when(...) condition, got "${value}"`);
  }
  return trimmed.slice('when('.length, -1).trim();
}

export function isAggregateConditionExpression(value: string): boolean {
  return parseAggregateConditionExpression(value) !== undefined;
}
