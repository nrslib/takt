import assertPhase3Judgment from './phase3-judgment.mjs';
import { loadPhase3JudgmentRules } from '../phase3-judgment-prompt.mjs';

export default function assertWriteTestsRouting(output, context) {
  const { candidates } = loadPhase3JudgmentRules(context.vars);
  const expectedIndex = context.vars.expected_rule_index;
  if (!Number.isInteger(expectedIndex) || expectedIndex < 1 || expectedIndex > candidates.length) {
    throw new Error('expected_rule_index must identify a selectable rule');
  }
  return assertPhase3Judgment(output, {
    ...context,
    vars: { ...context.vars, expected_label: candidates[expectedIndex - 1].label },
  });
}
