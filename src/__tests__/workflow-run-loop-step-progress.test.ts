import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';

function makeConfig(steps: WorkflowStep[], initialStep: string): WorkflowConfig {
  return {
    name: 'progress-workflow',
    description: 'Progress workflow',
    maxSteps: 5,
    initialStep,
    steps,
  };
}

describe('WorkflowRunLoop step progress events', () => {
  it('should emit workflow-local progress info when step starts', async () => {
    const planStep = makeStep('plan');
    const reviewStep = makeStep('review', {
      rules: [makeRule('Review complete', 'COMPLETE')],
    });
    const summarizeStep = makeStep('summarize');
    const config = makeConfig([planStep, reviewStep, summarizeStep], reviewStep.name);
    const state = createInitialState(config, { projectCwd: '/worktree' });
    const response = makeResponse({
      persona: 'review',
      status: 'done',
      content: 'done',
    });
    const providerInfo = { provider: undefined, model: undefined };
    const progressInfo = {
      workflowName: 'forwarded-progress-workflow',
      stepIndex: 7,
      totalSteps: 9,
    };
    const getStepProgress = vi.fn(() => progressInfo);
    const deps = {
      state,
      options: {},
      getWorkflowName: () => config.name,
      getCurrentWorkflowStack: () => undefined,
      getCwd: () => '/worktree',
      getMaxSteps: () => 5,
      getReportDir: () => '/worktree/.takt/runs/test/reports',
      abortRequested: () => false,
      getStep: (name: string) => {
        const step = config.steps.find((candidate) => candidate.name === name);
        if (!step) {
          throw new Error(`Unknown step: ${name}`);
        }
        return step;
      },
      getStepProgress,
      applyRuntimeEnvironment: vi.fn(),
      loopDetectorCheck: () => ({ count: 1, isLoop: false }),
      cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
      resolveDoneTransition: vi.fn(() => ({ nextStep: 'COMPLETE' })),
      runLoopMonitorJudge: vi.fn(),
      runStep: vi.fn(async (_step: WorkflowStep, instruction: string) => ({ response, instruction })),
      runQualityGates: vi.fn(async () => ({ ok: true as const })),
      persistPreviousResponseSnapshot: vi.fn(),
      buildInstruction: vi.fn((_step: WorkflowStep, stepIteration: number) => `instruction ${stepIteration}`),
      buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
      resolveStepProviderModel: vi.fn(() => providerInfo),
      resolveRuntimeForStep: vi.fn(),
      setActiveStep: vi.fn(),
      addUserInput: vi.fn(),
      emit: vi.fn(),
      updateMaxSteps: vi.fn(),
    };

    await runWorkflowToCompletion(deps);

    expect(getStepProgress).toHaveBeenCalledWith(reviewStep);
    expect(deps.emit).toHaveBeenCalledWith(
      'step:start',
      reviewStep,
      1,
      'instruction 1',
      providerInfo,
      progressInfo,
    );
  });
});
