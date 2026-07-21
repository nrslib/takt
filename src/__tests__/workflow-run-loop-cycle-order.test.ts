import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, LoopMonitorConfig, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';

const monitor: LoopMonitorConfig = {
  cycle: ['fix', 'reviewers'],
  threshold: 1,
  judge: { rules: [{ condition: 'stalled', next: 'ABORT' }] },
};

function makeDeps(nextStep: string) {
  const step = makeStep('reviewers', { rules: [makeRule('done', nextStep)] });
  const config: WorkflowConfig = {
    name: 'cycle-order',
    maxSteps: 2,
    initialStep: step.name,
    steps: [step],
  };
  const state: WorkflowState = createInitialState(config, { projectCwd: '/worktree' });
  const response: AgentResponse = makeResponse({ persona: step.name, status: 'done', content: 'done' });
  return {
    state,
    options: {},
    getWorkflowName: () => config.name,
    getCurrentWorkflowStack: () => undefined,
    getCwd: () => '/worktree',
    getMaxSteps: () => config.maxSteps,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: vi.fn(() => ({ triggered: true, cycleCount: 1, monitor })),
    resolveDoneTransition: vi.fn(() => ({ nextStep })),
    runLoopMonitorJudge: vi.fn(async () => 'ABORT'),
    runStep: vi.fn(async (_step: WorkflowStep, instruction: string) => ({ response, instruction })),
    runQualityGates: vi.fn(async () => ({ ok: true as const })),
    persistPreviousResponseSnapshot: vi.fn(),
    buildInstruction: vi.fn(() => 'instruction'),
    buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
    resolveStepProviderModel: vi.fn(() => ({ provider: undefined, model: undefined })),
    resolveStepProviderModelBeforeAutoRouting: vi.fn(() => ({ provider: undefined, model: undefined })),
    resolveRuntimeForStep: vi.fn(),
    setActiveStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
  };
}

describe('WorkflowRunLoop loop monitor ordering', () => {
  it('does not let a loop monitor override a natural COMPLETE transition', async () => {
    const deps = makeDeps('COMPLETE');

    const result = await runWorkflowToCompletion(deps);

    expect(result.state.status).toBe('completed');
    expect(deps.cycleDetectorRecordAndCheck).not.toHaveBeenCalled();
    expect(deps.runLoopMonitorJudge).not.toHaveBeenCalled();
  });

  it('does not let a loop monitor override a natural ABORT transition', async () => {
    const deps = makeDeps('ABORT');

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort?.kind).toBe('step_transition');
    expect(deps.cycleDetectorRecordAndCheck).not.toHaveBeenCalled();
    expect(deps.runLoopMonitorJudge).not.toHaveBeenCalled();
  });
});
