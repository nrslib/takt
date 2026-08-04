import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowConfig,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../core/models/index.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { WorkRequirementEstimator } from '../core/workflow/auto-routing/contracts.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { WorkflowCallProgressTracker } from '../core/workflow/workflow-call-progress-tracker.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallInvocationRecordsFixture } from './helpers/workflow-resume-fixture.js';
import type { WorkflowSharedRuntimeState } from '../core/workflow/types.js';

const { createWorkRequirementEstimatorMock } = vi.hoisted(() => ({
  createWorkRequirementEstimatorMock: vi.fn(),
}));

vi.mock('../agents/auto-routing-usecase.js', () => ({
  createWorkRequirementEstimator: createWorkRequirementEstimatorMock,
}));

interface ChildResult {
  state: WorkflowState;
  returnValue?: string;
  abort?: {
    kind: 'iteration_limit';
    reason: string;
  };
}

function createChildState(
  childWorkflow: WorkflowConfig,
  status: 'completed' | 'aborted',
  initialIteration: number,
): WorkflowState {
  const state = createInitialState(childWorkflow, { initialIteration });
  state.status = status;
  return state;
}

function createLifecycleHarness(options: {
  parentWorkflow: string;
  step: string;
  childWorkflow: string;
  childWorkflowReference?: string;
  callInstance: number;
  resumeStackPrefix?: WorkflowResumePointEntry[];
  childResult?: ChildResult;
  childCallable?: boolean;
  resolverError?: Error;
  createEngineError?: Error;
  runError?: Error;
  terminalListenerError?: Error;
  resumePoint?: WorkflowResumePoint;
  expectedChildReferenceDuringResolution?: string;
  rules?: WorkflowConfig['steps'][number]['rules'];
}) {
  const workflowStep = {
    name: options.step,
    kind: 'workflow_call' as const,
    call: options.childWorkflow,
    rules: options.rules ?? [
      normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      normalizeRule({ condition: 'ABORT', next: 'ABORT' }),
    ],
  };
  const parentWorkflow: WorkflowConfig = {
    name: options.parentWorkflow,
    initialStep: options.step,
    maxSteps: 3,
    steps: [workflowStep],
  };
  const childWorkflow: WorkflowConfig = {
    name: options.childWorkflow,
    subworkflow: { callable: options.childCallable ?? true },
    initialStep: 'review',
    steps: [],
  };
  if (options.childWorkflowReference !== undefined) {
    Object.defineProperty(childWorkflow, Symbol.for('takt.workflowOpaqueRef'), {
      value: options.childWorkflowReference,
    });
  }
  const emit = vi.fn((event: string, lifecycle: { result?: { status: string } }) => {
    if (
      options.terminalListenerError !== undefined
      && event === 'workflow_call:complete'
      && lifecycle.result?.status === 'completed'
    ) {
      throw options.terminalListenerError;
    }
  });
  const engineOptions = {
    projectCwd: '/project',
    provider: 'mock' as const,
    initialIteration: 1,
    resumePoint: options.resumePoint,
  };
  const state = createInitialState(parentWorkflow, engineOptions);
  state.stepIterations.set(
    options.step,
    options.resumePoint === undefined ? options.callInstance - 1 : options.callInstance,
  );
  const progressTracker = new WorkflowCallProgressTracker();
  const progressLease = progressTracker.acquire();
  const sharedRuntime: WorkflowSharedRuntimeState = {
    startedAtMs: 0,
    workflowCallProgressTracker: progressTracker,
  };
  const adoptResumeCheckpoint = vi.fn((_resumePoint: WorkflowResumePoint, iteration: number) => {
    state.iteration = iteration;
  });
  let resolutionCount = 0;
  const runner = new WorkflowCallRunner({
    getConfig: () => parentWorkflow,
    getOptions: () => engineOptions,
    getCwd: () => '/project',
    projectCwd: '/project',
    task: 'Review the change',
    sharedRuntime,
    progressLease,
    resumeStackPrefix: options.resumeStackPrefix ?? [],
    runPaths: { slug: 'run' },
    resolveWorkflowCall: vi.fn(() => {
      resolutionCount += 1;
      if (options.resolverError) {
        throw options.resolverError;
      }
      if (options.expectedChildReferenceDuringResolution !== undefined && resolutionCount === 1) {
        expect(sharedRuntime.workflowCallInvocationEvidence?.index.get(
          parentWorkflow,
          options.step,
          options.resumeStackPrefix ?? [],
        )?.child_workflow_ref).toBe(options.expectedChildReferenceDuringResolution);
      }
      return childWorkflow;
    }),
    createEngine: vi.fn((_config, _cwd, _task, childOptions) => {
      if (options.createEngineError) {
        throw options.createEngineError;
      }
      if (childOptions.initialIteration === undefined) {
        throw new Error('Child engine fake requires initialIteration');
      }
      const childResult = options.childResult ?? {
        state: createChildState(childWorkflow, 'completed', childOptions.initialIteration),
        returnValue: 'approved',
      };
      const childResumePoint: WorkflowResumePoint = {
        version: 2,
        stack: [{
          workflow: childWorkflow.name,
          step: 'review',
          kind: 'agent',
          step_iterations: {},
        }],
        iteration: childResult.state.iteration,
        max_steps: 3,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      };
      return {
        on: vi.fn(),
        runWithResult: options.runError
          ? vi.fn().mockRejectedValue(options.runError)
          : vi.fn().mockResolvedValue(childResult),
        getOwnedResumePoint: vi.fn(() => childResumePoint),
      };
    }),
    emit,
    state,
    setActiveResumePoint: vi.fn((_step, iteration) => {
      state.iteration = iteration;
    }),
    setActiveResumeStack: vi.fn((_stack, iteration) => {
      state.iteration = iteration;
    }),
    adoptResumeCheckpoint,
    refreshFindingsState: vi.fn(),
  } as never);

  return {
    emit,
    state,
    adoptResumeCheckpoint,
    execute: () => runner.run(workflowStep),
    executeIsolated: () => runner.runIsolated(workflowStep),
    recordCountableProgress: () => progressLease.recordCountableProgress(),
  };
}

