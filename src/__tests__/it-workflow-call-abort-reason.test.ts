import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/evaluation/index.js')>()),
  RuleEvaluator: (await import('./rule-evaluator-test-double.js')).MockRuleEvaluator,
}));
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  generateReportDir: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowCallCompleteLifecycle, WorkflowAbortKind, WorkflowEvents } from '../core/workflow/types.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { applyDefaultMocks, cleanupWorkflowEngine, createTestTmpDir, makeResponse, mockRunAgentSequence } from './engine-test-helpers.js';
import { createParentWorkflow, createWorkflowCallOptions, loadWorkflowOrThrow, writeWorkflow } from './helpers/engine-workflow-call-shared.js';

type CallForm = 'direct' | 'uses' | 'parallel';
type Stop = 'limit-before' | 'limit-inside' | 'ABORT' | 'blocked' | 'error' | 'exception' | 'no-match' | 'interrupt';

const stops: Array<{ stop: Stop; kind: WorkflowAbortKind; step: string }> = [
  { stop: 'limit-before', kind: 'iteration_limit', step: 'leaf' },
  { stop: 'limit-inside', kind: 'iteration_limit', step: 'pending' },
  { stop: 'ABORT', kind: 'step_transition', step: 'leaf' },
  { stop: 'blocked', kind: 'blocked', step: 'leaf' },
  { stop: 'error', kind: 'step_error', step: 'leaf' },
  { stop: 'exception', kind: 'runtime_error', step: 'leaf' },
  { stop: 'no-match', kind: 'rule_no_match', step: 'leaf' },
  { stop: 'interrupt', kind: 'interrupt', step: 'leaf' },
];

