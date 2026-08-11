import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState } from '../core/models/index.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { makeRule, makeStep } from './test-helpers.js';

function response(): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'latest implementation response',
    timestamp: new Date('2026-08-11T00:00:00.000Z'),
  };
}

function state(companion: WorkflowState['companion']): WorkflowState {
  return {
    workflowName: 'companion-advisory-isolation',
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
    dynamicFacetSelections: new Map(),
    status: 'running',
    companion,
  };
}

function companionStep() {
  return makeStep({
    name: 'implement',
    persona: 'coder',
    companion: { fixed: ['ai-antipattern-review-companion'], pool: [] },
    rules: [makeRule('Implementation is complete', 'COMPLETE')],
  });
}

function executor(): StepExecutor {
  return new StepExecutor({
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    optionsBuilder: { buildPhaseRunnerContext: vi.fn() } as unknown as StepExecutorDeps['optionsBuilder'],
    getInteractive: () => false,
  } as unknown as StepExecutorDeps);
}

describe('companion advisory isolation', () => {
  it.each([
    {
      label: 'unresolved must_fix',
      companion: {
        escalated: false,
        completionVerified: true,
        openMustFixCount: 1,
        openMustFix: [{
          id: 'ai-antipattern-review-companion-1',
          severity: 'must_fix' as const,
          file: 'src/implementation.ts',
          line: 1,
          finding: 'The implementation still contains a must-fix finding',
        }],
      },
    },
    {
      label: 'completion failure',
      companion: {
        escalated: true,
        completionVerified: false,
        completionFailure: true,
        openMustFixCount: 1,
        openMustFix: [],
        reason: 'completion review could not verify the final diff',
      },
    },
    {
      label: 'internal escalation',
      companion: {
        escalated: true,
        completionVerified: true,
        openMustFixCount: 1,
        openMustFix: [],
        reason: 'the same finding repeated without a diff change',
      },
    },
  ])('should evaluate ordinary conditions after $label', async ({ companion }) => {
    const latestResponse = response();

    const result = await executor().applyPostExecutionPhases(
      companionStep(),
      state(companion),
      1,
      latestResponse,
      vi.fn(),
    );

    expect(result.status).toBe('done');
    expect(result.content).toBe(latestResponse.content);
    expect(result.matchedRuleIndex).toBe(0);
  });

  it('should evaluate ordinary conditions when advisory state is unavailable', async () => {
    const result = await executor().applyPostExecutionRulesOnly(
      companionStep(),
      state(undefined),
      response(),
      vi.fn(),
    );

    expect(result.status).toBe('done');
    expect(result.matchedRuleIndex).toBe(0);
  });
});
