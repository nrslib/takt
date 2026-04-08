/**
 * Aggregate condition evaluator for parallel workflow steps
 *
 * Evaluates all()/any() aggregate conditions against sub-step results.
 */

import type { WorkflowStep, WorkflowState } from '../../models/types.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('aggregate-evaluator');

/**
 * Evaluates aggregate conditions (all()/any()) for parallel parent steps.
 *
 * For each aggregate rule, checks the matched condition text of sub-steps:
 * - all("X"): true when ALL sub-steps have matched condition === X
 * - all("A", "B"): true when 1st sub-step matches "A" AND 2nd sub-step matches "B" (order-based)
 * - any("X"): true when at least ONE sub-step has matched condition === X
 * - any("A", "B"): true when at least ONE sub-step matches "A" OR "B"
 *
 * Edge cases per spec:
 * - Sub-step with no matched rule: all() → false, any() → skip that sub-step
 * - No sub-steps (0 件): both → false
 * - Non-parallel step: both → false
 * - all("A", "B") with wrong number of sub-steps: false (logged as error)
 */
export class AggregateEvaluator {
  constructor(
    private readonly step: WorkflowStep,
    private readonly state: WorkflowState,
  ) {}

  /**
   * Evaluate aggregate conditions.
   * Returns the 0-based rule index in the step's rules array, or -1 if no match.
   */
  evaluate(): number {
    if (!this.step.rules || !this.step.parallel || this.step.parallel.length === 0) return -1;

    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (!rule.isAggregateCondition || !rule.aggregateType || !rule.aggregateConditionText) {
        continue;
      }

      const subSteps = this.step.parallel;
      const targetCondition = rule.aggregateConditionText;

      if (rule.aggregateType === 'all') {
        // Multiple conditions: order-based matching (1st sub-step matches 1st condition, etc.)
        if (Array.isArray(targetCondition)) {
          if (targetCondition.length !== subSteps.length) {
            log.error('all() condition count mismatch', {
              step: this.step.name,
              conditionCount: targetCondition.length,
              subStepCount: subSteps.length,
            });
            continue;
          }
          const allMatch = subSteps.every((sub, idx) => {
            const output = this.state.stepOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            const expectedCondition = targetCondition[idx];
            if (!expectedCondition) return false;
            return matchedRule?.condition === expectedCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched (multi-condition)', { step: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: all sub-steps must match the same condition
          const allMatch = subSteps.every((sub) => {
            const output = this.state.stepOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return matchedRule?.condition === targetCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched', { step: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      } else {
        // 'any'
        if (Array.isArray(targetCondition)) {
          // Multiple conditions: at least one sub-step matches at least one condition
          const anyMatch = subSteps.some((sub) => {
            const output = this.state.stepOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return targetCondition.includes(matchedRule?.condition ?? '');
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched (multi-condition)', { step: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: at least one sub-step matches the condition
          const anyMatch = subSteps.some((sub) => {
            const output = this.state.stepOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return matchedRule?.condition === targetCondition;
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched', { step: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      }
    }

    return -1;
  }
}
