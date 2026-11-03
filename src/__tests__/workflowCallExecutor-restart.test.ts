import { describe, expect, it, vi } from 'vitest';
import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePointEntry,
  WorkflowState,
} from '../core/models/index.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { WorkflowRestartNavigator } from '../core/workflow/engine/WorkflowRestartNavigator.js';
import {
  restoreWorkflowCallInvocationEvidence,
  WorkflowCallInvocationIndex,
} from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import { DebugLogger } from '../shared/utils/debug.js';
import type {
  WorkflowCallChildEngine,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../core/workflow/types.js';

function makeState(workflowName: string, stepName: string, occurrence = 1): WorkflowState {
  return {
    workflowName,
    currentStep: stepName,
    iteration: 0,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map([[stepName, occurrence]]),
    dynamicParallelSelections: new Map(),
    status: 'running',
  };
}

function makeChildEngine(workflow: WorkflowConfig): WorkflowCallChildEngine {
  const state = makeState(workflow.name, workflow.initialStep);
  state.iteration = 1;
  state.status = 'completed';
  return {
    on: vi.fn(),
    runWithResult: vi.fn().mockResolvedValue({ state }),
  };
}

function makeCallStep(name: string, call: string): WorkflowCallStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    instruction: `${name} instruction`,
  };
}

function makeRuntimeCallEntry(
  workflow: string,
  step: string,
  callInstance = 1,
  stepIterations?: Record<string, number>,
): WorkflowResumePointEntry {
  return {
    workflow,
    workflow_ref: workflow,
    step,
    kind: 'workflow_call',
    occurrence: callInstance,
    call_instance: callInstance,
    ...(stepIterations === undefined ? {} : { step_iterations: stepIterations }),
  };
}

function makeWorkflow(
  name: string,
  initialStep: string,
  steps: WorkflowConfig['steps'],
): WorkflowConfig {
  return {
    name,
    initialStep,
    maxSteps: 10,
    steps,
  };
}

function makeExecutor(options: {
  parent: WorkflowConfig;
  state: WorkflowState;
  restartPoint: WorkflowRestartPoint;
  childEngine: WorkflowCallChildEngine;
  sharedRuntime?: WorkflowSharedRuntimeState;
  engineOwnsRestartPoint?: boolean;
}) {
  const createEngine = vi.fn().mockReturnValue(options.childEngine);
  const sharedRuntime = options.sharedRuntime ?? {
    startedAtMs: Date.now(),
    restartNavigator: new WorkflowRestartNavigator(options.restartPoint),
  };
  const executor = new WorkflowCallExecutor({
    getConfig: () => options.parent,
    getMaxSteps: () => options.parent.maxSteps,
    updateMaxSteps: vi.fn(),
    getOptions: (): WorkflowEngineOptions => ({
      projectCwd: '/project',
      reportDirName: 'run',
      ...(options.engineOwnsRestartPoint === false ? {} : { restartPoint: options.restartPoint }),
    }),
    getCwd: () => '/project/worktree',
    projectCwd: '/project',
    task: 'restart nested workflow',
    sharedRuntime,
    resumeStackPrefix: [],
    consumeWorkflowCallContinuation: vi.fn(),
    runPaths: { slug: 'run' } as never,
    resolveWorkflowCall: vi.fn(),
    createEngine,
    emit: vi.fn(),
    state: options.state,
    setActiveResumePoint: vi.fn(),
    setActiveResumeStack: vi.fn(),
    adoptResumeCheckpoint: vi.fn(),
  });
  return { executor, createEngine, sharedRuntime };
}

function makeRequest(executor: WorkflowCallExecutor, options: {
  step: WorkflowCallStep;
  child: WorkflowConfig;
  callStack: WorkflowResumePointEntry[];
}) {
  const currentFrame = options.callStack.at(-1);
  if (currentFrame?.kind !== 'workflow_call' || currentFrame.call_instance === undefined) {
    throw new Error('Workflow-call executor test requires a current workflow_call frame');
  }
  const resumeStackPrefix = options.callStack.slice(0, -1);
  executor.recordPendingInvocation(
    options.step,
    currentFrame.call_instance,
    resumeStackPrefix,
  );
  return {
    step: options.step,
    preparedExecution: executor.prepare(
      options.step,
      options.child,
      currentFrame.call_instance,
      resumeStackPrefix,
    ),
    childProviderInfo: { provider: 'mock' as const, model: 'test-model' },
    parentProviderOptions: undefined,
    personaProviders: undefined,
    providerRouting: undefined,
  };
}

