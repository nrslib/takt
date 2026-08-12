import { describe, expect, it } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { makeRule, makeStep } from './test-helpers.js';

function stateWithUnmetRequirement(): WorkflowState {
  return {
    workflowName: 'requirement-workflow', currentStep: 'final-gate', iteration: 1, status: 'running',
    stepOutputs: new Map(), stepIterations: new Map(), personaSessions: new Map(), userInputs: [],
    structuredOutputs: new Map(),
    systemContexts: new Map([['requirements', { unmetCount: 1 }]]),
    effectResults: new Map(),
  };
}

describe('final gate needs-fix priority', () => {
  it('routes unmet requirements before the selected needs_fix rule', () => {
    const step = makeStep({
      rules: [
        makeRule('when(context.requirements.unmetCount > 0)', 'replan'),
        makeRule('needs_fix', 'fix'),
      ],
    });

    expect(new RuleEvaluator(step, { state: stateWithUnmetRequirement() })
      .evaluate({ label: 'needs_fix', method: 'structured_output' }))
      .toEqual({ index: 0, method: 'auto_select' });
  });
});
