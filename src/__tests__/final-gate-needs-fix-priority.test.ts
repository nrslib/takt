import { describe, expect, it } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { resolvePhase3Adoption } from '../core/workflow/evaluation/rule-utils.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

function stateWithProvisionalFinding(): WorkflowState {
  return {
    findings: {
      open: {
        count: 1,
        bySeverity: { critical: 0, high: 0, medium: 1, low: 0 },
        items: [{
          id: 'F-0001',
          severity: 'medium',
          title: 'Provisional review finding',
          reviewers: ['reviewer'],
        }],
      },
      resolved: { count: 0 },
      waived: { count: 0 },
      provisional: {
        count: 1,
        fixpoint: false,
        items: [{ id: 'F-0001', kind: 'unverified-location', reason: 'Location requires verification' }],
      },
      rounds: { budgetExhausted: false },
      invalidated: { count: 0 },
      superseded: { count: 0 },
      reviewerAnomalies: { count: 0, budgetExhausted: false },
      conflicts: { count: 0, items: [], unadjudicated: { count: 0 } },
    },
  } as unknown as WorkflowState;
}

describe('finding contract final gate needs_fix priority', () => {
  it('preserves the AI needs_fix decision when a later provisional rule also matches', () => {
    const rules = [
      normalizeRule({
        condition: 'needs_fix && when(findings.conflicts.count == 0)',
        return: 'needs_fix',
      }),
      normalizeRule({
        condition: 'when(findings.provisional.count > 0 && findings.conflicts.count == 0)',
        return: 'need_replan',
      }),
    ];

    const adoption = resolvePhase3Adoption(
      rules,
      { ruleIndex: 0, method: 'structured_output' },
      stateWithProvisionalFinding(),
      false,
      evaluateWhenExpression,
    );

    expect(adoption.blocked).toBe(false);
    expect(rules[adoption.result.ruleIndex]?.returnValue).toBe('needs_fix');
  });
});
