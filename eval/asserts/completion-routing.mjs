import { detectCandidateIndex } from '../../dist/shared/utils/ruleIndex.js';
import { parseWorkflowRuleCondition, semanticRuleCandidatesOf } from '../../dist/core/models/workflow-rule-condition.js';
import { loadCompletionRoutingStep } from '../completion-routing-prompt.mjs';

function scoreCandidateTransition(index, step, expected) {
  const rules = step.rules.map(rule => ({
    ...rule, condition: parseWorkflowRuleCondition(rule.condition), interactiveOnly: rule.interactive_only,
  }));
  if (rules.some(rule => rule.condition.kind !== 'semantic')) {
    throw new Error('Routing evaluation requires semantic-only rules');
  }
  const candidates = semanticRuleCandidatesOf(rules, false);
  if (index < 0) return { pass: false, reason: 'invalid_tag', transition: null };
  const label = candidates[index]?.label;
  const rule = rules.find(rule => !rule.interactiveOnly && rule.condition.label === label);
  if (!rule) return { pass: false, reason: 'unknown_rule', transition: null };
  const transition = rule.return !== undefined ? { return: rule.return } : { next: rule.next };
  if (rule.requires_user_input) transition.requires_user_input = true;
  const pass = JSON.stringify(transition) === JSON.stringify(expected);
  return { pass, reason: pass ? 'expected_transition' : 'wrong_transition', transition };
}

export function scoreTransition(output, step, expected) {
  return scoreCandidateTransition(detectCandidateIndex(output, step.name), step, expected);
}

function scoreStructuredTransition(output, step, expected) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return { pass: false, reason: 'invalid_json', transition: null };
  }
  if (!result || !Number.isInteger(result.step) || result.step < 1
    || typeof result.reason !== 'string' || !result.reason.trim()) {
    return { pass: false, reason: 'invalid_decision', transition: null };
  }
  return scoreCandidateTransition(result.step - 1, step, expected);
}

export default function assertCompletionRouting(output, context) {
  const step = loadCompletionRoutingStep(context.vars);
  const score = context.vars.judgment_mode === 'structured' ? scoreStructuredTransition : scoreTransition;
  const result = score(output, step, context.vars.expected_transition);
  return { ...result, score: result.pass ? 1 : 0 };
}
