import type { WorkflowState } from '../../models/types.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { isEscapedQuote, splitTopLevelClausesOrThrow } from '../../models/workflow-condition-expression.js';

export function splitTopLevel(expression: string, separator: '||' | '&&'): string[] {
  // トークナイズは models の唯一実装に委譲（parse/normalize と同一契約）。
  // 空節は黙殺しない: when(a && && b) は不正な式として即座に失敗させる
  // （不正オペランドを throw する評価器の既存の厳格性と同じ扱い）。
  return splitTopLevelClausesOrThrow(expression, separator, 'when expression');
}

function findOperator(expression: string): { operator: string; index: number } | undefined {
  const operators = ['>=', '<=', '!=', '==', '>', '<'] as const;
  let inString = false;

  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '"' && !isEscapedQuote(expression, index)) {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    for (const operator of operators) {
      if (expression.slice(index, index + operator.length) === operator) {
        return { operator, index };
      }
    }
  }

  return undefined;
}

function splitFunctionArgs(argsText: string, functionName: string): [string, string] {
  let inString = false;
  let depth = 0;
  let separatorIndex: number | undefined;

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
      if (depth < 0) {
        throw new Error(`Invalid ${functionName}() expression "${argsText}"`);
      }
      continue;
    }
    if (current === ',' && depth === 0) {
      if (separatorIndex !== undefined) {
        throw new Error(`${functionName}() requires exactly two arguments`);
      }
      separatorIndex = index;
    }
  }

  if (inString || depth !== 0 || separatorIndex === undefined) {
    throw new Error(`Invalid ${functionName}() expression "${argsText}"`);
  }
  const first = argsText.slice(0, separatorIndex).trim();
  const second = argsText.slice(separatorIndex + 1).trim();
  if (first.length === 0 || second.length === 0) {
    throw new Error(`${functionName}() requires exactly two arguments`);
  }
  return [first, second];
}

function resolveReference(reference: string, state: WorkflowState): unknown {
  return resolveWorkflowStateReference(reference, state);
}

function parseItemReference(reference: string, item: unknown): unknown {
  if (!reference.startsWith('item.')) {
    throw new Error(`Unsupported exists() operand "${reference}"`);
  }

  let current: unknown = item;
  for (const key of reference.slice('item.'.length).split('.')) {
    if (!key) {
      throw new Error(`Unsupported exists() operand "${reference}"`);
    }
    if (current == null || typeof current !== 'object' || !(key in current)) {
      throw new Error(`Unsupported exists() operand "${reference}"`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseLiteral(raw: string, state: WorkflowState, item?: unknown): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`Invalid string literal "${value}"`);
    }
  }
  if (
    value.startsWith('context.')
    || value.startsWith('structured.')
    || value.startsWith('effect.')
    || value.startsWith('findings.')
  ) {
    return resolveReference(value, state);
  }
  if (item !== undefined && value.startsWith('item.')) {
    return parseItemReference(value, item);
  }
  throw new Error(`Unsupported when operand "${value}"`);
}

function evaluateExistsPredicate(predicate: string, item: unknown, state: WorkflowState): boolean {
  return splitTopLevel(predicate, '&&').every((clause) => {
    const normalized = clause.trim();
    if (normalized.startsWith('contains(') && normalized.endsWith(')')) {
      return evaluateContainsClause(normalized, state, item);
    }
    const operatorMatch = findOperator(clause);
    if (operatorMatch?.operator !== '==') {
      throw new Error(`exists() only supports "==", "contains()", and "&&": "${predicate}"`);
    }

    const leftRaw = clause.slice(0, operatorMatch.index);
    const rightRaw = clause.slice(operatorMatch.index + operatorMatch.operator.length);
    if (leftRaw.trim().length === 0 || rightRaw.trim().length === 0) {
      throw new Error(`Invalid exists() clause "${clause}"`);
    }

    return parseLiteral(leftRaw, state, item) === parseLiteral(rightRaw, state, item);
  });
}

function evaluateExistsClause(clause: string, state: WorkflowState): boolean {
  const match = clause.match(/^exists\((.*)\)$/);
  if (!match?.[1]) {
    throw new Error(`Invalid exists() clause "${clause}"`);
  }

  const [listExpression, predicate] = splitFunctionArgs(match[1], 'exists');
  const list = parseLiteral(listExpression, state);
  if (!Array.isArray(list)) {
    throw new Error(`exists() requires an array expression: "${listExpression}"`);
  }

  return list.some((item) => evaluateExistsPredicate(predicate, item, state));
}

function evaluateContainsClause(clause: string, state: WorkflowState, item?: unknown): boolean {
  const match = clause.match(/^contains\((.*)\)$/);
  if (!match?.[1]) {
    throw new Error(`Invalid contains() clause "${clause}"`);
  }

  const [listExpression, valueExpression] = splitFunctionArgs(match[1], 'contains');
  const list = parseLiteral(listExpression, state, item);
  if (!Array.isArray(list)) {
    throw new Error(`contains() requires an array expression: "${listExpression}"`);
  }
  const value = parseLiteral(valueExpression, state, item);
  return list.some((candidate) => candidate === value);
}

function evaluateClause(clause: string, state: WorkflowState): boolean {
  const normalized = clause.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized.startsWith('exists(') && normalized.endsWith(')')) {
    return evaluateExistsClause(normalized, state);
  }
  if (normalized.startsWith('contains(') && normalized.endsWith(')')) {
    return evaluateContainsClause(normalized, state);
  }

  const operatorMatch = findOperator(normalized);
  if (!operatorMatch) {
    const value = parseLiteral(normalized, state);
    if (typeof value !== 'boolean') {
      throw new Error(`Bare when clause must resolve to boolean: "${normalized}"`);
    }
    return value;
  }
  const { operator } = operatorMatch;

  const leftRaw = normalized.slice(0, operatorMatch.index);
  const rightRaw = normalized.slice(operatorMatch.index + operator.length);
  if (leftRaw.trim().length === 0 || rightRaw.trim().length === 0) {
    throw new Error(`Invalid when clause "${normalized}"`);
  }
  const left = parseLiteral(leftRaw, state);
  const right = parseLiteral(rightRaw, state);
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new Error(`Operator "${operator}" requires numeric operands: "${normalized}"`);
  }
  if (operator === '>') return left > right;
  if (operator === '<') return left < right;
  if (operator === '>=') return left >= right;
  return left <= right;
}

export function evaluateWhenExpression(expression: string, state: WorkflowState): boolean {
  return splitTopLevel(expression, '||').some((orPart) =>
    splitTopLevel(orPart, '&&').every((andPart) => evaluateClause(andPart, state)),
  );
}