function lifecycleCalls(emit: ReturnType<typeof vi.fn>): unknown[][] {
  return emit.mock.calls.filter(([event]) => (
    event === 'workflow_call:start' || event === 'workflow_call:complete'
  ));
}

describe('WorkflowCallRunner lifecycle events', () => {
  it('should retain provider-independent invocation identity when a child workflow completes', async () => {
    const { emit, execute } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
    });

    await execute();

    const calls = lifecycleCalls(emit);
    expect(calls).toEqual([
      [
        'workflow_call:start',
        expect.objectContaining({
          parentWorkflow: 'parent',
          step: 'delegate',
          childWorkflow: 'shared/review',
          callInstance: 1,
          stack: [
            expect.objectContaining({
              workflow: 'parent',
              step: 'delegate',
              kind: 'workflow_call',
              call_instance: 1,
            }),
          ],
        }),
      ],
      [
        'workflow_call:complete',
        expect.objectContaining({
          parentWorkflow: 'parent',
          step: 'delegate',
          childWorkflow: 'shared/review',
          callInstance: 1,
          result: {
            status: 'completed',
            returnValue: 'approved',
          },
        }),
      ],
    ]);
    for (const [, lifecycle] of calls) {
      expect(lifecycle).not.toHaveProperty('iteration');
      expect(lifecycle).not.toHaveProperty('provider');
      expect(lifecycle).not.toHaveProperty('model');
    }
  });

  it('should retain the complete ancestor stack when a nested workflow call starts', async () => {
    const ancestor = {
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 3,
    };
    const { emit, execute } = createLifecycleHarness({
      parentWorkflow: 'shared/outer',
      step: 'delegate-inner',
      childWorkflow: 'shared/inner',
      callInstance: 2,
      resumeStackPrefix: [ancestor],
    });

    await execute();

    const start = lifecycleCalls(emit)[0]?.[1];
    expect(start).toMatchObject({
      callInstance: 2,
      stack: [
        ancestor,
        {
          workflow: 'shared/outer',
          step: 'delegate-inner',
          kind: 'workflow_call',
          call_instance: 2,
        },
      ],
    });
  });

  it('should record an aborted terminal event when the child workflow aborts', async () => {
    const childWorkflow: WorkflowConfig = {
      name: 'shared/review',
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [],
    };
    const { emit, execute } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: childWorkflow.name,
      callInstance: 1,
      childResult: {
        state: createChildState(childWorkflow, 'aborted', 1),
        abort: {
          kind: 'iteration_limit',
          reason: 'Maximum steps reached',
        },
      },
    });

    await execute();

    const complete = lifecycleCalls(emit)[1]?.[1];
    expect(complete).toMatchObject({
      result: {
        status: 'aborted',
        abortKind: 'iteration_limit',
        abortReason: 'Maximum steps reached',
      },
    });
  });

  it('should record one failed terminal event and preserve iteration when resolution fails', async () => {
    const failure = new Error('resolver failed');
    const { emit, execute, state } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      resolverError: failure,
    });

    await expect(execute()).rejects.toBe(failure);

    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(lifecycleCalls(emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: { status: 'failed', reason: 'resolver failed' },
      })],
    ]);
  });

  it('should record one failed terminal event when child execution rejects', async () => {
    const failure = new Error('child run rejected');
    const childWorkflow: WorkflowConfig = {
      name: 'shared/review',
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [],
    };
    const childState = createChildState(childWorkflow, 'aborted', 4);
    const { adoptResumeCheckpoint, emit, execute, state } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      childResult: { state: childState },
      runError: failure,
    });

    await expect(execute()).rejects.toBe(failure);

    expect(lifecycleCalls(emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: { status: 'failed', reason: 'child run rejected' },
      })],
    ]);
    expect(state.iteration).toBe(4);
    expect(adoptResumeCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 4 }),
      4,
    );
  });

  it('should preserve the child iteration when response rule resolution fails', async () => {
    const childWorkflow: WorkflowConfig = {
      name: 'shared/review',
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [],
    };
    const childState = createChildState(childWorkflow, 'completed', 4);
    const harness = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      childResult: { state: childState, returnValue: 'approved' },
      rules: [normalizeRule({ condition: 'rejected', next: 'ABORT' })],
    });

    await expect(harness.execute()).rejects.toThrow();

    expect(harness.state.iteration).toBe(4);
    expect(harness.adoptResumeCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 4 }),
      4,
    );
  });

  it.each([
    { mode: 'normal', isolated: false },
    { mode: 'isolated', isolated: true },
  ])('should propagate a completed listener error without reclassifying the $mode attempt', async ({ isolated }) => {
    const failure = new Error('completed listener failed');
    const harness = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      terminalListenerError: failure,
    });

    const execution = isolated ? harness.executeIsolated() : harness.execute();
    await expect(execution).rejects.toBe(failure);

    expect(lifecycleCalls(harness.emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: { status: 'completed', returnValue: 'approved' },
      })],
    ]);
  });

  it('should record one failed terminal event when isolated child execution rejects', async () => {
    const failure = new Error('isolated child run rejected');
    const { emit, executeIsolated } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      runError: failure,
    });

    await expect(executeIsolated()).rejects.toBe(failure);

    expect(lifecycleCalls(emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: { status: 'failed', reason: 'isolated child run rejected' },
      })],
    ]);
  });

  it.each([
    {
      name: 'the resolved workflow is not callable',
      options: {
        parentWorkflow: 'parent',
        step: 'delegate',
        childWorkflow: 'shared/review',
        callInstance: 1,
        childCallable: false,
      },
      reason: 'workflow "shared/review" is not callable',
    },
    {
      name: 'the resolved workflow creates a cycle',
      options: {
        parentWorkflow: 'parent',
        step: 'delegate',
        childWorkflow: 'parent',
        callInstance: 1,
      },
      reason: 'Detected workflow_call cycle',
    },
    {
      name: 'the call depth exceeds the limit',
      options: {
        parentWorkflow: 'parent',
        step: 'delegate',
        childWorkflow: 'shared/review',
        callInstance: 1,
        resumeStackPrefix: Array.from(
          { length: MAX_WORKFLOW_CALL_DEPTH - 1 },
          (_, index) => ({
            workflow: `ancestor-${index + 1}`,
            step: `delegate-${index + 1}`,
            kind: 'workflow_call' as const,
            call_instance: 1,
          }),
        ),
      },
      reason: `workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH})`,
    },
  ])('should record exactly one failed terminal event when $name', async ({ options, reason }) => {
    const { emit, execute } = createLifecycleHarness(options);

    await expect(execute()).rejects.toThrow(reason);

    const calls = lifecycleCalls(emit);
    expect(calls).toHaveLength(2);
    const start = calls[0]?.[1] as Record<string, unknown>;
    expect(calls).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        parentWorkflow: start.parentWorkflow,
        step: start.step,
        childWorkflow: start.childWorkflow,
        callInstance: start.callInstance,
        stack: start.stack,
        result: {
          status: 'failed',
          reason: expect.stringContaining(reason),
        },
      })],
    ]);
  });

  it('should preserve the original error and record one failed terminal when child engine construction fails', async () => {
    const failure = new Error('child engine construction failed');
    const { emit, execute } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      createEngineError: failure,
    });

    await expect(execute()).rejects.toBe(failure);

    expect(lifecycleCalls(emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: {
          status: 'failed',
          reason: 'child engine construction failed',
        },
      })],
    ]);
  });

  it('should consume a resumed call instance once and allocate a new instance on the next call', async () => {
    const resumePoint = {
      version: 2 as const,
      stack: [{
        workflow: 'parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        call_instance: 1,
        step_iterations: { delegate: 1 },
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
        workflowReference: 'parent',
        step: 'delegate',
        ownerPath: [],
        callInstance: 1,
        childWorkflowReference: 'project:sha256:child',
      }]),
      workflow_step_participations: {},
    };
    const { emit, execute, state, recordCountableProgress } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      childWorkflowReference: 'project:sha256:child',
      callInstance: 1,
      resumePoint,
      expectedChildReferenceDuringResolution: 'project:sha256:child',
    });

    await execute();
    state.iteration = 2;
    recordCountableProgress();
    await execute();

    expect(state.iteration).toBe(2);
    expect(state.stepIterations.get('delegate')).toBe(2);
    expect(lifecycleCalls(emit).map(([, lifecycle]) => (
      lifecycle as { callInstance: number }
    ).callInstance)).toEqual([1, 1, 2, 2]);
  });

  it('should fail fast when a resumed namespace references a different child workflow', async () => {
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);
    const resumePoint: WorkflowResumePoint = {
      version: 2,
      stack: [{
        workflow: 'parent',
        step: 'delegate',
        kind: 'workflow_call',
        call_instance: 1,
        step_iterations: { delegate: 1 },
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {
        [identity]: {
          call_instance: 1,
          child_workflow_ref: 'different-child',
        },
      },
      workflow_step_participations: {},
    };
    const { emit, execute } = createLifecycleHarness({
      parentWorkflow: 'parent',
      step: 'delegate',
      childWorkflow: 'shared/review',
      callInstance: 1,
      resumePoint,
    });

    await expect(execute()).rejects.toThrow('does not match resolved child');
    expect(lifecycleCalls(emit)).toEqual([
      ['workflow_call:start', expect.objectContaining({ callInstance: 1 })],
      ['workflow_call:complete', expect.objectContaining({
        callInstance: 1,
        result: expect.objectContaining({ status: 'failed' }),
      })],
    ]);
  });
});

