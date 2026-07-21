/**
 * `next: NEEDS_ADJUDICATION` の終端遷移（対策バッチ B1: provisional fixpoint →
 * NEEDS_ADJUDICATION）を WorkflowRunLoop レベルで検証する。COMPLETE の
 * checkCompletionGate と対になる、独立した終端分岐であることを固定する:
 * - COMPLETE と違い checkCompletionGate は呼ばれない
 * - deps.recordNeedsAdjudication() の戻り値がそのまま abort reason になる
 * - state.status は 'completed' ではなく 'aborted' になる
 * - abort.kind は 'needs_adjudication'
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkflowConfig, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { runSingleWorkflowIteration, runWorkflowToCompletion } from '../core/workflow/engine/WorkflowRunLoop.js';
import { makeResponse, makeRule, makeStep } from './engine-test-helpers.js';

function makeConfig(step: WorkflowStep): WorkflowConfig {
  return {
    name: 'needs-adjudication-workflow',
    description: 'NEEDS_ADJUDICATION transition workflow',
    maxSteps: 5,
    initialStep: step.name,
    steps: [step],
  };
}

function makeDeps(state: WorkflowState, step: WorkflowStep, recordNeedsAdjudication: ReturnType<typeof vi.fn<() => string>>) {
  return {
    state,
    options: {},
    getWorkflowName: () => 'needs-adjudication-workflow',
    getCurrentWorkflowStack: () => undefined,
    getCwd: () => '/worktree',
    getMaxSteps: () => 5,
    getReportDir: () => '/worktree/.takt/runs/test/reports',
    abortRequested: () => false,
    getStep: () => step,
    applyRuntimeEnvironment: vi.fn(),
    loopDetectorCheck: () => ({ count: 1, isLoop: false }),
    cycleDetectorRecordAndCheck: () => ({ triggered: false, cycleCount: 0 }),
    resolveDoneTransition: vi.fn(() => ({ nextStep: 'NEEDS_ADJUDICATION' })),
    runLoopMonitorJudge: vi.fn(),
    runStep: vi.fn(async (_step: WorkflowStep, instruction: string) => {
      const response = makeResponse({ persona: step.name, content: 'reviewers round' });
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction };
    }),
    runQualityGates: vi.fn(async () => ({ ok: true as const })),
    buildInstruction: vi.fn((_step: WorkflowStep, stepIteration: number) => `instruction ${stepIteration}`),
    buildPhase1Instruction: vi.fn((_step: WorkflowStep, instruction: string) => instruction),
    resolveStepProviderModel: vi.fn(() => ({ provider: undefined, model: undefined })),
    resolveRuntimeForStep: vi.fn(),
    setActiveStep: vi.fn(),
    addUserInput: vi.fn(),
    emit: vi.fn(),
    updateMaxSteps: vi.fn(),
    checkCompletionGate: vi.fn(() => ({ ok: true as const })),
    checkReturnValueGate: vi.fn(() => ({ ok: true as const })),
    recordNeedsAdjudication,
    persistPreviousResponseSnapshot: vi.fn(),
  };
}

describe('WorkflowRunLoop next: NEEDS_ADJUDICATION', () => {
  it('aborts runWorkflowToCompletion with kind "needs_adjudication" and the recorded reason, without consulting checkCompletionGate', async () => {
    const step = makeStep('reviewers', {
      rules: [makeRule('when(findings.provisional.fixpoint == true)', 'NEEDS_ADJUDICATION')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const recordNeedsAdjudication = vi.fn(() => 'NEEDS_ADJUDICATION: 2 provisional finding(s) reached a fixpoint');
    const deps = makeDeps(state, step, recordNeedsAdjudication);

    const result = await runWorkflowToCompletion(deps);

    expect(result.state.status).toBe('aborted');
    expect(result.abort?.kind).toBe('needs_adjudication');
    expect(result.abort?.reason).toBe('NEEDS_ADJUDICATION: 2 provisional finding(s) reached a fixpoint');
    expect(recordNeedsAdjudication).toHaveBeenCalledTimes(1);
    expect(deps.checkCompletionGate).not.toHaveBeenCalled();
  });

  it('does not advance to a "NEEDS_ADJUDICATION" step object — it is a pure terminal marker like COMPLETE/ABORT', async () => {
    const step = makeStep('reviewers', {
      rules: [makeRule('when(findings.provisional.fixpoint == true)', 'NEEDS_ADJUDICATION')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const recordNeedsAdjudication = vi.fn(() => 'reason');
    const deps = makeDeps(state, step, recordNeedsAdjudication);

    await runWorkflowToCompletion(deps);

    // advanceActiveStep is never reached for a terminal transition: currentStep
    // stays on the step that matched the rule (the one whose rules routed here).
    expect(state.currentStep).toBe('reviewers');
  });

  it('reports needs_adjudication from runSingleWorkflowIteration as an ABORT-signaling result', async () => {
    const step = makeStep('final-gate', {
      rules: [makeRule('when(findings.provisional.fixpoint == true)', 'NEEDS_ADJUDICATION')],
    });
    const state = createInitialState(makeConfig(step), { projectCwd: '/worktree' });
    const recordNeedsAdjudication = vi.fn(() => 'NEEDS_ADJUDICATION: fixpoint reached');
    const deps = makeDeps(state, step, recordNeedsAdjudication);

    const result = await runSingleWorkflowIteration(deps);

    expect(result.nextStep).toBe('ABORT');
    expect(result.isComplete).toBe(true);
    expect(result.abort?.kind).toBe('needs_adjudication');
    expect(result.abort?.reason).toBe('NEEDS_ADJUDICATION: fixpoint reached');
    expect(state.status).toBe('aborted');
    expect(recordNeedsAdjudication).toHaveBeenCalledTimes(1);
    expect(deps.checkCompletionGate).not.toHaveBeenCalled();
  });
});
