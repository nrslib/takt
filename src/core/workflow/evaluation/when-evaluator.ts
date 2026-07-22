import type { WorkflowState } from '../../models/types.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import {
  parseWhenConditionExpression,
  type WhenClauseExpression,
  type WhenComparisonOperator,
  type WhenOperandExpression,
} from '../../models/workflow-when-expression.js';

function parseItemReference(reference: string, item: unknown): unknown {
  if (!reference.startsWith('item.')) {
    throw new Error(`Unsupported exists() operand "${reference}"`);
  }

  let current: unknown = item;
  for (const key of reference.slice('item.'.length).split('.')) {
    if (!key) {
      throw new Error(`Unsupported exists() operand "${reference}"`);
    }
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      throw new Error(`Unsupported exists() operand "${reference}"`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function formatOperand(operand: WhenOperandExpression): string {
  return operand.kind === 'literal' ? operand.raw : operand.reference;
}

function resolveOperand(
  operand: WhenOperandExpression,
  state: WorkflowState,
  itemContext?: { item: unknown },
): unknown {
  if (operand.kind === 'literal') return operand.value;
  if (operand.kind === 'state') {
    return resolveWorkflowStateReference(operand.reference, state);
  }
  if (itemContext === undefined) {
    throw new Error(`Unsupported exists() operand "${operand.reference}"`);
  }
  return parseItemReference(operand.reference, itemContext.item);
}

function evaluateExistsClause(
  clause: Extract<WhenClauseExpression, { kind: 'exists' }>,
  state: WorkflowState,
): boolean {
  const list = resolveOperand(clause.listExpression, state);
  if (!Array.isArray(list)) {
    throw new Error(
      `exists() requires an array expression: "${formatOperand(clause.listExpression)}"`,
    );
  }
  return list.some((item) => clause.predicate.every((predicate) =>
    resolveOperand(predicate.left, state, { item })
      === resolveOperand(predicate.right, state, { item }),
  ));
}

function compareWhenOperands(
  operator: WhenComparisonOperator,
  left: unknown,
  right: unknown,
  clause: Extract<WhenClauseExpression, { kind: 'comparison' }>,
): boolean {
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new Error(
      `Operator "${operator}" requires numeric operands: "${formatOperand(clause.left)} ${operator} ${formatOperand(clause.right)}"`,
    );
  }
  if (operator === '>') return left > right;
  if (operator === '<') return left < right;
  if (operator === '>=') return left >= right;
  return left <= right;
}

function evaluateClause(clause: WhenClauseExpression, state: WorkflowState): boolean {
  switch (clause.kind) {
    case 'boolean': return clause.value;
    case 'exists': return evaluateExistsClause(clause, state);
    case 'operand': {
      const value = resolveOperand(clause.operand, state);
      if (typeof value !== 'boolean') {
        throw new Error(
          `Bare when clause must resolve to boolean: "${formatOperand(clause.operand)}"`,
        );
      }
      return value;
    }
    case 'comparison': return compareWhenOperands(
      clause.operator,
      resolveOperand(clause.left, state),
      resolveOperand(clause.right, state),
      clause,
    );
  }
}

export function evaluateWhenExpression(expression: string, state: WorkflowState): boolean {
  return parseWhenConditionExpression(expression).alternatives.some((alternative) =>
    alternative.every((clause) => evaluateClause(clause, state)),
  );
}