describe('unhandled child workflow abort reasons', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    execFileSync('git', ['init', '--quiet'], { cwd: tmpDir });
    execFileSync('git', [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test',
      'commit', '--quiet', '--allow-empty', '-m', 'baseline',
    ], { cwd: tmpDir });
  });

  afterEach(() => {
    cleanupWorkflowEngine(engine);
    engine = null;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    resetAnalyticsWriter();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCallChain(form: CallForm, stop: Stop, handleAbort = false): void {
    writeWorkflow(tmpDir, 'leaf.yaml', `name: leaf-workflow
subworkflow:
  callable: true
initial_step: leaf
steps:
  - name: leaf
    persona: worker
    instruction: Work
    rules:
      - condition: done
        next: ${stop === 'limit-inside' ? 'pending' : stop === 'ABORT' ? 'ABORT' : 'COMPLETE'}
${stop === 'limit-inside' ? `  - name: pending
    persona: worker
    instruction: Pending work
    rules:
      - condition: done
        next: COMPLETE
` : ''}`);
    const call = form === 'uses' ? 'uses: delegate-fragment' : 'kind: workflow_call\n    call: leaf';
    if (form === 'uses') {
      const stepsDir = join(tmpDir, '.takt', 'steps');
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(join(stepsDir, 'delegate-fragment.yaml'), 'kind: workflow_call\ncall: leaf\n');
    }
    writeWorkflow(tmpDir, 'outer.yaml', `name: outer
subworkflow:
  callable: true
initial_step: delegate-leaf
steps:
  - name: delegate-leaf
    ${call}
    rules:
      - condition: COMPLETE
        next: COMPLETE
${handleAbort ? `      - condition: ABORT
        next: COMPLETE
` : ''}`);
    const budget = stop === 'limit-before' || stop === 'limit-inside' ? 1 : 5;
    writeWorkflow(tmpDir, 'root.yaml', `name: root
initial_step: ${form === 'parallel' ? 'reviewers' : 'delegate-outer'}
max_steps: ${budget}
steps:
${form === 'parallel' ? `  - name: reviewers
    parallel:
      - name: delegate-outer
        kind: workflow_call
        call: outer
        rules:
          - condition: COMPLETE
            next: COMPLETE
    rules:
      - condition: 'all("COMPLETE")'
        next: COMPLETE
` : `  - name: delegate-outer
    kind: workflow_call
    call: outer
    rules:
      - condition: COMPLETE
        next: COMPLETE
`}`);
  }

  describe.each<CallForm>(['direct', 'uses', 'parallel'])('%s', (form) => {
    it.each(stops)('preserves $kind for $stop through nested calls', async ({ stop, kind, step }) => {
      writeCallChain(form, stop);
      const controller = new AbortController();
      mockRuleEvaluation.mockImplementation(() => stop === 'no-match'
        ? undefined
        : { index: 0, method: 'phase3_tag' });
      vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
        if (stop === 'exception') throw new Error('child execution failed');
        options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
        if (stop === 'interrupt') controller.abort();
        return makeResponse({
          persona: String(persona),
          status: stop === 'blocked' ? 'blocked' : stop === 'error' ? 'error' : 'done',
          content: 'child output',
          ...(stop === 'error' ? { error: 'child failure' } : {}),
        });
      });
      // Parallel parents consume one iteration before entering the child.
      const initialIteration = stop === 'limit-before' && form !== 'parallel' ? 1 : 0;
      // Leave one child iteration for the inside-child exhaustion case.
      const maxStepsOverride = stop === 'limit-inside' && form === 'parallel' ? 2 : undefined;
      const config = loadWorkflowOrThrow('root', tmpDir);
      engine = new WorkflowEngine(config, tmpDir, 'Preserve child abort', createWorkflowCallOptions(tmpDir, {
        initialIteration,
        ...(maxStepsOverride === undefined ? {} : { maxStepsOverride }),
        abortSignal: controller.signal,
      }));
      const lifecycle: WorkflowCallCompleteLifecycle[] = [];
      const abortEvent = vi.fn<WorkflowEvents['workflow:abort']>();
      const started = vi.fn();
      const phaseStarted = vi.fn<WorkflowEvents['phase:start']>();
      engine.on('workflow_call:complete', (event) => lifecycle.push(event));
      engine.on('workflow:abort', abortEvent);
      engine.on('step:start', started);
      engine.on('phase:start', phaseStarted);

      const state = await engine.run();
      const terminalAbort = abortEvent.mock.calls.at(-1);
      const failure = terminalAbort?.[3];
      const reason = terminalAbort?.[1];

      expect(state.status).toBe('aborted');
      expect(terminalAbort?.[2]).toBe(kind);
      expect(failure?.kind).toBe(kind);
      const expectedFailureStep = stop === 'interrupt'
        ? (form === 'parallel' ? 'reviewers' : 'delegate-outer')
        : step;
      expect(failure?.step).toBe(expectedFailureStep);
      expect(failure?.reason).toBe(reason);
      if (stop === 'error' || stop === 'exception') {
        expect(failure?.error).toBe(stop === 'error' ? 'child failure' : 'child execution failed');
      }
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle.map((event) => event.result)).toEqual([
        expect.objectContaining({ status: 'aborted', abortKind: kind, abortReason: reason }),
        expect.objectContaining({ status: 'aborted', abortKind: kind, abortReason: reason }),
      ]);
      if (stop === 'error') {
        const [initialLeafExecution, providerErrorFreshRetry] = vi.mocked(runAgent).mock.calls;
        expect(runAgent).toHaveBeenCalledTimes(2);
        expect(initialLeafExecution).toEqual([
          'worker',
          expect.any(String),
          expect.objectContaining({ workflowMeta: expect.objectContaining({ currentStep: 'leaf' }) }),
        ]);
        expect(providerErrorFreshRetry).toEqual([
          'worker',
          initialLeafExecution?.[1],
          expect.objectContaining({
            workflowMeta: expect.objectContaining({ currentStep: 'leaf' }),
            sessionId: undefined,
          }),
        ]);
        expect(phaseStarted.mock.calls.map(([phaseStep, phase, phaseName, , , phaseExecutionId]) => ({
          step: phaseStep.name, phase, phaseName, phaseExecutionId,
        }))).toEqual([
          { step: 'leaf', phase: 1, phaseName: 'execute', phaseExecutionId: expect.stringMatching(/^leaf:\d+:1:1$/) },
          { step: 'leaf', phase: 1, phaseName: 'execute', phaseExecutionId: expect.stringMatching(/^leaf:\d+:1:2$/) },
        ]);
        expect(started.mock.calls.filter(([startedStep]) => startedStep.name === 'leaf')).toHaveLength(1);
      } else {
        expect(runAgent).toHaveBeenCalledTimes(stop === 'limit-before' ? 0 : 1);
      }
      if (stop === 'limit-before') {
        expect(started.mock.calls.map(([startedStep]) => startedStep.name)).toEqual(form === 'parallel' ? ['reviewers'] : []);
      }
    });
  });

  it('preserves child abort reasons in runSingleIteration', async () => {
    writeCallChain('uses', 'limit-inside');
    mockRuleEvaluation.mockReturnValue({ index: 0, method: 'phase3_tag' });
    mockRunAgentSequence([makeResponse({ content: 'done' })]);
    engine = new WorkflowEngine(loadWorkflowOrThrow('root', tmpDir), tmpDir, 'Single iteration abort', createWorkflowCallOptions(tmpDir));

    const result = await engine.runSingleIteration();

    expect(result.isComplete).toBe(true);
    expect(result.abort?.failure).toEqual(expect.objectContaining({ kind: 'iteration_limit', step: 'pending' }));
    expect(engine.getState().iteration).toBe(1);
  });

  it('keeps explicit ABORT routing when the parent handles a child abort', async () => {
    writeCallChain('uses', 'ABORT', true);
    mockRuleEvaluation.mockReturnValue({ index: 0, method: 'phase3_tag' });
    mockRunAgentSequence([makeResponse({ content: 'abort output' })]);
    engine = new WorkflowEngine(loadWorkflowOrThrow('root', tmpDir), tmpDir, 'Handle abort', createWorkflowCallOptions(tmpDir));

    const aborted = vi.fn();
    engine.on('workflow:abort', aborted);
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(aborted).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('reports a separate parent aggregate mismatch after the child ABORT is explicitly handled', async () => {
    writeCallChain('direct', 'ABORT');
    const config = createParentWorkflow(tmpDir, {
      name: 'root', initial_step: 'reviewers', max_steps: 5,
      steps: [{
        name: 'reviewers',
        parallel: [{
          name: 'delegate-leaf', kind: 'workflow_call', call: 'leaf',
          rules: [{ condition: 'ABORT', next: 'ABORT' }],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    mockRuleEvaluation.mockImplementation((step) => step.name === 'reviewers'
      ? undefined
      : { index: 0, method: 'phase3_tag' });
    mockRunAgentSequence([makeResponse({ content: 'abort output' })]);
    engine = new WorkflowEngine(config, tmpDir, 'Parent aggregate mismatch', createWorkflowCallOptions(tmpDir));
    const aborted = vi.fn<WorkflowEvents['workflow:abort']>();
    const childCompleted = vi.fn<WorkflowEvents['workflow_call:complete']>();
    engine.on('workflow:abort', aborted);
    engine.on('workflow_call:complete', childCompleted);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(aborted.mock.calls.at(-1)?.[3]).toEqual(expect.objectContaining({ kind: 'rule_no_match', step: 'reviewers' }));
    expect(childCompleted.mock.calls[0]?.[0].result).toEqual(expect.objectContaining({ status: 'aborted', abortKind: 'step_transition' }));
  });
});
