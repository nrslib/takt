import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';

function makeConfig(step: WorkflowStep): WorkflowConfig {
  return {
    name: 'failure-metadata-workflow',
    description: 'Failure metadata workflow',
    maxSteps: 5,
    initialStep: step.name,
    steps: [step],
  };
}

function makeStepErrorResponse(content: string, error: string): AgentResponse {
  return makeResponse({
    persona: 'implement',
    status: 'error',
    content,
    error,
  });
}

function makeDeps(
  state: WorkflowState,
  step: WorkflowStep,
  response: AgentResponse,
) {
  return {
    state,
    options: {},
    getWorkflowName: () => 'failure-metadata-workflow',
    getCurrentWorkflowStack: () => undefined,
    getCwd: () => '/worktree',
    getMaxSteps: () => 5,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    resolveDoneTransition: vi.fn(() => ({ nextStep: 'COMPLETE' })),
    runLoopMonitorJudge: vi.fn(),
    runStep: vi.fn(async (_step: WorkflowStep, instruction: string) => ({ response, instruction })),
    runQualityGates: vi.fn(async () => ({ ok: true as const })),
    buildInstruction: vi.fn((_step: WorkflowStep, stepIteration: number) => `instruction ${stepIteration}`),
    buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
    resolveStepProviderModel: vi.fn(() => ({
      provider: undefined,
      model: undefined,
    })),
    resolveRuntimeForStep: vi.fn(),
    setActiveStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    persistPreviousResponseSnapshot: vi.fn(),
  };
}

describe('WorkflowRunLoop failure metadata', () => {
  it('Given a step error, When the workflow aborts, Then the abort result includes step-level failure summary', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeStepErrorResponse('partial output', 'provider exploded');
    const deps = makeDeps(state, step, response);

    const result = await runWorkflowToCompletion(deps);

    expect(result.state.status).toBe('aborted');
    expect(result.abort).toEqual({
      kind: 'step_error',
      reason: 'Step "implement" failed: provider exploded',
      failure: {
        kind: 'step_error',
        step: 'implement',
        reason: 'Step "implement" failed: provider exploded',
      },
    });
    expect(deps.emit).toHaveBeenCalledWith(
      'workflow:abort',
      result.state,
      'Step "implement" failed: provider exploded',
    );
  });

  it('Given a pre-step runtime error, When full workflow execution prepares the step, Then it preserves the thrown error contract', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({
      persona: 'implement',
      status: 'done',
      content: 'done',
    });
    const deps = makeDeps(state, step, response);
    vi.mocked(deps.applyRuntimeEnvironment).mockImplementation(() => {
      throw new Error('prepare failed');
    });

    await expect(runWorkflowToCompletion(deps)).rejects.toThrow('prepare failed');

    expect(state.status).toBe('running');
    expect(deps.emit).not.toHaveBeenCalledWith(
      'workflow:abort',
      expect.anything(),
      expect.anything(),
    );
    expect(deps.emit).not.toHaveBeenCalledWith(
      'step:start',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('Given a step error in single iteration, When the workflow aborts, Then the result includes step-level failure summary', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeStepErrorResponse('partial output', 'provider exploded');
    const deps = makeDeps(state, step, response);

    const result = await runSingleWorkflowIteration(deps);

    expect(result.nextStep).toBe('ABORT');
    expect(result.isComplete).toBe(true);
    expect(state.status).toBe('aborted');
    expect(result.abort).toEqual({
      kind: 'step_error',
      reason: 'Step "implement" failed: provider exploded',
      failure: {
        kind: 'step_error',
        step: 'implement',
        reason: 'Step "implement" failed: provider exploded',
      },
    });
    expect(deps.emit).toHaveBeenCalledWith(
      'workflow:abort',
      state,
      'Step "implement" failed: provider exploded',
    );
  });

  it('Given a runtime error in single iteration, When the step throws, Then it preserves the thrown error contract', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({
      persona: 'implement',
      status: 'done',
      content: 'done',
    });
    const deps = makeDeps(state, step, response);
    vi.mocked(deps.runStep).mockRejectedValue(new Error('agent crashed'));

    await expect(runSingleWorkflowIteration(deps)).rejects.toThrow('agent crashed');

    expect(state.status).toBe('running');
    expect(deps.emit).not.toHaveBeenCalledWith(
      'workflow:abort',
      expect.anything(),
      expect.anything(),
    );
  });
});
