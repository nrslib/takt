import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { WorkflowStepBudget } from '../core/workflow/workflow-step-budget.js';
import { snapshotWorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';
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
  const stack = [{ workflow: 'failure-metadata-workflow', step: step.name, kind: 'agent' as const }];
  return {
    state,
    options: {},
    getWorkflowName: () => 'failure-metadata-workflow',
    getTask: () => 'test task',
    getRoutingFindings: () => ({ open: [], conflicts: [] }),
    getCurrentWorkflowStack: () => stack,
    buildStepExecutionScope: () => snapshotWorkflowExecutionScope(stack),
    getCwd: () => '/worktree',
    stepBudget: new WorkflowStepBudget(5),
    recordCountableProgress: vi.fn(),
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    resolveDoneTransition: vi.fn(() => ({ nextStep: 'COMPLETE' })),
    runLoopMonitorJudge: vi.fn(),
    getPendingLoopJudge: () => undefined,
    runStep: vi.fn(async (_step: WorkflowStep, plan: { kind: string; preparedExecution?: { phase1Instruction: string } }) => ({
      response,
      instruction: plan.preparedExecution?.phase1Instruction ?? '',
    })),
    runQualityGates: vi.fn(async () => ({ ok: true as const })),
    prepareNormalStepExecution: vi.fn((_step: WorkflowStep, stepIteration: number) => ({
      executableStep: step as AgentWorkflowStep,
      phase1Instruction: `instruction ${stepIteration}`,
      stepIteration,
      rollbackPreparation: vi.fn(),
    })),
    resolveStepProviderModel: vi.fn(() => ({
      provider: 'mock' as const,
      model: undefined,
    })),
    resolveStepProviderModelBeforeAutoRouting: vi.fn(() => ({
      provider: 'mock' as const,
      model: undefined,
    })),
    setActiveStep: vi.fn(),
    syncMaxSteps: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    persistPreviousResponseSnapshot: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
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
      'step_error',
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

  it('Given provider resolution fails in a child workflow, When full execution prepares the step, Then it does not consume shared iteration budgets', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({
      persona: 'implement',
      status: 'done',
      content: 'done',
    });
    state.iteration = 2;
    const deps = {
      ...makeDeps(state, step, response),
      getCurrentWorkflowStack: () => [
        {
          workflow: 'parent',
          step: 'delegate',
          kind: 'workflow_call' as const,
          call_instance: 1,
        },
        {
          workflow: 'child',
          step: 'implement',
          kind: 'agent' as const,
        },
      ],
    };
    vi.mocked(deps.resolveStepProviderModel).mockReturnValue({
      provider: undefined,
      model: undefined,
    });

    await expect(runWorkflowToCompletion(deps)).rejects.toThrow(
      'Step "implement" has no resolved provider',
    );

    expect(state.iteration).toBe(2);
    expect(state.stepIterations.has('implement')).toBe(false);
    expect(deps.runStep).not.toHaveBeenCalled();
    expect(deps.emit.mock.calls.some(([event]) => event === 'step:start')).toBe(false);
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
      'step_error',
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

  it('Given provider resolution fails, When single iteration prepares the step, Then it does not consume iteration budgets', async () => {
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
    vi.mocked(deps.resolveStepProviderModel).mockImplementation(() => {
      throw new Error('provider resolution failed');
    });

    await expect(runSingleWorkflowIteration(deps)).rejects.toThrow('provider resolution failed');

    expect(state.iteration).toBe(0);
    expect(state.stepIterations.has('implement')).toBe(false);
    expect(deps.runStep).not.toHaveBeenCalled();
    expect(deps.emit.mock.calls.some(([event]) => event === 'step:start')).toBe(false);
  });

  it('Given the shared limit is reached, When a single iteration targets a countable step, Then it aborts before preparation', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    state.iteration = 5;
    const deps = makeDeps(state, step, makeResponse({
      persona: 'implement',
      status: 'done',
      content: 'done',
    }));

    const result = await runSingleWorkflowIteration(deps);

    expect(result.abort?.kind).toBe('iteration_limit');
    expect(state.iteration).toBe(5);
    expect(deps.setActiveStep).toHaveBeenCalledWith(step, 5);
    expect(deps.emit).toHaveBeenCalledWith(
      'iteration:limit',
      5,
      5,
      'implement',
      expect.objectContaining({
        kind: 'workflow_execution_scope',
        stack: expect.arrayContaining([expect.objectContaining({ step: 'implement' })]),
      }),
    );
    expect(deps.resolveStepProviderModel).not.toHaveBeenCalled();
    expect(deps.runStep).not.toHaveBeenCalled();
  });

  it('does not attribute an unused agent instruction to delegated plans in either execution mode', async () => {
    const step = makeStep('reviewers', {
      parallel: [makeStep('review', { rules: [makeRule('approved', 'COMPLETE')] })],
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const response = makeResponse({ persona: 'reviewers', status: 'done', content: 'approved' });
    const fullDeps = makeDeps(
      createInitialState(makeConfig(step), { projectCwd: '/worktree' }),
      step,
      response,
    );
    const singleDeps = makeDeps(
      createInitialState(makeConfig(step), { projectCwd: '/worktree' }),
      step,
      response,
    );

    await runWorkflowToCompletion(fullDeps);
    await runSingleWorkflowIteration(singleDeps);

    expect(fullDeps.runStep.mock.calls[0]?.[1]).toMatchObject({ kind: 'parallel' });
    expect(singleDeps.runStep.mock.calls[0]?.[1]).toMatchObject({ kind: 'parallel' });
    expect(fullDeps.runStep.mock.calls[0]?.[1]).not.toHaveProperty('preparedExecution');
    expect(singleDeps.runStep.mock.calls[0]?.[1]).not.toHaveProperty('preparedExecution');
    expect(fullDeps.prepareNormalStepExecution).not.toHaveBeenCalled();
    expect(singleDeps.prepareNormalStepExecution).not.toHaveBeenCalled();
    expect(fullDeps.emit.mock.calls.find(([event]) => event === 'step:start')?.[3]).toBe('');
    expect(fullDeps.resolveStepProviderModel).not.toHaveBeenCalled();
    expect(singleDeps.resolveStepProviderModel).not.toHaveBeenCalled();
  });
});
