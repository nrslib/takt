import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import type { WorkRequirementEstimator } from '../core/workflow/auto-routing/contracts.js';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { buildWorkflowCallNamespaceSegment } from '../core/workflow/workflow-call-namespace.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';

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

const { createWorkRequirementEstimatorMock } = vi.hoisted(() => ({
  createWorkRequirementEstimatorMock: vi.fn(),
}));

vi.mock('../agents/auto-routing-usecase.js', () => ({
  createWorkRequirementEstimator: createWorkRequirementEstimatorMock,
}));

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

describe('WorkflowCallExecutor routing runtime', () => {
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
