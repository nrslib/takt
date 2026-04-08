/**
 * Rule evaluation - barrel exports
 */

import type { WorkflowStep, WorkflowState } from '../../models/types.js';
import { RuleEvaluator } from './RuleEvaluator.js';
import { AggregateEvaluator } from './AggregateEvaluator.js';

export { RuleEvaluator, type RuleMatch, type RuleEvaluatorContext } from './RuleEvaluator.js';
export { AggregateEvaluator } from './AggregateEvaluator.js';

// ---- Function facades for consumers that prefer the function API ----

import type { RuleMatch, RuleEvaluatorContext } from './RuleEvaluator.js';

/**
 * Detect matched rule for a step response.
 * Function facade over RuleEvaluator class.
 */
export async function detectMatchedRule(
  step: WorkflowStep,
  agentContent: string,
  tagContent: string,
  ctx: RuleEvaluatorContext,
): Promise<RuleMatch | undefined> {
  return new RuleEvaluator(step, ctx).evaluate(agentContent, tagContent);
}

/**
 * Evaluate aggregate conditions.
 * Function facade over AggregateEvaluator class.
 */
export function evaluateAggregateConditions(step: WorkflowStep, state: WorkflowState): number {
  return new AggregateEvaluator(step, state).evaluate();
}
