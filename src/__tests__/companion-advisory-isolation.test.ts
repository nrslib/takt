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
    rules: [
      makeRule('Implementation is complete', 'COMPLETE'),
      makeRule('Implementation needs more work', 'retry'),
    ],
  });
}

function executor(judgeStatus: ReturnType<typeof vi.fn>): StepExecutor {
  return new StepExecutor({
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    optionsBuilder: {
      buildPhaseRunnerContext: vi.fn((_step, _state, lastResponse) => ({
        cwd: '/tmp',
        reportDir: '/tmp',
        workflowName: 'test-workflow',
        iteration: 1,
        lastResponse,
        structuredCaller: { judgeStatus },
        resolveStepProviderModel: () => ({ provider: 'mock' }),
      })),
    } as unknown as StepExecutorDeps['optionsBuilder'],
    getInteractive: () => false,
  } as unknown as StepExecutorDeps);
}

function judge(): ReturnType<typeof vi.fn> {
  return vi.fn(async (
    _structured: string,
    _tag: string,
    _candidates: readonly unknown[],
    options: { onStructuredPromptResolved: (parts: { systemPrompt: string; userInstruction: string }) => void },
  ) => {
    options.onStructuredPromptResolved({
      systemPrompt: 'system',
      userInstruction: 'judge',
    });
    return { candidateIndex: 0, method: 'phase3_tag' as const };
  });
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
    const judgeStatus = judge();

    const result = await executor(judgeStatus).applyPostExecutionPhases(
      companionStep(),
      state(companion),
      1,
      latestResponse,
      vi.fn(),
    );

    expect(result.status).toBe('done');
    expect(result.content).toBe(latestResponse.content);
    expect(result.matchedRuleIndex).toBe(0);
    expect(result.matchedRuleMethod).toBe('phase3_tag');
    expect(judgeStatus).toHaveBeenCalledOnce();
    expect(judgeStatus.mock.calls[0]?.[0]).toContain(latestResponse.content);
    expect(judgeStatus.mock.calls[0]?.[2]).toHaveLength(2);
  });

  it('should evaluate ordinary conditions when advisory state is unavailable', async () => {
    const judgeStatus = judge();
    const result = await executor(judgeStatus).applyPostExecutionRulesOnly(
      companionStep(),
      state(undefined),
      response(),
      vi.fn(),
    );

    expect(result.status).toBe('done');
    expect(result.matchedRuleIndex).toBe(0);
    expect(judgeStatus).toHaveBeenCalledOnce();
  });

  it('should reject a programmatic workflow rule that reads advisory state', async () => {
    const judgeStatus = judge();
    const step = companionStep();
    step.rules = [{
      condition: { kind: 'when', expression: 'companion.escalated' },
      next: 'ABORT',
    }, ...step.rules ?? []];

    await expect(executor(judgeStatus).applyPostExecutionRulesOnly(
      step,
      state({
        escalated: true,
        completionVerified: true,
        openMustFixCount: 0,
        openMustFix: [],
      }),
      response(),
      vi.fn(),
    )).rejects.toThrow('Workflow transition rules cannot reference advisory companion state');

    expect(judgeStatus).not.toHaveBeenCalled();
  });
});
