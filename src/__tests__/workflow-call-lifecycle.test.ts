import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../core/models/index.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import type {
  RuntimeStepResolution,
  WorkflowCallCompleteLifecycle,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
  WorkflowStepFailureSummary,
} from '../core/workflow/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { buildWorkflowCallCompleteRecord } from '../features/tasks/execute/sessionLoggerRecordFactory.js';

const OPAQUE_WORKFLOW_REF = Symbol.for('takt.workflowOpaqueRef');

interface HarnessOptions {
  parentWorkflow?: string;
  parentWorkflowReference?: string;
  step?: string;
  childWorkflow?: string;
  childWorkflowReference?: string;
  callInstance?: number;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  childCallable?: boolean;
  childStatus?: 'completed' | 'aborted';
  returnValue?: string;
  abortKind?: 'iteration_limit' | 'step_transition' | 'rule_no_match';
  abortReason?: string;
  abortFailure?: WorkflowStepFailureSummary;
  resolverError?: Error;
  resolverReturnsNull?: boolean;
  createEngineError?: Error;
  runError?: Error;
  setActiveResumePointError?: Error;
  terminalListenerError?: Error;
  rules?: WorkflowConfig['steps'][number]['rules'];
}

interface LifecycleHarness {
  emit: ReturnType<typeof vi.fn>;
  state: WorkflowState;
  execute: () => Promise<unknown>;
  executeIsolated: () => Promise<unknown>;
}

function attachWorkflowReference(workflow: WorkflowConfig, reference: string | undefined): void {
  if (reference === undefined) return;
  Object.defineProperty(workflow, OPAQUE_WORKFLOW_REF, { value: reference });
}

function createChildState(
  childWorkflow: WorkflowConfig,
  status: 'completed' | 'aborted',
): WorkflowState {
  const state = createInitialState(childWorkflow, { initialIteration: 1 });
  state.status = status;
  state.lastOutput = {
    persona: 'child-reviewer',
    status: 'done',
    content: status === 'completed' ? 'approved' : 'child aborted',
    timestamp: new Date(),
  };
  return state;
}

function createLifecycleHarness(options: HarnessOptions = {}): LifecycleHarness {
  const parentName = options.parentWorkflow ?? 'parent';
  const stepName = options.step ?? 'delegate';
  const childName = options.childWorkflow ?? 'shared/review';
  const callInstance = options.callInstance ?? 1;
  const resumeStackPrefix = options.resumeStackPrefix ?? [];
  const workflowStep = {
    name: stepName,
    kind: 'workflow_call' as const,
    call: childName,
    rules: options.rules ?? [
      normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      normalizeRule({ condition: 'ABORT', next: 'ABORT' }),
    ],
  };
  const parentWorkflow: WorkflowConfig = {
    name: parentName,
    initialStep: stepName,
    maxSteps: 3,
    steps: [workflowStep],
  };
  const childWorkflow: WorkflowConfig = {
    name: childName,
    subworkflow: { callable: options.childCallable ?? true },
    initialStep: 'review',
    maxSteps: 3,
    steps: [],
  };
  attachWorkflowReference(parentWorkflow, options.parentWorkflowReference);
  attachWorkflowReference(childWorkflow, options.childWorkflowReference);

  const emit = vi.fn((event: string, lifecycle: WorkflowCallCompleteLifecycle) => {
    if (
      options.terminalListenerError !== undefined
      && event === 'workflow_call:complete'
      && lifecycle.result.status === 'completed'
    ) {
      throw options.terminalListenerError;
    }
  });
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: '/project',
    provider: 'mock',
    model: 'parent-model',
    initialIteration: 1,
  };
  const state = createInitialState(parentWorkflow, engineOptions);
  state.stepIterations.set(stepName, callInstance);
  const sharedRuntime: WorkflowSharedRuntimeState = { startedAtMs: 0 };
  const childState = createChildState(
    childWorkflow,
    options.childStatus ?? 'completed',
  );
  const createEngine = vi.fn(() => {
    if (options.createEngineError !== undefined) {
      throw options.createEngineError;
    }
    return {
      on: vi.fn(),
      runWithResult: options.runError === undefined
        ? vi.fn().mockResolvedValue({
            state: childState,
            ...(childState.status === 'completed'
              ? { returnValue: options.returnValue ?? 'approved' }
              : options.returnValue === undefined
                ? {}
                : { returnValue: options.returnValue }),
            ...(childState.status === 'aborted'
              ? {
                  abort: {
                    kind: options.abortKind ?? 'iteration_limit',
                    reason: options.abortReason ?? 'Maximum steps reached',
                    ...(options.abortFailure === undefined
                      ? {}
                      : { failure: options.abortFailure }),
                  },
                }
              : {}),
          })
        : vi.fn().mockRejectedValue(options.runError),
    };
  });
  const runner = new WorkflowCallRunner({
    getConfig: () => parentWorkflow,
    getMaxSteps: () => parentWorkflow.maxSteps,
    updateMaxSteps: vi.fn(),
    state,
    projectCwd: '/project',
    getCwd: () => '/project',
    task: 'Review the change',
    getOptions: () => engineOptions,
    sharedRuntime,
    resumeStackPrefix,
    consumeWorkflowCallContinuation: vi.fn(),
    runPaths: { slug: 'run' } as never,
    setActiveResumePoint: vi.fn(() => {
      if (options.setActiveResumePointError !== undefined) {
        throw options.setActiveResumePointError;
      }
    }),
    emit,
    resolveWorkflowCall: vi.fn(() => {
      if (options.resolverError !== undefined) {
        throw options.resolverError;
      }
      if (options.resolverReturnsNull === true) {
        return null;
      }
      return childWorkflow;
    }),
    createEngine,
    refreshFindingsState: vi.fn(),
  });
  const runtime: RuntimeStepResolution = {
    providerInfo: {
      provider: 'mock',
      model: 'parent-model',
    },
  };

  const activate = () => runner.activateInvocation(
    workflowStep,
    state.iteration,
    callInstance,
    resumeStackPrefix,
  );
  return {
    emit,
    state,
    execute: async () => {
      const token = activate();
      return runner.run(workflowStep, token, runtime);
    },
    executeIsolated: async () => {
      const token = activate();
      return runner.runIsolated(workflowStep, runtime, resumeStackPrefix, token);
    },
  };
}

