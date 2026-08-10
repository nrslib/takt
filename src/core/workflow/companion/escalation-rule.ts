import { parseWhenConditionExpression } from '../../models/workflow-when-expression.js';
import {
  isWhenConditionExpression,
  unwrapWhenConditionExpression,
} from '../../models/workflow-condition-expression.js';

/**
 * Returns whether a normalized `when` expression catches companion
 * escalation. The input is the expression inside `when(...)`, as used by the
 * normalized workflow validator.
 */
export function guaranteesCompanionEscalationCatch(expression: string): boolean {
  const parsed = parseWhenConditionExpression(expression);
  if (parsed.alternatives.length !== 1 || parsed.alternatives[0]?.length !== 1) return false;
  const clause = parsed.alternatives[0][0];
  if (clause?.kind === 'operand') {
    return clause.operand.reference === 'companion.escalated';
  }
  if (clause?.kind !== 'comparison' || clause.operator !== '==') return false;
  return (
    clause.left.kind === 'state'
    && clause.left.reference === 'companion.escalated'
    && clause.right.kind === 'literal'
    && clause.right.value === true
  ) || (
    clause.right.kind === 'state'
    && clause.right.reference === 'companion.escalated'
    && clause.left.kind === 'literal'
    && clause.left.value === true
  );
}

/**
 * Returns whether a raw rule condition is the optional companion escalation
 * route. Raw semantic labels must not be interpreted as `when` expressions.
 */
export function guaranteesCompanionEscalationRawCondition(condition: string): boolean {
  if (!isWhenConditionExpression(condition)) return false;
  return guaranteesCompanionEscalationCatch(unwrapWhenConditionExpression(condition));
}
