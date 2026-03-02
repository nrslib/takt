/**
 * Rule evaluation - barrel exports
 */

import type { PieceMovement, PieceState } from '../../models/types.js';
import { RuleEvaluator } from './RuleEvaluator.js';
import { AggregateEvaluator } from './AggregateEvaluator.js';

export { RuleEvaluator, type RuleMatch, type RuleEvaluatorContext } from './RuleEvaluator.js';
export { AggregateEvaluator } from './AggregateEvaluator.js';

// ---- Function facades for consumers that prefer the function API ----

import type { RuleMatch, RuleEvaluatorContext } from './RuleEvaluator.js';

/**
 * Detect matched rule for a movement's response.
 * Function facade over RuleEvaluator class.
 */
export async function detectMatchedRule(
  step: PieceMovement,
  agentContent: string,
  tagContent: string,
  ctx: RuleEvaluatorContext,
  agentError?: string,
): Promise<RuleMatch | undefined> {
  return new RuleEvaluator(step, ctx).evaluate(agentContent, tagContent, agentError);
}

/**
 * Evaluate aggregate conditions.
 * Function facade over AggregateEvaluator class.
 */
export function evaluateAggregateConditions(step: PieceMovement, state: PieceState): number {
  return new AggregateEvaluator(step, state).evaluate();
}
