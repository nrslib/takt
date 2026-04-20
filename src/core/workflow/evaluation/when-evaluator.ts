import type { WorkflowState } from '../../models/types.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';

function splitTopLevel(expression: string, separator: '||' | '&&'): string[] {
  const parts: string[] = [];
  let inString = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length - 1; index++) {
    const current = expression[index];
    if (current === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && current === '(') {
      depth++;
      continue;
    }
    if (!inString && current === ')') {
      depth--;
      continue;
    }
    if (!inString && depth === 0 && expression.slice(index, index + 2) === separator) {
      parts.push(expression.slice(start, index).trim());
      start = index + 2;
      index++;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function findOperator(expression: string): string | undefined {
  const operators = ['>=', '<=', '!=', '==', '>', '<'] as const;
  let inString = false;

  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    for (const operator of operators) {
      if (expression.slice(index, index + operator.length) === operator) {
        return operator;
      }
    }
  }

  return undefined;
}

function splitFunctionArgs(argsText: string): [string, string] {
  let inString = false;
  let depth = 0;

  for (let index = 0; index < argsText.length; index++) {
    const current = argsText[index];
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
      continue;
    }
    if (current === ',' && depth === 0) {
      return [
        argsText.slice(0, index).trim(),
        argsText.slice(index + 1).trim(),
      ];
    }
  }

  throw new Error(`Invalid exists() expression "${argsText}"`);
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
    return value.slice(1, -1);
  }
  if (value.startsWith('context.') || value.startsWith('structured.') || value.startsWith('effect.')) {
    return resolveReference(value, state);
  }
  if (item !== undefined && value.startsWith('item.')) {
    return parseItemReference(value, item);
  }
  throw new Error(`Unsupported when operand "${value}"`);
}

function evaluateExistsPredicate(predicate: string, item: unknown, state: WorkflowState): boolean {
  return splitTopLevel(predicate, '&&').every((clause) => {
    const operator = findOperator(clause);
    if (operator !== '==') {
      throw new Error(`exists() only supports "==" and "&&": "${predicate}"`);
    }

    const operatorIndex = clause.indexOf(operator);
    const leftRaw = clause.slice(0, operatorIndex);
    const rightRaw = clause.slice(operatorIndex + operator.length);
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

  const [listExpression, predicate] = splitFunctionArgs(match[1]);
  const list = parseLiteral(listExpression, state);
  if (!Array.isArray(list)) {
    throw new Error(`exists() requires an array expression: "${listExpression}"`);
  }

  return list.some((item) => evaluateExistsPredicate(predicate, item, state));
}

function evaluateClause(clause: string, state: WorkflowState): boolean {
  const normalized = clause.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized.startsWith('exists(') && normalized.endsWith(')')) {
    return evaluateExistsClause(normalized, state);
  }

  const operator = findOperator(normalized);
  if (!operator) {
    const value = parseLiteral(normalized, state);
    if (typeof value !== 'boolean') {
      throw new Error(`Bare when clause must resolve to boolean: "${normalized}"`);
    }
    return value;
  }

  const operatorIndex = normalized.indexOf(operator);
  const leftRaw = normalized.slice(0, operatorIndex);
  const rightRaw = normalized.slice(operatorIndex + operator.length);
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
