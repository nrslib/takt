import type { WorkflowStep } from '../../models/types.js';
import {
  needsSemanticStatusJudgment,
  semanticLabelsOf,
  semanticRuleCandidatesOf,
} from '../../models/workflow-rule-condition.js';
import {
  RuleDetectionExhaustedError,
  RuleEvaluator,
  type RuleEvaluatorContext,
  type RuleMatch,
} from '../evaluation/index.js';
import {
  runStatusJudgmentPhase,
  type StatusJudgmentPhaseContext,
} from '../phase-runner.js';

export async function evaluatePostExecutionRules(
  step: WorkflowStep,
  getStatusJudgmentContext: () => StatusJudgmentPhaseContext,
  ruleContext: RuleEvaluatorContext,
): Promise<RuleMatch | undefined> {
  const firstSemanticRuleIndex = step.rules?.findIndex(
    (rule) => rule.interactiveOnly !== true || ruleContext.interactive === true
      ? semanticLabelsOf(rule.condition).length > 0
      : false,
  ) ?? -1;

  if (firstSemanticRuleIndex < 0) {
    return new RuleEvaluator(step, ruleContext).evaluate(undefined);
  }

  const precedingRules = step.rules?.slice(0, firstSemanticRuleIndex) ?? [];
  if (precedingRules.length > 0) {
    try {
      return new RuleEvaluator({ ...step, rules: precedingRules }, ruleContext).evaluate(undefined);
    } catch (error) {
      if (!(error instanceof RuleDetectionExhaustedError)) {
        throw error;
      }
    }
  }

  const semanticCandidates = semanticRuleCandidatesOf(
    step.rules ?? [],
    ruleContext.interactive === true,
  );
  const selection = needsSemanticStatusJudgment(step.rules ?? [], ruleContext.interactive === true)
    ? await runStatusJudgmentPhase(step, getStatusJudgmentContext())
    : { label: semanticCandidates[0]!.label, method: 'auto_select' as const };
  return new RuleEvaluator(step, ruleContext).evaluate(selection);
}
