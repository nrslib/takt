import type { WorkflowState } from '../../models/types.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';

function splitTopLevel(expression: string, separator: '||' | '&&'): string[] {
  const parts: string[] = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < expression.length - 1; index++) {
    const current = expression[index];
    if (current === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && expression.slice(index, index + 2) === separator) {
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

function resolveReference(reference: string, state: WorkflowState): unknown {
  return resolveWorkflowStateReference(reference, state);
}

function parseLiteral(raw: string, state: WorkflowState): unknown {
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
  throw new Error(`Unsupported when operand "${value}"`);
}

function evaluateClause(clause: string, state: WorkflowState): boolean {
  const normalized = clause.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

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
