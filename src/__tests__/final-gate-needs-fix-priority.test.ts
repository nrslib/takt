import { describe, expect, it } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { makeRule, makeStep } from './test-helpers.js';

function stateWithProvisionalFinding(): WorkflowState {
  return {
    workflowName: 'finding-workflow', currentStep: 'final-gate', iteration: 1, status: 'running',
    stepOutputs: new Map(), stepIterations: new Map(), personaSessions: new Map(), userInputs: [],
    findings: {
      open: { count: 1, bySeverity: { medium: 1 }, items: [] }, resolved: { count: 0 }, waived: { count: 0 },
      invalidated: { count: 0 }, superseded: { count: 0 }, provisional: { count: 1, fixpoint: false, items: [] },
      rounds: { budgetExhausted: false },
      reviewerAnomalies: { count: 0, outstanding: 0, acknowledged: 0, budgetExhausted: false },
      conflicts: { count: 0, items: [], unadjudicated: { count: 0 } },
    },
  } as WorkflowState;
}

describe('finding contract final gate priority', () => {
  it('routes provisional findings before the selected needs_fix rule', () => {
    const step = makeStep({
      rules: [
        makeRule('when(findings.provisional.count > 0)', 'replan'),
        makeRule('needs_fix && when(findings.conflicts.count == 0)', 'fix'),
      ],
    });

    expect(new RuleEvaluator(step, { state: stateWithProvisionalFinding() })
      .evaluate({ label: 'needs_fix', method: 'structured_output' }))
      .toEqual({ index: 0, method: 'auto_select' });
  });
});