describe('WorkflowCallProgressTracker', () => {
  it('sibling branch progress does not erase another branch identity', () => {
    const tracker = new WorkflowCallProgressTracker();
    const firstBranch = tracker.acquire();
    const secondBranch = tracker.acquire();

    firstBranch.enter('A', 'call-a');
    secondBranch.enter('B', 'call-b');
    secondBranch.recordCountableProgress();

    expect(() => firstBranch.enter('A', 'call-a')).toThrow(/without countable-step progress/);
    expect(() => secondBranch.enter('B', 'call-b')).not.toThrow();
  });

  it('allows a call identity after countable progress advances its branch', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.acquire();

    branch.enter('A', 'call-a');
    branch.recordCountableProgress();

    expect(() => branch.enter('A', 'call-a')).not.toThrow();
  });

  it('allows an ancestor call identity after descendant countable progress', () => {
    const tracker = new WorkflowCallProgressTracker();
    const parent = tracker.acquire();
    const child = tracker.acquire(parent);

    parent.enter('A', 'call-a');
    child.recordCountableProgress();

    expect(() => parent.enter('A', 'call-a')).not.toThrow();
    child.release();
    parent.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('does not retain a reserved engine branch before execution starts', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.reserve();

    expect(tracker.activeBranchCount()).toBe(0);
    branch.activate();
    expect(tracker.activeBranchCount()).toBe(1);
    branch.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('bounds retained history by active branches across long-running progress', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.acquire();

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      branch.enter(`call-${iteration}`, 'delegate');
      branch.recordCountableProgress();
    }

    expect(tracker.activeBranchCount()).toBe(1);
    expect(tracker.retainedIdentityCount()).toBe(0);
    branch.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });
});

