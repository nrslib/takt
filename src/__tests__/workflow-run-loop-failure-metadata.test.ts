import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';
import { createWorkflowRunLoopTestContract } from './test-helpers.js';

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
  const config = makeConfig(step);
  return {
    state,
    options: {},
    getWorkflowName: () => 'failure-metadata-workflow',
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
    prepareNormalStepExecution: vi.fn(async () => undefined),
    resolveStepProviderModel: vi.fn(() => ({
      provider: undefined,
      model: undefined,
    })),
    resolveRuntimeForStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    persistPreviousResponseSnapshot: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
    ...createWorkflowRunLoopTestContract(config, state, 'test task'),
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
        error: 'provider exploded',
      },
    });
    expect(deps.emit).toHaveBeenCalledWith(
      'workflow:abort',
      result.state,
      'Step "implement" failed: provider exploded',
      'step_error',
      {
        kind: 'step_error',
        step: 'implement',
        reason: 'Step "implement" failed: provider exploded',
        error: 'provider exploded',
      },
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

  it('Given a nested rule detection error, When the parent step catches it, Then it records the error step provenance', async () => {
    const step = makeStep('reviewers', {
      rules: [makeRule('Implementation complete', 'COMPLETE')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({
      persona: 'reviewers',
      status: 'done',
      content: 'done',
    });
    const deps = makeDeps(state, step, response);
    vi.mocked(deps.runStep).mockRejectedValue(
      new RuleDetectionExhaustedError('delegate-review'),
    );

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort).toEqual({
      kind: 'rule_no_match',
      reason: 'rule_no_match',
      failure: {
        kind: 'rule_no_match',
        step: 'delegate-review',
        reason: 'rule_no_match',
        error: 'rule_no_match',
      },
    });
  });

  it.each([
    {
      kind: 'step_error',
      reason: 'Step "reviewers" failed: NEEDS_ADJUDICATION: finding invariant failed',
      error: 'NEEDS_ADJUDICATION: finding invariant failed',
    },
    {
      kind: 'rule_no_match',
      reason: 'rule_no_match',
      error: 'rule_no_match',
    },
  ] as const)(
    'Given a workflow_call $kind failure, When the parent takes its ABORT transition, Then it preserves the deepest failure',
    async ({ kind, reason, error }) => {
      const step = makeStep('local-review', {
        rules: [makeRule('ABORT', 'ABORT')],
      });
      const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
      const response = makeResponse({
        persona: 'local-review',
        status: 'done',
        content: reason,
      });
      const deps = makeDeps(state, step, response);
      vi.mocked(deps.resolveDoneTransition).mockReturnValue({ nextStep: 'ABORT' });
      vi.mocked(deps.runStep).mockResolvedValue({
        response,
        instruction: '',
        workflowCallFailure: {
          kind,
          step: 'reviewers',
          reason,
          error,
        },
      });

      const result = await runWorkflowToCompletion(deps);

      expect(result.abort).toEqual({
        kind,
        reason,
        failure: {
          kind,
          step: 'reviewers',
          reason,
          error,
        },
      });
      expect(deps.emit).toHaveBeenCalledWith(
        'workflow:abort',
        result.state,
        reason,
        kind,
        {
          kind,
          step: 'reviewers',
          reason,
          error,
        },
      );
    },
  );

  it('Given a regular ABORT transition, When no step failure caused it, Then it records the transition step and reason', async () => {
    const step = makeStep('review', {
      rules: [makeRule('ABORT', 'ABORT')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const response = makeResponse({ persona: 'review', status: 'done', content: 'stop' });
    const deps = makeDeps(state, step, response);
    vi.mocked(deps.resolveDoneTransition).mockReturnValue({ nextStep: 'ABORT' });

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort).toEqual({
      kind: 'step_transition',
      reason: 'Workflow aborted by step transition',
      failure: {
        kind: 'step_transition',
        step: 'review',
        reason: 'Workflow aborted by step transition',
        error: 'Workflow aborted by step transition',
      },
    });
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
        error: 'provider exploded',
      },
    });
    expect(deps.emit).toHaveBeenCalledWith(
      'workflow:abort',
      state,
      'Step "implement" failed: provider exploded',
      'step_error',
      {
        kind: 'step_error',
        step: 'implement',
        reason: 'Step "implement" failed: provider exploded',
        error: 'provider exploded',
      },
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
