import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState } from '../core/models/index.js';
import { guardCompanionCompletion } from '../core/workflow/companion/completion-gate.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { makeStep } from './test-helpers.js';

function response(): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'implementation',
    timestamp: new Date('2026-08-11T00:00:00.000Z'),
  };
}

const openMustFix = [{
  id: 'ai-antipattern-review-companion-1',
  severity: 'must_fix' as const,
  file: 'src/implementation.ts',
  line: 1,
  finding: 'The implementation still contains a must-fix finding',
}];

function state(companion: WorkflowState['companion']): WorkflowState {
  return {
    workflowName: 'companion-completion-gate',
    currentStep: 'implement',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    resumedDynamicParallelSteps: new Set(),
    dynamicFacetSelections: new Map(),
    resumedDynamicFacetSteps: new Set(),
    status: 'running',
    companion,
  };
}

function companionStep() {
  return makeStep({
    name: 'implement',
    persona: 'coder',
    companion: { fixed: ['ai-antipattern-review-companion'], pool: [] },
    rules: [{ condition: 'Implementation is complete', next: 'COMPLETE' }],
  });
}

describe('companion completion gate', () => {
  it('should stop an escalated companion step before condition evaluation', async () => {
    const step = companionStep();
    const workflowState = state({
      escalated: true,
      openMustFixCount: 1,
      openMustFix,
      reason: 'completion review could not verify the final diff',
    });
    const buildPhaseRunnerContext = vi.fn();
    const executor = new StepExecutor({
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      optionsBuilder: { buildPhaseRunnerContext } as unknown as StepExecutorDeps['optionsBuilder'],
    } as unknown as StepExecutorDeps);

    const result = await executor.applyPostExecutionPhases(
      step,
      workflowState,
      1,
      response(),
      vi.fn(),
    );

    expect(result.status).toBe('blocked');
    expect(result.content).toBe('implementation');
    expect(buildPhaseRunnerContext).not.toHaveBeenCalled();
  });

  it('should fail closed when a resumed companion step has no completion state', async () => {
    const step = companionStep();
    const buildPhaseRunnerContext = vi.fn();
    const executor = new StepExecutor({
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      optionsBuilder: { buildPhaseRunnerContext } as unknown as StepExecutorDeps['optionsBuilder'],
    } as unknown as StepExecutorDeps);

    const result = await executor.applyPostExecutionRulesOnly(
      step,
      state(undefined),
      response(),
      vi.fn(),
    );

    expect(result.status).toBe('blocked');
    expect(buildPhaseRunnerContext).not.toHaveBeenCalled();
  });

  it('should stop a step with residual must-fix findings even when escalation is absent', () => {
    const step = companionStep();
    const result = guardCompanionCompletion(
      step,
      state({
        escalated: false,
        openMustFixCount: 1,
        openMustFix,
      }),
      response(),
    );

    expect(result.status).toBe('blocked');
  });

  it('should leave a clean companion response eligible for conditions', () => {
    const original = response();
    const result = guardCompanionCompletion(
      companionStep(),
      state({
        escalated: false,
        openMustFixCount: 0,
        openMustFix: [],
      }),
      original,
    );

    expect(result).toBe(original);
  });
});
