import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../core/models/index.js';
import {
  isCountableWorkflowStep,
  isDelegatedWorkflowStep,
  isProviderBackedWorkflowStep,
} from '../core/workflow/step-kind.js';

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'step',
    persona: 'agent',
    personaDisplayName: 'Agent',
    instruction: 'Run step',
    rules: [],
    ...overrides,
  };
}

describe('workflow step semantic classifications', () => {
  it.each([
    ['agent', makeStep(), true, false, true],
    ['arpeggio', makeStep({ arpeggio: {} as WorkflowStep['arpeggio'] }), true, true, true],
    ['parallel', makeStep({ parallel: [makeStep({ name: 'child' })] }), true, true, false],
    ['team leader', makeStep({ teamLeader: {} as WorkflowStep['teamLeader'] }), true, true, false],
    ['system', makeStep({ kind: 'system' }), true, true, false],
    ['workflow call', makeStep({ kind: 'workflow_call', call: './child.yaml' }), false, true, false],
  ])(
    'classifies %s independently',
    (_name, step, countable, delegated, providerBacked) => {
      expect(isCountableWorkflowStep(step)).toBe(countable);
      expect(isDelegatedWorkflowStep(step)).toBe(delegated);
      expect(isProviderBackedWorkflowStep(step)).toBe(providerBacked);
    },
  );
});
