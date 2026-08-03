import { describe, expect, it, vi } from 'vitest';
import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
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
import { WorkflowStepBudget } from '../core/workflow/workflow-step-budget.js';

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

function makeOwnedResumePoint(workflowName: string, step: string): WorkflowResumePoint {
  return {
    version: 2,
    stack: [{ workflow: workflowName, step, kind: 'agent' }],
    iteration: 1,
    elapsed_ms: 0,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function makeChildEngine(workflow: WorkflowConfig): WorkflowCallChildEngine {
  const state = makeState(workflow.name, workflow.initialStep);
  state.iteration = 1;
  state.status = 'completed';
  return {
    on: vi.fn(),
    runWithResult: vi.fn().mockResolvedValue({ state }),
    getOwnedResumePoint: vi.fn(() => makeOwnedResumePoint(workflow.name, workflow.initialStep)),
  };
}

function makeCallStep(name: string, call: string): WorkflowCallStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    instruction: `${name} instruction`,
  } as WorkflowCallStep;
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
    stepBudget: new WorkflowStepBudget(10),
    restartNavigator: new WorkflowRestartNavigator(options.restartPoint),
  };
  const executor = new WorkflowCallExecutor({
    getConfig: () => options.parent,
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

function makeRequest(options: {
  step: WorkflowCallStep;
  child: WorkflowConfig;
  callStack: WorkflowResumePointEntry[];
}) {
  return {
    step: options.step,
    childWorkflow: options.child,
    reportNamespaceSegment: 'call-v2-test',
    callStack: options.callStack,
    childProviderInfo: { provider: 'mock' as const, model: 'test-model' },
    parentProviderOptions: undefined,
    personaProviders: undefined,
    providerRouting: undefined,
  };
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

  it('should start the child at the selected authored step without restoring checkpoint state', async () => {
    const step = makeCallStep('delegate', 'coding');
    const parent = makeWorkflow('default', 'delegate', [step]);
    const child = makeWorkflow('coding', 'implement', [
      { name: 'implement', persona: 'coder', instruction: 'Implement' },
      { name: 'review', persona: 'reviewer', instruction: 'Review' },
    ]);
    const callStack = [{
      workflow: 'default',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 1,
      step_iterations: { delegate: 1 },
    }];
    const restartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call' as const, call_instance: 1 as const },
        { workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent' as const },
      ],
    };
    const state = makeState('default', 'delegate');
    const { executor, createEngine, sharedRuntime } = makeExecutor({
      parent,
      state,
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await executor.execute(
      makeRequest({ step, child, callStack }),
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
    const childOptions = createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(childOptions.resumePoint).toBeUndefined();
    expect(childOptions.restartPoint).toBeUndefined();
    expect(sharedRuntime.restartNavigator?.isActive()).toBe(false);

    const publish = makeCallStep('publish', 'publisher');
    const publisher = makeWorkflow('publisher', 'release', [
      { name: 'release', persona: 'publisher', instruction: 'Publish' },
    ]);
    const childExecution = makeExecutor({
      parent: makeWorkflow('coding', 'publish', [publish]),
      state: makeState('coding', 'publish'),
      restartPoint,
      childEngine: makeChildEngine(publisher),
      sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await childExecution.executor.execute(
      makeRequest({
        step: publish,
        child: publisher,
        callStack: [
          callStack[0]!,
          { workflow: 'coding', step: 'publish', kind: 'workflow_call', call_instance: 1 },
        ],
      }),
      { syncParentState: true },
    );
    const publishOptions = childExecution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(publishOptions.startStep).toBeUndefined();
    expect(publishOptions.restartPoint).toBeUndefined();

    const rootSibling = makeCallStep('notify', 'notifier');
    const notifier = makeWorkflow('notifier', 'send', [
      { name: 'send', persona: 'notifier', instruction: 'Notify' },
    ]);
    const rootSiblingExecution = makeExecutor({
      parent: makeWorkflow('default', 'notify', [rootSibling]),
      state: makeState('default', 'notify'),
      restartPoint,
      childEngine: makeChildEngine(notifier),
      sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await rootSiblingExecution.executor.execute(
      makeRequest({
        step: rootSibling,
        child: notifier,
        callStack: [{ workflow: 'default', step: 'notify', kind: 'workflow_call', call_instance: 1 }],
      }),
      { syncParentState: true },
    );
    expect(rootSiblingExecution.createEngine).toHaveBeenCalledOnce();
  });

  it('should use the grandchild initial step when the restart path ends at a nested workflow_call', async () => {
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
      {
        workflow: 'default',
        step: 'delegate',
        kind: 'workflow_call' as const,
        call_instance: 1,
      },
      {
        workflow: 'coding',
        step: 'delegate-review',
        kind: 'workflow_call' as const,
        call_instance: 1,
        step_iterations: { 'delegate-review': 1 },
      },
    ];
    const restartPoint = {
      stack: callStack.map(({ step_iterations: _stepIterations, ...entry }) => ({
        ...entry,
        workflow_ref: entry.workflow,
        call_instance: 1 as const,
      })),
    };
    const rootStep = makeCallStep('delegate', 'coding');
    const root = makeWorkflow('default', 'delegate', [rootStep]);
    const rootState = makeState('default', 'delegate');
    const rootExecution = makeExecutor({
      parent: root,
      state: rootState,
      restartPoint,
      childEngine: makeChildEngine(parent),
    });

    await rootExecution.executor.execute(
      makeRequest({ step: rootStep, child: parent, callStack: callStack.slice(0, 1) }),
      { syncParentState: true },
    );

    const codingOptions = rootExecution.createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(codingOptions.startStep).toBe('delegate-review');
    expect(rootExecution.sharedRuntime.restartNavigator?.isActive()).toBe(true);

    const state = makeState('coding', 'delegate-review');
    const { executor, createEngine } = makeExecutor({
      parent,
      state,
      restartPoint,
      childEngine: makeChildEngine(grandchild),
      sharedRuntime: rootExecution.sharedRuntime,
      engineOwnsRestartPoint: false,
    });

    await executor.execute(
      makeRequest({ step, child: grandchild, callStack }),
      { syncParentState: true },
    );

    const childOptions = createEngine.mock.calls[0]?.[3] as WorkflowEngineOptions;
    expect(childOptions.startStep).toBeUndefined();
    expect(childOptions.resumePoint).toBeUndefined();
    expect(childOptions.restartPoint).toBeUndefined();
    expect(rootExecution.sharedRuntime.restartNavigator?.isActive()).toBe(false);

    const archive = makeCallStep('archive', 'archive-workflow');
    const archiveWorkflow = makeWorkflow('archive-workflow', 'store', [
      { name: 'store', persona: 'archiver', instruction: 'Archive' },
    ]);
    const grandchildExecution = makeExecutor({
      parent: makeWorkflow('review-loop', 'archive', [archive]),
      state: makeState('review-loop', 'archive'),
      restartPoint,
      childEngine: makeChildEngine(archiveWorkflow),
      sharedRuntime: rootExecution.sharedRuntime,
      engineOwnsRestartPoint: false,
    });
    await grandchildExecution.executor.execute(
      makeRequest({
        step: archive,
        child: archiveWorkflow,
        callStack: [
          callStack[0]!,
          callStack[1]!,
          { workflow: 'review-loop', step: 'archive', kind: 'workflow_call', call_instance: 1 },
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
    const callStack = [restartPoint.stack[0]!];
    const { executor, createEngine } = makeExecutor({
      parent,
      state: makeState('default', 'delegate'),
      restartPoint,
      childEngine: makeChildEngine(child),
    });

    await expect(executor.execute(
      makeRequest({ step, child, callStack }),
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
    const callStack = [{
      workflow: 'default',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 1,
    }];
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
      makeRequest({ step, child, callStack }),
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
      makeRequest({
        step,
        child,
        callStack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 2,
        }],
      }),
      { syncParentState: true },
    )).rejects.toThrow(/does not match restart path/i);
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
      restartPoint.stack[0]!,
      { workflow: 'coding', step: 'nested', kind: 'workflow_call', call_instance: 1 },
    ])).toThrow(/exceeds/i);
    expect(navigator.isActive()).toBe(true);
  });
});
