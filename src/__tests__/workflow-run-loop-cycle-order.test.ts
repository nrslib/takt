import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, LoopMonitorConfig, WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { WorkflowStepBudget } from '../core/workflow/workflow-step-budget.js';
import { snapshotWorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';

const monitor: LoopMonitorConfig = {
  cycle: ['fix', 'reviewers'],
  threshold: 1,
  judge: { rules: [makeRule('stalled', 'ABORT')] },
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
  const commitTransition = vi.fn();
  const stack = [{ workflow: config.name, step: step.name, kind: 'agent' as const }];
  return {
    state,
    options: {},
    getWorkflowName: () => config.name,
    getTask: () => 'test task',
    getRoutingFindings: () => ({ open: [], conflicts: [] }),
    getCurrentWorkflowStack: () => stack,
    buildStepExecutionScope: () => snapshotWorkflowExecutionScope(stack),
    getCwd: () => '/worktree',
    stepBudget: new WorkflowStepBudget(config.maxSteps),
    recordCountableProgress: vi.fn(),
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: vi.fn(() => ({ triggered: true, cycleCount: 1, monitor })),
    resolveDoneTransition: vi.fn(() => ({ nextStep })),
    runLoopMonitorJudge: vi.fn(async () => ({ nextStep: 'ABORT', response })),
    getPendingLoopJudge: () => undefined,
    runStep: vi.fn(async (_step: WorkflowStep, plan: { kind: string; preparedExecution?: { phase1Instruction: string } }) => ({
      response,
      instruction: plan.preparedExecution?.phase1Instruction ?? '',
      commitTransition,
    })),
    runQualityGates: vi.fn(async () => ({ ok: true as const })),
    persistPreviousResponseSnapshot: vi.fn(),
    prepareNormalStepExecution: vi.fn((_step: WorkflowStep, stepIteration: number) => ({
      executableStep: step as AgentWorkflowStep,
      phase1Instruction: 'instruction',
      stepIteration,
      rollbackPreparation: vi.fn(),
    })),
    resolveStepProviderModel: vi.fn(() => ({ provider: 'mock', model: 'test-model' })),
    resolveStepProviderModelBeforeAutoRouting: vi.fn(() => ({ provider: 'mock', model: 'test-model' })),
    setActiveStep: vi.fn(),
    syncMaxSteps: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
    commitTransition,
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
    expect(deps.commitTransition).toHaveBeenCalledWith({
      kind: 'next_step',
      nextStep: 'ABORT',
    });
    expect(deps.cycleDetectorRecordAndCheck).not.toHaveBeenCalled();
    expect(deps.runLoopMonitorJudge).not.toHaveBeenCalled();
  });

  it('does not commit a natural COMPLETE transition rejected by the completion gate', async () => {
    const deps = makeDeps('COMPLETE');
    deps.checkCompletionGate.mockReturnValue({
      ok: false,
      reason: 'provisional findings remain',
    });

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort?.kind).toBe('provisional_findings');
    expect(deps.commitTransition).not.toHaveBeenCalled();
  });

  it('does not commit a monitored COMPLETE transition rejected by the completion gate', async () => {
    const deps = makeDeps('reviewers');
    deps.runLoopMonitorJudge.mockResolvedValue({
      nextStep: 'COMPLETE',
      response: makeResponse({ persona: 'supervisor', status: 'done', content: 'healthy' }),
    });
    deps.checkCompletionGate.mockReturnValue({
      ok: false,
      reason: 'provisional findings remain',
    });

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort?.kind).toBe('provisional_findings');
    expect(deps.commitTransition).not.toHaveBeenCalled();
  });

  it('should not start a cycle judge when interruption is requested by cycle detection', async () => {
    const deps = makeDeps('reviewers');
    let interrupted = false;
    deps.abortRequested = () => interrupted;
    deps.cycleDetectorRecordAndCheck.mockImplementation(() => {
      interrupted = true;
      return { triggered: true, cycleCount: 1, monitor };
    });

    const result = await runWorkflowToCompletion(deps);

    expect(result.abort?.kind).toBe('interrupt');
    expect(result.state.iteration).toBe(1);
    expect(result.state.stepIterations.get('reviewers')).toBe(1);
    expect(result.state.stepIterations.has('_loop_judge_fix_reviewers')).toBe(false);
    expect(deps.runLoopMonitorJudge).not.toHaveBeenCalled();
    expect(deps.commitTransition).not.toHaveBeenCalled();
  });
});
