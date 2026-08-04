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
import type {
  WorkflowCallChildEngine,
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
} from '../core/workflow/types.js';

function makeState(workflowName: string, stepName: string): WorkflowState {
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
    stepIterations: new Map([[stepName, 1]]),
    dynamicParallelSelections: new Map(),
    resumedDynamicParallelSteps: new Set(),
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
    refreshFindingsState: vi.fn(),
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

  it('should reject a runtime call-stack mismatch instead of ignoring the persisted path', async () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'review', [
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    const callStack = [makeRuntimeCallEntry('default', 'delegate')];
    const restartPoint = {
      stack: [
        {
          workflow: 'other-root',
          workflow_ref: 'other-root',
          step: 'delegate',
          kind: 'workflow_call' as const,
          call_instance: 1,
        },
        { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' as const },
      ],
    };
    const state = makeState('default', 'delegate');
    const { executor, createEngine } = makeExecutor({
      parent,
      state,
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await expect(executor.execute(
      makeRequest(executor, { step, child, callStack }),
      { syncParentState: true },
    )).rejects.toThrow(/restart.*other-root|other-root.*restart/i);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('should reject a runtime call instance that differs from the selected restart invocation', async () => {
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
      state: makeState('default', 'delegate'),
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await expect(executor.execute(
      makeRequest(executor, {
        step,
        child,
        callStack: [makeRuntimeCallEntry('default', 'delegate', 2)],
      }),
      { syncParentState: true },
    )).rejects.toThrow(/prepared occurrence does not match execution state/i);
    expect(createEngine).not.toHaveBeenCalled();
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