function lifecycleCalls(emit: ReturnType<typeof vi.fn>): unknown[][] {
  return emit.mock.calls.filter(([event]) => (
    event === 'workflow_call:start' || event === 'workflow_call:complete'
  ));
}

function expectFailedLifecycle(
  emit: ReturnType<typeof vi.fn>,
  reason: string,
): WorkflowCallCompleteLifecycle {
  const calls = lifecycleCalls(emit);
  expect(calls).toHaveLength(2);
  const start = calls[0]?.[1];
  const complete = calls[1]?.[1];
  expect(calls).toEqual([
    ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
    ['workflow_call:complete', expect.objectContaining({
      result: {
        status: 'failed',
        reason: expect.stringContaining(reason),
      },
    })],
  ]);
  expect(complete).toMatchObject({
    parentWorkflow: (start as WorkflowCallCompleteLifecycle).parentWorkflow,
    step: (start as WorkflowCallCompleteLifecycle).step,
    childWorkflow: (start as WorkflowCallCompleteLifecycle).childWorkflow,
    callInstance: (start as WorkflowCallCompleteLifecycle).callInstance,
    stack: (start as WorkflowCallCompleteLifecycle).stack,
  });
  return complete as WorkflowCallCompleteLifecycle;
}

function createProviderResolutionFailureWorkflows(parallel: boolean): {
  parent: WorkflowConfig;
  child: WorkflowConfig;
} {
  const workflowCall = {
    name: 'delegate',
    kind: 'workflow_call' as const,
    call: 'child',
    rules: [normalizeRule({ condition: 'COMPLETE', next: 'COMPLETE' })],
  };
  const parent: WorkflowConfig = {
    name: parallel ? 'parallel-parent' : 'serial-parent',
    initialStep: parallel ? 'reviewers' : 'delegate',
    maxSteps: 3,
    providerOptions: { codex: { networkAccess: false } },
    steps: parallel
      ? [{
          name: 'reviewers',
          instruction: 'Run delegated review',
          parallel: [workflowCall],
          rules: [normalizeRule({ condition: 'all("COMPLETE")', next: 'COMPLETE' })],
        }]
      : [workflowCall],
  };
  const child: WorkflowConfig = {
    name: 'child',
    subworkflow: { callable: true },
    initialStep: 'child-review',
    maxSteps: 2,
    steps: [{
      name: 'child-review',
      persona: 'child-reviewer',
      instruction: 'Review child workflow',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    }],
  };
  return { parent, child };
}