describe('WorkflowCallExecutor routing runtime', () => {
  function ownedResumePoint() {
    return {
      version: 2 as const,
      stack: [{ workflow: 'child', step: 'review', kind: 'agent' as const, step_iterations: {} }],
      iteration: 1,
      max_steps: 4,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
  }

  function createAutoRoutingConfig(model = 'router-model'): AutoRoutingConfig {
    return {
      strategy: 'cost',
      router: { provider: 'mock', model },
      candidates: [
        { name: 'medium', description: 'Focused work', provider: 'mock', model: 'medium-model', routingTier: 'medium' },
        { name: 'high', description: 'Complex work', provider: 'mock', model: 'high-model', routingTier: 'high' },
      ],
      defaultPool: 'general',
      candidatePools: { general: { candidates: ['medium', 'high'], fallback: 'high' } },
    };
  }

  function createCallAttempt(stepName: string, childWorkflowName: string) {
    const identity = buildWorkflowCallInvocationIdentity('parent', stepName, []);
    return {
      reportNamespaceSegment: buildWorkflowCallNamespaceSegment(identity, childWorkflowName, 1),
      callStack: [{
        workflow: 'parent',
        step: stepName,
        kind: 'workflow_call' as const,
        step_iterations: { [stepName]: 1 },
        call_instance: 1,
      }],
    };
  }

  beforeEach(() => {
    createWorkRequirementEstimatorMock.mockReset();
    createWorkRequirementEstimatorMock.mockImplementation(() => ({ estimate: vi.fn() }));
  });

  it('Given a child that inherits its parent auto routing, When creating child engines at separate call sites, Then it reuses the injected estimator with a runtime isolated to each call site', async () => {
    const parentWorkflow = { name: 'parent', steps: [] } as never;
    const childWorkflow = {
      name: 'child',
      steps: [],
    } as never;
    const parentAutoRouting = createAutoRoutingConfig();
    const parentEstimator: WorkRequirementEstimator = { estimate: vi.fn() };
    const state = {
      iteration: 1,
      personaSessions: new Map(),
      stepIterations: new Map([['delegate', 1], ['delegate-other', 1]]),
      userInputs: ['Retry the remaining task work'],
    };
    const createdOptions: Array<Record<string, unknown>> = [];
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentWorkflow,
      getOptions: () => ({
        projectCwd: '/project',
        provider: 'mock',
        autoRouting: parentAutoRouting,
        autoRoutingEstimator: parentEstimator,
        autoRoutingEstimatorSource: 'injected',
      }),
      getCwd: () => '/project',
      projectCwd: '/project',
      task: 'Complete the task',
      sharedRuntime: { startedAtMs: 0 },
      resumeStackPrefix: [],
      runPaths: { slug: 'run' },
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn((_config, _cwd, _task, options) => {
        createdOptions.push(options as Record<string, unknown>);
        return {
          on: vi.fn(),
          getOwnedResumePoint: vi.fn(ownedResumePoint),
          runWithResult: vi.fn().mockResolvedValue({
            state: {
              iteration: 1,
              personaSessions: new Map(),
              status: 'completed',
            },
          }),
        };
      }),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    } as never);
    const request = {
      step: { name: 'delegate', kind: 'workflow_call', call: 'child' },
      childWorkflow,
      ...createCallAttempt('delegate', childWorkflow.name),
      childProviderInfo: { provider: 'mock', model: 'child-model', providerSource: 'workflow_call', modelSource: 'workflow_call' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    } as never;

    await executor.execute(request, { syncParentState: true });
    await executor.execute({
      ...request,
      step: { ...request.step, name: 'delegate-other' },
      ...createCallAttempt('delegate-other', childWorkflow.name),
    }, { syncParentState: true });

    expect(createdOptions[0]?.autoRoutingEstimator).toBe(parentEstimator);
    expect(createdOptions[1]?.autoRoutingEstimator).toBe(parentEstimator);
    expect(createdOptions[0]?.routingRuntime).not.toBe(createdOptions[1]?.routingRuntime);
    expect(createdOptions[0]?.initialUserInputs).toEqual(['Retry the remaining task work']);
    expect(createWorkRequirementEstimatorMock).not.toHaveBeenCalled();
  });

  it('Given a child with its own auto routing and an injected estimator, When creating its child engine, Then it reuses the injected estimator', async () => {
    const parentWorkflow = { name: 'parent', steps: [] } as never;
    const childAutoRouting = createAutoRoutingConfig('child-router-model');
    const childWorkflow = {
      name: 'child',
      autoRouting: childAutoRouting,
      steps: [],
    } as never;
    const parentEstimator: WorkRequirementEstimator = { estimate: vi.fn() };
    const createdOptions: Array<Record<string, unknown>> = [];
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentWorkflow,
      getOptions: () => ({
        projectCwd: '/project',
        provider: 'mock',
        autoRouting: createAutoRoutingConfig('parent-router-model'),
        autoRoutingEstimator: parentEstimator,
        autoRoutingEstimatorSource: 'injected',
      }),
      getCwd: () => '/project',
      projectCwd: '/project',
      task: 'Complete the task',
      sharedRuntime: { startedAtMs: 0 },
      resumeStackPrefix: [],
      runPaths: { slug: 'run' },
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn((_config, _cwd, _task, options) => {
        createdOptions.push(options as Record<string, unknown>);
        return {
          on: vi.fn(),
          getOwnedResumePoint: vi.fn(ownedResumePoint),
          runWithResult: vi.fn().mockResolvedValue({
            state: {
              iteration: 1,
              personaSessions: new Map(),
              status: 'completed',
            },
          }),
        };
      }),
      emit: vi.fn(),
      state: {
        iteration: 1,
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', 1]]),
        userInputs: [],
      },
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    } as never);

    await executor.execute({
      step: { name: 'delegate', kind: 'workflow_call', call: 'child' },
      childWorkflow,
      ...createCallAttempt('delegate', childWorkflow.name),
      childProviderInfo: { provider: 'mock', model: 'child-model', providerSource: 'workflow_call', modelSource: 'workflow_call' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    } as never, { syncParentState: true });

    expect(createdOptions[0]?.autoRouting).toBe(childAutoRouting);
    expect(createdOptions[0]?.autoRoutingEstimator).toBe(parentEstimator);
    expect(createWorkRequirementEstimatorMock).not.toHaveBeenCalled();
  });

  it('Given an engine-generated parent estimator and child routing, When creating its child engine, Then it creates a child-specific estimator', async () => {
    const parentWorkflow = { name: 'parent', steps: [] } as never;
    const childAutoRouting = createAutoRoutingConfig('child-router-model');
    const parentEstimator: WorkRequirementEstimator = { estimate: vi.fn() };
    const createdOptions: Array<Record<string, unknown>> = [];
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentWorkflow,
      getOptions: () => ({
        projectCwd: '/project',
        provider: 'mock',
        autoRouting: createAutoRoutingConfig('parent-router-model'),
        autoRoutingEstimator: parentEstimator,
        autoRoutingEstimatorSource: 'engine-default',
      }),
      getCwd: () => '/project',
      projectCwd: '/project',
      task: 'Complete the task',
      sharedRuntime: { startedAtMs: 0 },
      resumeStackPrefix: [],
      runPaths: { slug: 'run' },
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn((_config, _cwd, _task, options) => {
        createdOptions.push(options as Record<string, unknown>);
        return {
          on: vi.fn(),
          getOwnedResumePoint: vi.fn(ownedResumePoint),
          runWithResult: vi.fn().mockResolvedValue({
            state: { iteration: 1, personaSessions: new Map(), status: 'completed' },
          }),
        };
      }),
      emit: vi.fn(),
      state: { iteration: 1, personaSessions: new Map(), stepIterations: new Map([['delegate', 1]]), userInputs: [] },
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    } as never);

    await executor.execute({
      step: { name: 'delegate', kind: 'workflow_call', call: 'child' },
      childWorkflow: { name: 'child', autoRouting: childAutoRouting, steps: [] },
      ...createCallAttempt('delegate', 'child'),
      childProviderInfo: { provider: 'mock', model: 'child-model', providerSource: 'workflow_call', modelSource: 'workflow_call' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    } as never, { syncParentState: true });

    expect(createdOptions[0]?.autoRoutingEstimator).not.toBe(parentEstimator);
    expect(createWorkRequirementEstimatorMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'mock',
      model: 'child-router-model',
    }));
  });
});