async function executeTerminalChildRestart() {
  const step = makeCallStep('delegate', 'coding');
  const parent = makeWorkflow('default', 'delegate', [step]);
  const child = makeWorkflow('coding', 'implement', [
    { name: 'implement', persona: 'coder', instruction: 'Implement' },
    { name: 'review', persona: 'reviewer', instruction: 'Review' },
  ]);
  const callStack = [makeRuntimeCallEntry('default', 'delegate', 1, { delegate: 1 })];
  const restartPoint = {
    stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call' as const, call_instance: 1 as const },
      { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' as const },
    ],
  };
  const execution = makeExecutor({
    parent,
    state: makeState('default', 'delegate'),
    restartPoint,
    childEngine: makeChildEngine(child),
  });

  await execution.executor.execute(
    makeRequest(execution.executor, { step, child, callStack }),
    { syncParentState: true },
  );

  return { callStack, restartPoint, ...execution };
}

async function executeNestedWorkflowCallRestart() {
  const step = makeCallStep('delegate-review', 'review-loop');
  const parent = makeWorkflow('coding', 'implement', [
    { name: 'implement', persona: 'coder', instruction: 'Implement' },
    step,
  ]);
  const grandchild = makeWorkflow('review-loop', 'plan', [
    { name: 'plan', persona: 'planner', instruction: 'Plan review' },
    { name: 'review', persona: 'reviewer', instruction: 'Review' },
  ]);
  const callStack = [
    makeRuntimeCallEntry('default', 'delegate'),
    makeRuntimeCallEntry('coding', 'delegate-review', 1, { 'delegate-review': 1 }),
  ];
  const restartPoint = {
    stack: callStack.map(({ occurrence: _occurrence, step_iterations: _stepIterations, ...entry }) => ({
      ...entry,
      workflow_ref: entry.workflow,
      call_instance: 1 as const,
    })),
  };
  const rootStep = makeCallStep('delegate', 'coding');
  const rootExecution = makeExecutor({
    parent: makeWorkflow('default', 'delegate', [rootStep]),
    state: makeState('default', 'delegate'),
    restartPoint,
    childEngine: makeChildEngine(parent),
  });

  await rootExecution.executor.execute(
    makeRequest(rootExecution.executor, { step: rootStep, child: parent, callStack: callStack.slice(0, 1) }),
    { syncParentState: true },
  );

  return { step, parent, grandchild, callStack, restartPoint, rootExecution };
}

async function consumeNestedWorkflowCallRestart() {
  const scenario = await executeNestedWorkflowCallRestart();
  const childExecution = makeExecutor({
    parent: scenario.parent,
    state: makeState('coding', 'delegate-review'),
    restartPoint: scenario.restartPoint,
    childEngine: makeChildEngine(scenario.grandchild),
    sharedRuntime: scenario.rootExecution.sharedRuntime,
    engineOwnsRestartPoint: false,
  });

  await childExecution.executor.execute(
    makeRequest(childExecution.executor, {
      step: scenario.step,
      child: scenario.grandchild,
      callStack: scenario.callStack,
    }),
    { syncParentState: true },
  );

  return { ...scenario, childExecution };
}