async function runProviderResolutionFailureThroughEngine(parallel: boolean): Promise<{
  emit: ReturnType<typeof vi.fn>;
  resumePointAtStart: ReturnType<WorkflowEngine['getResumePoint']>;
  state: WorkflowState;
}> {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-call-lifecycle-'));
  const failure = new Error(`${parallel ? 'parallel' : 'serial'} provider resolution failed`);
  const { parent, child } = createProviderResolutionFailureWorkflows(parallel);
  const emit = vi.fn();
  let runStarted = false;
  let workflowCallStarted = false;
  let resumePointAtStart: ReturnType<WorkflowEngine['getResumePoint']>;
  try {
    const engine = new WorkflowEngine(parent, projectDir, 'Resolve provider context', {
      projectCwd: projectDir,
      provider: 'mock',
      model: 'parent-model',
      providerOptions: { codex: { networkAccess: true } },
      providerOptionsOriginResolver: () => {
        if (runStarted && (!parallel || workflowCallStarted)) {
          throw failure;
        }
        return 'default';
      },
      workflowCallResolver: () => child,
    });
    engine.on('workflow_call:start', (lifecycle) => {
      workflowCallStarted = true;
      resumePointAtStart = engine.getResumePoint();
      emit('workflow_call:start', lifecycle);
    });
    engine.on('workflow_call:complete', (lifecycle) => {
      emit('workflow_call:complete', lifecycle);
    });
    runStarted = true;
    const state = await engine.run();
    return { emit, resumePointAtStart, state };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('WorkflowCallRunner lifecycle events', () => {
  it('uses canonical workflow references and occurrences for a completed invocation', async () => {
    const harness = createLifecycleHarness({
      parentWorkflowReference: 'project:sha256:parent',
      childWorkflowReference: 'builtin:sha256:child',
    });

    await harness.execute();

    expect(lifecycleCalls(harness.emit)).toEqual([
      [
        'workflow_call:start',
        {
          parentWorkflow: 'project:sha256:parent',
          step: 'delegate',
          childWorkflow: 'builtin:sha256:child',
          callInstance: 1,
          stack: [{
            workflow: 'parent',
            workflow_ref: 'project:sha256:parent',
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 1,
            step_iterations: { delegate: 1 },
            call_instance: 1,
          }],
        },
      ],
      [
        'workflow_call:complete',
        expect.objectContaining({
          parentWorkflow: 'project:sha256:parent',
          childWorkflow: 'builtin:sha256:child',
          result: { status: 'completed', returnValue: 'approved' },
        }),
      ],
    ]);
  });

  it('retains the complete canonical ancestor stack for nested calls', async () => {
    const ancestor: WorkflowResumePointEntry = {
      workflow: 'outer',
      workflow_ref: 'project:sha256:outer',
      step: 'delegate-parent',
      kind: 'workflow_call',
      occurrence: 3,
      call_instance: 3,
    };
    const harness = createLifecycleHarness({
      parentWorkflow: 'inner-parent',
      parentWorkflowReference: 'project:sha256:inner-parent',
      step: 'delegate-inner',
      callInstance: 2,
      resumeStackPrefix: [ancestor],
    });

    await harness.execute();

    expect(lifecycleCalls(harness.emit)[0]?.[1]).toMatchObject({
      callInstance: 2,
      stack: [
        ancestor,
        {
          workflow: 'inner-parent',
          workflow_ref: 'project:sha256:inner-parent',
          step: 'delegate-inner',
          kind: 'workflow_call',
          occurrence: 2,
          call_instance: 2,
        },
      ],
    });
  });

  it('records an aborted terminal event and preserves deepest failure provenance', async () => {
    const failure: WorkflowStepFailureSummary = {
      kind: 'step_transition',
      step: 'deepest-review',
      reason: 'child rejection',
      error: 'child rejection',
    };
    const harness = createLifecycleHarness({
      childStatus: 'aborted',
      returnValue: undefined,
      abortKind: 'step_transition',
      abortReason: 'child rejection',
      abortFailure: failure,
    });

    const result = await harness.execute() as { workflowCallFailure?: WorkflowStepFailureSummary };

    expect(result.workflowCallFailure).toEqual(failure);
    expect(lifecycleCalls(harness.emit)[1]?.[1]).toMatchObject({
      result: {
        status: 'aborted',
        abortKind: 'step_transition',
        abortReason: 'child rejection',
      },
    });
  });

  it('records start then failed when child resolution throws', async () => {
    const failure = new Error('resolver failed');
    const harness = createLifecycleHarness({ resolverError: failure });

    await expect(harness.execute()).rejects.toBe(failure);

    expectFailedLifecycle(harness.emit, 'resolver failed');
  });

  it('records start then failed when the child workflow is unknown', async () => {
    const harness = createLifecycleHarness({ resolverReturnsNull: true });

    await expect(harness.execute()).rejects.toThrow(
      'references unknown workflow "shared/review"',
    );

    expectFailedLifecycle(harness.emit, 'references unknown workflow "shared/review"');
  });

  it.each([
    {
      name: 'the resolved workflow is not callable',
      options: { childCallable: false },
      reason: 'workflow "shared/review" is not callable',
    },
    {
      name: 'the resolved workflow creates a cycle',
      options: { childWorkflow: 'parent' },
      reason: 'Detected workflow_call cycle',
    },
    {
      name: 'the call depth exceeds the limit',
      options: {
        resumeStackPrefix: Array.from(
          { length: MAX_WORKFLOW_CALL_DEPTH - 1 },
          (_, index): WorkflowResumePointEntry => ({
            workflow: `ancestor-${index + 1}`,
            workflow_ref: `project:sha256:ancestor-${index + 1}`,
            step: `delegate-${index + 1}`,
            kind: 'workflow_call',
            occurrence: 1,
            call_instance: 1,
          }),
        ),
      },
      reason: `workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH})`,
    },
  ])('records exactly one failed terminal when $name', async ({ options, reason }) => {
    const harness = createLifecycleHarness(options);

    await expect(harness.execute()).rejects.toThrow(reason);

    expectFailedLifecycle(harness.emit, reason);
  });

  it('records start then failed when active resume-point publication fails', async () => {
    const failure = new Error('resume point publication failed');
    const harness = createLifecycleHarness({ setActiveResumePointError: failure });

    await expect(harness.execute()).rejects.toBe(failure);

    expectFailedLifecycle(harness.emit, 'resume point publication failed');
  });

  it('records start then failed when child engine construction fails', async () => {
    const failure = new Error('child engine construction failed');
    const harness = createLifecycleHarness({ createEngineError: failure });

    await expect(harness.execute()).rejects.toBe(failure);

    expectFailedLifecycle(harness.emit, 'child engine construction failed');
  });

  it.each([
    { name: 'serial RunLoop', parallel: false },
    { name: 'ParallelRunner', parallel: true },
  ])('records the original provider failure through the real $name wiring', async ({ parallel }) => {
    const result = await runProviderResolutionFailureThroughEngine(parallel);
    const reason = `${parallel ? 'parallel' : 'serial'} provider resolution failed`;

    expect(result.state.status).toBe('aborted');
    const complete = expectFailedLifecycle(result.emit, reason);
    expect(complete.result).toEqual({ status: 'failed', reason });
    expect(result.resumePointAtStart?.stack.at(-1)).toMatchObject({
      step: 'delegate',
      kind: 'workflow_call',
      occurrence: 1,
      call_instance: 1,
    });
    expect(Object.values(result.resumePointAtStart?.workflow_call_invocations ?? {})).toContainEqual({
      call_instance: 1,
      report_namespace_segment: expect.any(String),
    });
  });

  it.each([
    { name: 'normal', isolated: false },
    { name: 'isolated', isolated: true },
  ])('records start then failed when $name child execution rejects', async ({ isolated }) => {
    const failure = new Error(`${isolated ? 'isolated' : 'normal'} child rejected`);
    const harness = createLifecycleHarness({ runError: failure });

    const execution = isolated ? harness.executeIsolated() : harness.execute();
    await expect(execution).rejects.toBe(failure);

    expectFailedLifecycle(harness.emit, failure.message);
  });

  it.each([
    { name: 'normal', isolated: false },
    { name: 'isolated', isolated: true },
  ])('records failed when $name response rule resolution fails', async ({ isolated }) => {
    const harness = createLifecycleHarness({
      rules: [normalizeRule({ condition: 'rejected', next: 'ABORT' })],
    });

    const execution = isolated ? harness.executeIsolated() : harness.execute();
    await expect(execution).rejects.toThrow('no rule matched');

    expectFailedLifecycle(harness.emit, 'no rule matched');
  });

  it.each([
    { name: 'normal', isolated: false },
    { name: 'isolated', isolated: true },
  ])('does not reclassify a completed listener error for $name execution', async ({ isolated }) => {
    const failure = new Error('completed listener failed');
    const harness = createLifecycleHarness({ terminalListenerError: failure });

    const execution = isolated ? harness.executeIsolated() : harness.execute();
    await expect(execution).rejects.toBe(failure);

    expect(lifecycleCalls(harness.emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        result: { status: 'completed', returnValue: 'approved' },
      })],
    ]);
  });

  it('keeps the raw failure in the engine event and redacts it at the NDJSON boundary', async () => {
    const secret = 'super-secret-token';
    const harness = createLifecycleHarness({
      runError: new Error(`token=${secret}`),
    });

    await expect(harness.execute()).rejects.toThrow(secret);

    const complete = expectFailedLifecycle(harness.emit, secret);
    const record = buildWorkflowCallCompleteRecord(
      complete,
      (text) => text.replaceAll(secret, '[REDACTED]'),
    );
    expect(complete.result).toEqual({ status: 'failed', reason: `token=${secret}` });
    expect(record).toMatchObject({
      type: 'workflow_call_complete',
      status: 'failed',
      reason: 'token=[REDACTED]',
    });
  });
});