describe('WorkflowCallExecutor nested restart contract', () => {
  it.each([
    { updatedRef: true, occurrence: 1 },
    { updatedRef: false, occurrence: 2 },
  ])('rebinds selected restart participation with ref change=$updatedRef and occurrence=$occurrence', ({ updatedRef, occurrence }) => {
    const step = makeCallStep('delegate', 'coding');
    const oldRef = updatedRef ? 'old-parent' : 'same-parent';
    const currentRef = updatedRef ? 'new-parent' : 'same-parent';
    const oldParent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), oldRef);
    const parent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), currentRef);
    const child = makeWorkflow('coding', 'reviewers', [{ name: 'reviewers', persona: 'reviewer', instruction: 'Review' }]);
    const oldCall = { ...makeRuntimeCallEntry('default', 'delegate', 1), workflow_ref: oldRef };
    const namespace = buildWorkflowCallSiteIdentity({ stack: [oldCall], childWorkflow: child }).runPathSegment;
    const sourceIndex = new WorkflowCallInvocationIndex(new Map());
    sourceIndex.record(oldParent, step.name, [], { call_instance: 1, report_namespace_segment: namespace, completed: true });
    const participation = new WorkflowStepParticipationIndex(new Map());
    participation.record(child, 'reviewers', [oldCall], ['plan.md']);
    const source = {
      version: 2 as const,
      stack: [{ ...oldCall, step: 'stopped', kind: 'agent' as const }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: sourceIndex.serialized(),
      workflow_step_participations: participation.serialized(),
    };
    const restartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: currentRef, step: 'delegate', kind: 'workflow_call' as const, call_instance: 1 as const },
        { workflow: 'coding', workflow_ref: 'coding', step: 'reviewers', kind: 'agent' as const },
      ],
    };
    const execution = makeExecutor({
      parent,
      state: makeState('default', 'delegate', occurrence),
      restartPoint,
      childEngine: makeChildEngine(child),
      sharedRuntime: {
        startedAtMs: Date.now(),
        restartNavigator: new WorkflowRestartNavigator(restartPoint),
        resumeInvocationSource: source,
        workflowCallInvocationEvidence: restoreWorkflowCallInvocationEvidence(source),
        workflowStepParticipationIndex: participation,
      },
    });

    execution.executor.recordPendingInvocation(step, occurrence, []);

    const currentCall = { ...makeRuntimeCallEntry('default', 'delegate', occurrence), workflow_ref: currentRef };
    expect(participation.get(child, 'reviewers', [currentCall])).toEqual({ report_names: ['plan.md'] });
    expect(participation.get(child, 'reviewers', [oldCall])).toBeUndefined();
  });

  it('rebinds nested records for the matching ancestor and current invocation instance', () => {
    const root = makeWorkflow('outer', 'call', [makeCallStep('call', 'default')]);
    const oldParent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [makeCallStep('delegate', 'coding')]), 'old-parent');
    const parent = attachWorkflowOpaqueRef({ ...oldParent }, 'new-parent');
    const child = makeWorkflow('coding', 'review', [{ name: 'review', persona: 'reviewer', instruction: 'Review' }]);
    const sourceIndex = new WorkflowCallInvocationIndex(new Map());
    const prefix = makeRuntimeCallEntry('outer', 'call', 1);
    sourceIndex.record(root, 'call', [], { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: [prefix], childWorkflow: oldParent }).runPathSegment });
    const record = { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: [prefix, makeRuntimeCallEntry('default', 'delegate')], childWorkflow: child }).runPathSegment };
    sourceIndex.record(oldParent, 'delegate', [prefix], record);
    const source = { version: 2 as const, stack: [{ ...prefix, step: 'stopped', kind: 'agent' as const }], iteration: 1, elapsed_ms: 0, workflow_call_invocations: sourceIndex.serialized(), workflow_step_participations: {} };
    const index = new WorkflowCallInvocationIndex(new Map(Object.entries(source.workflow_call_invocations)));
    index.rebindResumeInvocation(source, parent, 'delegate', [{ ...prefix, occurrence: 2, call_instance: 2 }], 1, true);
    expect(index.get(parent, 'delegate', [prefix])).toBeUndefined();
    index.rebindResumeInvocation(source, parent, 'delegate', [prefix], 2, true);
    expect(index.get(parent, 'delegate', [prefix])).toEqual({ ...record, call_instance: 2 });
  });
  it('rebinds a completed sibling only for an active restart', () => {
    const step = makeCallStep('delegate', 'coding');
    const oldParent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), 'old-parent');
    const parent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), 'new-parent');
    const child = makeWorkflow('coding', 'review', [{ name: 'review', persona: 'reviewer', instruction: 'Review' }]);
    const frame = { ...makeRuntimeCallEntry('default', 'delegate'), workflow_ref: 'old-parent' };
    const record = { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: [frame], childWorkflow: child }).runPathSegment, completed: true };
    const sourceIndex = new WorkflowCallInvocationIndex(new Map());
    sourceIndex.record(oldParent, step.name, [], record);
    const source = { version: 2 as const, stack: [{ ...frame, step: 'stopped', kind: 'agent' as const }], iteration: 1, elapsed_ms: 0, workflow_call_invocations: sourceIndex.serialized(), workflow_step_participations: {} };
    const index = new WorkflowCallInvocationIndex(new Map(Object.entries(source.workflow_call_invocations)));
    index.rebindResumeInvocation(source, parent, step.name, [], 1, false);
    expect(index.get(parent, step.name, [])).toBeUndefined();
    index.rebindResumeInvocation(source, parent, step.name, [], 2, true);
    expect(index.get(parent, step.name, [])).toEqual({ ...record, call_instance: 2 });
  });
  it('rebinds a saved invocation only for the matching ancestor instance', () => {
    const step = makeCallStep('delegate', 'coding');
    const oldParent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), 'old-parent');
    const parent = attachWorkflowOpaqueRef(makeWorkflow('default', 'delegate', [step]), 'new-parent');
    const child = makeWorkflow('coding', 'review', [{ name: 'review', persona: 'reviewer', instruction: 'Review' }]);
    const oldPrefix = { ...makeRuntimeCallEntry('outer', 'call', 2), workflow_ref: 'old-outer' };
    const currentPrefix = { ...oldPrefix, workflow_ref: 'new-outer' };
    const frame = { ...makeRuntimeCallEntry('default', 'delegate'), workflow_ref: 'old-parent' };
    const record = { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: [oldPrefix, frame], childWorkflow: child }).runPathSegment };
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(oldParent, step.name, [oldPrefix], record);
    const source = { version: 2 as const, stack: [oldPrefix, frame], iteration: 1, elapsed_ms: 0, workflow_call_invocations: index.serialized(), workflow_step_participations: {} };
    index.rebindResumeInvocation(source, parent, step.name, [{ ...currentPrefix, occurrence: 1, call_instance: 1 }], 1, false);
    expect(index.get(parent, step.name, [currentPrefix])).toBeUndefined();
    index.rebindResumeInvocation(source, parent, step.name, [currentPrefix], 1, false);
    expect(index.get(parent, step.name, [currentPrefix])).toEqual(record);
    expect(index.get(oldParent, step.name, [oldPrefix])).toBeUndefined();
  });
  it.each([true, false])('warns about a call-site digest mismatch only when digests differ: %s', (mismatch) => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [{ name: 'review', persona: 'reviewer', instruction: 'Review' }]);
    const restartPoint: WorkflowRestartPoint = { stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
    ] };
    const callStack = [makeRuntimeCallEntry('default', 'delegate')];
    const savedChild = mismatch ? attachWorkflowOpaqueRef({ ...child }, 'old-child-ref') : child;
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(parent, step.name, [], { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: callStack, childWorkflow: savedChild }).runPathSegment });
    const execution = makeExecutor({ parent, state: makeState('default', 'delegate'), restartPoint, childEngine: makeChildEngine(child),
      sharedRuntime: { startedAtMs: Date.now(), restartNavigator: new WorkflowRestartNavigator(restartPoint), workflowCallInvocationEvidence: { kind: 'exact', index } } });
    const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    try {
      makeRequest(execution.executor, { step, child, callStack });
      const warnings = writeLog.mock.calls.filter(([level]) => level === 'WARN');
      expect(warnings.length > 0).toBe(mismatch);
      if (mismatch) expect(JSON.stringify(warnings)).toMatch(/workflow|digest|hash|site/i);
    } finally {
      writeLog.mockRestore();
    }
  });

  it('reuses the saved invocation namespace when the child definition changes', async () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    const restartPoint: WorkflowRestartPoint = { stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
    ] };
    const oldChild = attachWorkflowOpaqueRef({ ...child }, 'old-child-ref');
    const saved = { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({
      stack: [makeRuntimeCallEntry('default', 'delegate')], childWorkflow: oldChild,
    }).runPathSegment };
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(parent, step.name, [], saved);
    const execution = makeExecutor({
      parent, state: makeState('default', 'delegate'), restartPoint, childEngine: makeChildEngine(child),
      sharedRuntime: { startedAtMs: Date.now(), restartNavigator: new WorkflowRestartNavigator(restartPoint), workflowCallInvocationEvidence: { kind: 'exact', index } },
    });
    const request = makeRequest(execution.executor, { step, child, callStack: [makeRuntimeCallEntry('default', 'delegate')] });
    await execution.executor.execute(request, { syncParentState: true });
    expect(execution.createEngine).toHaveBeenCalledWith(child, expect.any(String), expect.any(String),
      expect.objectContaining({ runPathNamespace: ['subworkflows', saved.report_namespace_segment] }));
    execution.executor.markCompletedInvocation(request.preparedExecution);
    expect(index.get(parent, step.name, [])).toEqual({ ...saved, completed: true });
  });

  it('rejects a saved invocation namespace whose iteration differs from the execution occurrence', () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    const restartPoint: WorkflowRestartPoint = { stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 2 },
      { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
    ] };
    const oldChild = attachWorkflowOpaqueRef({ ...child }, 'old-child-ref');
    const saved = { call_instance: 2, report_namespace_segment: buildWorkflowCallSiteIdentity({
      stack: [makeRuntimeCallEntry('default', 'delegate', 1)], childWorkflow: oldChild,
    }).runPathSegment };
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(parent, step.name, [], saved);
    const execution = makeExecutor({
      parent, state: makeState('default', 'delegate', 2), restartPoint, childEngine: makeChildEngine(child),
      sharedRuntime: { startedAtMs: Date.now(), restartNavigator: new WorkflowRestartNavigator(restartPoint), workflowCallInvocationEvidence: { kind: 'exact', index } },
    });

    expect(() => makeRequest(execution.executor, {
      step, child, callStack: [makeRuntimeCallEntry('default', 'delegate', 2)],
    })).toThrow('invocation record does not match the canonical call site');
    expect(index.get(parent, step.name, [])).toEqual(saved);
  });

  it('selects the saved invocation for the matching ancestor instance', () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [{ name: 'review', persona: 'reviewer', instruction: 'Review' }]);
    const oldChild = attachWorkflowOpaqueRef({ ...child }, 'old-child-ref');
    const index = new WorkflowCallInvocationIndex(new Map());
    const records = [1, 2].map((instance) => {
      const prefix = [makeRuntimeCallEntry('outer', 'call', instance)];
      const record = { call_instance: 1, report_namespace_segment: buildWorkflowCallSiteIdentity({
        stack: [...prefix, makeRuntimeCallEntry('default', 'delegate')], childWorkflow: oldChild,
      }).runPathSegment };
      index.record(parent, step.name, prefix, record);
      return { prefix, record };
    });
    const restartPoint: WorkflowRestartPoint = { stack: [
      { workflow: 'outer', workflow_ref: 'outer', step: 'call', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
    ] };
    const execution = makeExecutor({ parent, state: makeState('default', 'delegate'), restartPoint, childEngine: makeChildEngine(child),
      sharedRuntime: { startedAtMs: Date.now(), workflowCallInvocationEvidence: { kind: 'exact', index } } });
    const selected = records[1]!;
    const request = makeRequest(execution.executor, { step, child, callStack: [...selected.prefix, makeRuntimeCallEntry('default', 'delegate')] });
    expect(request.preparedExecution.invocation).toEqual(selected.record);
    expect(request.preparedExecution.invocation.report_namespace_segment).not.toBe(records[0]!.record.report_namespace_segment);
  });

  it('starts the selected child step after workflow references change', () => {
    const navigator = new WorkflowRestartNavigator({ stack: [
      { workflow: 'default', workflow_ref: 'old-root', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'coding', workflow_ref: 'old-child', step: 'review', kind: 'agent' },
    ] });
    const root = makeWorkflow('default', 'delegate', [makeCallStep('delegate', 'coding')]);
    const child = makeWorkflow('coding', 'plan', [
      { name: 'plan', persona: 'planner', instruction: 'Plan' },
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    expect(navigator.resolveRootStartStep(root, undefined)).toBe('delegate');
    expect(navigator.resolveChildStartStep(child, [makeRuntimeCallEntry('default', 'delegate')])).toBe('review');
  });

  it('rejects a changed child workflow name even when its ref matches', () => {
    const navigator = new WorkflowRestartNavigator({ stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
    ] });
    const root = makeWorkflow('default', 'delegate', [makeCallStep('delegate', 'coding')]);
    const child = attachWorkflowOpaqueRef(makeWorkflow('other', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]), 'coding');
    expect(navigator.resolveRootStartStep(root, undefined)).toBe('delegate');

    expect(() => navigator.resolveChildStartStep(child, [makeRuntimeCallEntry('default', 'delegate')]))
      .toThrow('does not match child workflow "other"');
  });

  it('should consume a terminal authored system step when resolving the root start', () => {
    const restartPoint: WorkflowRestartPoint = {
      stack: [{ workflow: 'default', workflow_ref: 'default', step: 'checkpoint', kind: 'system' }],
    };
    const navigator = new WorkflowRestartNavigator(restartPoint);
    const root = makeWorkflow('default', 'before', [{
      name: 'checkpoint',
      kind: 'system',
      personaDisplayName: 'checkpoint',
      instruction: 'Checkpoint',
    }]);

    const startStep = navigator.resolveRootStartStep(root, undefined);

    expect(startStep).toBe('checkpoint');
    expect(navigator.isActive()).toBe(false);
  });

  it('should start the child at the selected authored step when a terminal child step is selected', async () => {
    const execution = await executeTerminalChildRestart();

    expect(execution.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'coding' }),
      '/project/worktree',
      'restart nested workflow',
      expect.objectContaining({
        startStep: 'review',
        initialIteration: 0,
      }),
    );
    const childOptions = execution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(childOptions.resumePoint).toBeUndefined();
    expect(childOptions.restartPoint).toBeUndefined();
    expect(execution.sharedRuntime.restartNavigator?.isActive()).toBe(false);
  });

  it('should omit restart state when a nested call runs after the terminal child path is consumed', async () => {
    const execution = await executeTerminalChildRestart();

    const publish = makeCallStep('publish', 'publisher');
    const publisher = makeWorkflow('publisher', 'release', [
      { name: 'release', persona: 'publisher', instruction: 'Publish' },
    ]);
    const childExecution = makeExecutor({
      parent: makeWorkflow('coding', 'publish', [publish]),
      state: makeState('coding', 'publish'),
      restartPoint: execution.restartPoint,
      childEngine: makeChildEngine(publisher),
      sharedRuntime: execution.sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await childExecution.executor.execute(
      makeRequest(childExecution.executor, {
        step: publish,
        child: publisher,
        callStack: [
          execution.callStack[0]!,
          makeRuntimeCallEntry('coding', 'publish'),
        ],
      }),
      { syncParentState: true },
    );
    const publishOptions = childExecution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(publishOptions.startStep).toBeUndefined();
    expect(publishOptions.restartPoint).toBeUndefined();
  });

  it('should leave a root sibling call unaffected when the terminal child path is consumed', async () => {
    const execution = await executeTerminalChildRestart();

    const rootSibling = makeCallStep('notify', 'notifier');
    const notifier = makeWorkflow('notifier', 'send', [
      { name: 'send', persona: 'notifier', instruction: 'Notify' },
    ]);
    const rootSiblingExecution = makeExecutor({
      parent: makeWorkflow('default', 'notify', [rootSibling]),
      state: makeState('default', 'notify'),
      restartPoint: execution.restartPoint,
      childEngine: makeChildEngine(notifier),
      sharedRuntime: execution.sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await rootSiblingExecution.executor.execute(
      makeRequest(rootSiblingExecution.executor, {
        step: rootSibling,
        child: notifier,
        callStack: [makeRuntimeCallEntry('default', 'notify')],
      }),
      { syncParentState: true },
    );
    expect(rootSiblingExecution.createEngine).toHaveBeenCalledOnce();
  });

  it('should resolve the nested workflow_call as the child start when the path continues', async () => {
    const execution = await executeNestedWorkflowCallRestart();

    const codingOptions = execution.rootExecution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(codingOptions.startStep).toBe('delegate-review');
    expect(execution.rootExecution.sharedRuntime.restartNavigator?.isActive()).toBe(true);
  });

  it('should use the grandchild initial step when the path ends at a nested workflow_call', async () => {
    const execution = await consumeNestedWorkflowCallRestart();

    const childOptions = execution.childExecution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(childOptions.startStep).toBeUndefined();
    expect(childOptions.resumePoint).toBeUndefined();
    expect(childOptions.restartPoint).toBeUndefined();
    expect(execution.rootExecution.sharedRuntime.restartNavigator?.isActive()).toBe(false);
  });

  it('should leave a grandchild sibling call unaffected when the nested call path is consumed', async () => {
    const execution = await consumeNestedWorkflowCallRestart();

    const archive = makeCallStep('archive', 'archive-workflow');
    const archiveWorkflow = makeWorkflow('archive-workflow', 'store', [
      { name: 'store', persona: 'archiver', instruction: 'Archive' },
    ]);
    const grandchildExecution = makeExecutor({
      parent: makeWorkflow('review-loop', 'archive', [archive]),
      state: makeState('review-loop', 'archive'),
      restartPoint: execution.restartPoint,
      childEngine: makeChildEngine(archiveWorkflow),
      sharedRuntime: execution.rootExecution.sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await grandchildExecution.executor.execute(
      makeRequest(grandchildExecution.executor, {
        step: archive,
        child: archiveWorkflow,
        callStack: [
          execution.callStack[0]!,
          execution.callStack[1]!,
          makeRuntimeCallEntry('review-loop', 'archive'),
        ],
      }),
      { syncParentState: true },
    );
    expect(grandchildExecution.createEngine).toHaveBeenCalledOnce();
  });

  it('should consume a restart path when an authored system step becomes the child start', () => {
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'coding', step: 'checkpoint', kind: 'system' },
      ],
    };
    const navigator = new WorkflowRestartNavigator(restartPoint);
    const child = makeWorkflow('coding', 'checkpoint', [{
      name: 'checkpoint',
      kind: 'system',
      personaDisplayName: 'checkpoint',
      instruction: 'Checkpoint',
      effects: [],
    }]);

    const startStep = navigator.resolveChildStartStep(child, [restartPoint.stack[0]!]);

    expect(startStep).toBe('checkpoint');
    expect(navigator.isActive()).toBe(false);
  });

  it('should reject a nested effect-backed system restart before creating the child engine', async () => {
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'coding', step: 'publish', kind: 'system' },
      ],
    };
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'publish', [{
      name: 'publish',
      kind: 'system',
      personaDisplayName: 'publish',
      instruction: 'Publish',
      effects: [{ type: 'merge_pr', pr: 42 }],
    }]);
    const callStack = [makeRuntimeCallEntry('default', 'delegate')];
    const { executor, createEngine } = makeExecutor({
      parent,
      state: makeState('default', 'delegate'),
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await expect(executor.execute(
      makeRequest(executor, { step, child, callStack }),
      { syncParentState: true },
    )).rejects.toThrow();
    expect(createEngine).not.toHaveBeenCalled();
  });

  it.each([
    {
      mismatch: 'workflow name',
      runtimeEntry: {
        ...makeRuntimeCallEntry('default', 'delegate'),
        workflow: 'other-root',
      },
    },
    {
      mismatch: 'step',
      runtimeEntry: makeRuntimeCallEntry('default', 'other-step'),
    },
    {
      mismatch: 'kind',
      runtimeEntry: {
        ...makeRuntimeCallEntry('default', 'delegate'),
        kind: 'agent' as const,
      },
    },
  ])('should reject a runtime call-stack $mismatch mismatch', ({ runtimeEntry }) => {
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
      ],
    };
    const navigator = new WorkflowRestartNavigator(restartPoint);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);

    expect(() => navigator.resolveChildStartStep(child, [runtimeEntry])).toThrow(
      'Runtime workflow_call stack does not match restart path',
    );
    expect(navigator.isActive()).toBe(true);
  });

  it('should continue from the selected restart step when call_instance differs', async () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
        { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' },
      ],
    };
    const { executor, createEngine } = makeExecutor({
      parent,
      state: makeState('default', 'delegate', 2),
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await executor.execute(
      makeRequest(executor, {
        step,
        child,
        callStack: [makeRuntimeCallEntry('default', 'delegate', 2)],
      }),
      { syncParentState: true },
    );

    expect(createEngine).toHaveBeenCalledWith(
      child,
      '/project/worktree',
      'restart nested workflow',
      expect.objectContaining({
        startStep: 'review',
        initialIteration: 0,
      }),
    );
  });

  it('should reject a runtime call stack that exceeds an active selected path', () => {
    const restartPoint: WorkflowRestartPoint = {
      stack: [{ workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', call_instance: 1 }],
    };
    const navigator = new WorkflowRestartNavigator(restartPoint);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);

    expect(() => navigator.resolveChildStartStep(child, [
      makeRuntimeCallEntry('default', 'delegate'),
      makeRuntimeCallEntry('coding', 'nested'),
    ])).toThrow(/exceeds/i);
    expect(navigator.isActive()).toBe(true);
  });
});
