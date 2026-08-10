import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import type { AgentResponse, FindingContractConfig, FindingLedger, WorkflowConfig, WorkflowResumePointEntry, WorkflowState, WorkflowCallStep } from '../core/models/index.js';
import type { WorkflowCallChildEngine, WorkflowRunResult, WorkflowSharedRuntimeState } from '../core/workflow/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import type { InternalAgentSeats } from '../core/models/config-types.js';

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: 'done',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeState(workflowName: string, status: WorkflowState['status'], iteration: number): WorkflowState {
  return {
    workflowName,
    currentStep: 'review',
    iteration,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map([['delegate', 1]]),
    dynamicParallelSelections: new Map(),
    status,
  };
}

function createChildEngine(result: WorkflowRunResult): WorkflowCallChildEngine {
  return {
    on: vi.fn(),
    runWithResult: vi.fn().mockResolvedValue(result),
  };
}

function createFakeLedgerStore(): FindingLedgerStore {
  return {
    workflowName: 'fake',
    loadLedger: () => ({
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    }),
    updateLedger: (mutator) => Promise.resolve(mutator({
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    })),
    saveLedgerSnapshot: () => {},
    saveRawFindings: () => {},
    saveManagerValidationReport: () => {},
  };
}

function prepareExecutionRequest(
  executor: WorkflowCallExecutor,
  request: { step: WorkflowCallStep; childWorkflow: WorkflowConfig } & Record<string, unknown>,
  occurrence: number,
  resumeStackPrefix: readonly WorkflowResumePointEntry[],
): Parameters<WorkflowCallExecutor['execute']>[0] {
  const { childWorkflow, ...executeRequest } = request;
  return {
    ...executeRequest,
    preparedExecution: executor.prepare(
      request.step,
      childWorkflow,
      occurrence,
      resumeStackPrefix,
    ),
  } as Parameters<WorkflowCallExecutor['execute']>[0];
}

const FAKE_FINDING_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
  adjudicator: { persona: 'supervisor' },
};

// opencode は model 必須。seat で provider だけを指名すると workflow の provider/model
// フォールバックが働かなくなる（internalAgentSeatOverride 参照）ため常に不正になる。
const INVALID_MANAGER_SEATS: InternalAgentSeats = {
  findingsManager: { provider: 'opencode' },
  terminalAdjudicator: { provider: 'codex', model: 'strong-adjudicator' },
};

const INVALID_ADJUDICATOR_SEATS: InternalAgentSeats = {
  findingsManager: { provider: 'codex', model: 'strong-manager' },
  terminalAdjudicator: { provider: 'opencode' },
};

describe('WorkflowCallExecutor', () => {
  it('child engine の実行オーケストレーションと state 同期を担当する', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    state.stepIterations.set('delegate', 3);
    const childState = makeState(childConfig.name, 'completed', 4);
    childState.lastOutput = makeResponse({ content: 'child complete' });
    childState.personaSessions.set('coder', 'session-2');

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const childEngine: WorkflowCallChildEngine = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      runWithResult: vi.fn().mockResolvedValue({ state: childState }),
    };
    const createEngine = vi.fn().mockReturnValue(childEngine);
    const emit = vi.fn();
    const setActiveResumePoint = vi.fn();
    const sharedRuntime: WorkflowSharedRuntimeState = { startedAtMs: Date.now(), maxSteps: 10 };
    const traceTaskMetadata = {
      taskSummary: 'Review PR #827 trace metadata',
      taskSource: 'pr_review',
      prNumber: 827,
      gitBranch: 'takt/827/add-trace-task-metadata',
      gitBaseBranch: 'main',
      worktreePath: '/tmp/project',
      runDir: '/tmp/project/.takt/runs/run',
    } as const;
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
        traceTaskMetadata,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime,
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit,
      state,
      setActiveResumePoint,
      refreshFindingsState: vi.fn(),
    });
    const recordInvocation = vi.spyOn(
      sharedRuntime.workflowCallInvocationEvidence!.index,
      'record',
    );

    await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 3, []), { syncParentState: true });

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      '/tmp/project',
      'task',
      expect.objectContaining({
        provider: 'mock',
        model: 'test-model',
        reportDirName: 'run',
        runPathNamespace: ['subworkflows', expect.stringContaining('step-delegate')],
        traceTaskMetadata,
      }),
    );
    const childOptions = createEngine.mock.calls[0]?.[3];
    expect(childOptions?.sharedRuntime).toBe(sharedRuntime);
    expect(childOptions?.traceTaskMetadata).toBe(traceTaskMetadata);
    expect(recordInvocation).toHaveBeenCalledTimes(1);
    expect(childOptions?.resumeStackPrefix).toEqual([{
      workflow: 'parent',
      workflow_ref: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
      occurrence: 3,
      step_iterations: { delegate: 3 },
      call_instance: 3,
    }]);
    expect(childEngine.on).toHaveBeenCalledWith('step:start', expect.any(Function));
    const childStep = childConfig.steps[0];
    const childProviderInfo = { provider: 'mock', model: 'test-model' };
    const childWorkflowStack = [
      {
        workflow: 'parent',
        workflow_ref: 'parent',
        step: step.name,
        kind: 'workflow_call' as const,
        occurrence: 3,
      },
      {
        workflow: childConfig.name,
        workflow_ref: childConfig.name,
        step: childStep!.name,
        kind: 'agent' as const,
        occurrence: 5,
      },
    ];
    listeners.get('step:start')?.(
      childStep,
      3,
      'child instruction',
      childProviderInfo,
      childConfig.name,
      childStep?.name,
      5,
      childWorkflowStack,
    );
    expect(emit).toHaveBeenCalledWith(
      'step:start',
      childStep,
      3,
      'child instruction',
      childProviderInfo,
      childConfig.name,
      step.name,
      5,
      childWorkflowStack,
      undefined,
      undefined,
    );
    expect(childEngine.on).toHaveBeenCalledWith('step:complete', expect.any(Function));
    const childResponse = makeResponse({ content: 'relayed response' });
    listeners.get('step:complete')?.(
      childStep,
      childResponse,
      'child instruction',
      childStep?.name,
      childWorkflowStack,
    );
    expect(emit).toHaveBeenCalledWith(
      'step:complete',
      childStep,
      childResponse,
      'child instruction',
      step.name,
      childWorkflowStack,
    );
    expect(childEngine.on).toHaveBeenCalledWith('findings:ledger', expect.any(Function));
    const ledger: FindingLedger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T02:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    };
    listeners.get('findings:ledger')?.(ledger);
    expect(emit).toHaveBeenCalledWith('findings:ledger', ledger);
    for (const eventName of [
      'companion:start',
      'companion:pool_selected',
      'companion:finding',
      'companion:fix_round',
      'companion:complete',
    ] as const) {
      expect(childEngine.on).toHaveBeenCalledWith(eventName, expect.any(Function));
      const payload = { step: 'review', marker: eventName };
      listeners.get(eventName)?.(payload);
      expect(emit).toHaveBeenCalledWith(eventName, payload);
    }
    expect(state.iteration).toBe(4);
    expect(state.personaSessions.get('coder')).toBe('session-2');
    expect(setActiveResumePoint).toHaveBeenCalledWith(step, 4, 3, []);
  });

  it('異なる parallel 親配下の同名 workflow_call に異なる canonical call-site identity を割り当てる', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'parallel-a',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'shared-child',
      initialStep: 'review',
      maxSteps: 2,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      kind: 'workflow_call',
      call: 'shared-child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const parallelA = {
      workflow: 'parent',
      workflow_ref: 'parent',
      step: 'parallel-a',
      kind: 'parallel',
      occurrence: 1,
    } as const;
    const parallelB = {
      workflow: 'parent',
      workflow_ref: 'parent',
      step: 'parallel-b',
      kind: 'parallel',
      occurrence: 1,
    } as const;
    const state = makeState(parentConfig.name, 'running', 1);
    state.stepIterations.set(JSON.stringify({
      ancestors: ['parallel-a'],
      step: 'delegate',
    }), 1);
    state.stepIterations.set(JSON.stringify({
      ancestors: ['parallel-b'],
      step: 'delegate',
    }), 1);
    const createdOptions: Array<Record<string, unknown>> = [];
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: { slug: 'run' } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn((_config, _cwd, _task, options) => {
        createdOptions.push(options as unknown as Record<string, unknown>);
        return {
          on: vi.fn(),
          runWithResult: vi.fn().mockResolvedValue({
            state: makeState(childConfig.name, 'completed', 1),
          }),
        };
      }),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });
    const request = {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    };

    await executor.execute(
      prepareExecutionRequest(executor, request, 1, [parallelA]),
      { syncParentState: false },
    );
    await executor.execute(
      prepareExecutionRequest(executor, request, 1, [parallelB]),
      { syncParentState: false },
    );

    const first = createdOptions[0]!;
    const second = createdOptions[1]!;
    expect(first.workflowCallSiteIdentity).not.toEqual(
      second.workflowCallSiteIdentity,
    );
    expect(first.runPathNamespace).not.toEqual(second.runPathNamespace);
    expect(first.findingCallNamespace).not.toEqual(
      second.findingCallNamespace,
    );
  });

  it('should clone provider ladders into the child engine when creating it (issue #1208)', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'fix',
      maxSteps: 2,
      steps: [{ name: 'fix' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      kind: 'workflow_call',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 1);
    const providerLadders = {
      steps: { 'child/fix': [{ provider: 'opencode', model: 'ollama-cloud/glm-5.2' }, { provider: 'claude', model: 'opus' }] },
    };
    const createdOptions: Array<Record<string, unknown>> = [];
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: { slug: 'run' } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn((_config, _cwd, _task, options) => {
        createdOptions.push(options as unknown as Record<string, unknown>);
        return {
          on: vi.fn(),
          runWithResult: vi.fn().mockResolvedValue({
            state: makeState(childConfig.name, 'completed', 1),
          }),
        };
      }),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });

    await executor.execute(
      prepareExecutionRequest(executor, {
        step,
        childWorkflow: childConfig,
        childProviderInfo: { provider: 'mock', model: 'test-model' },
        parentProviderOptions: undefined,
        personaProviders: undefined,
        providerRouting: undefined,
        providerLadders,
      }, 1, []),
      { syncParentState: false },
    );

    const childOptions = createdOptions[0]!;
    expect(childOptions.providerLadders).toEqual(providerLadders);
    // A silent-no-op regression would drop the ladder; a shared reference would leak parent state.
    expect(childOptions.providerLadders).not.toBe(providerLadders);
    // A shallow copy passes the identity check above while still sharing every stage entry, so the
    // child mutating a stage would rewrite the parent's assignment. Probe the nested value.
    const childLadders = childOptions.providerLadders as typeof providerLadders;
    childLadders.steps['child/fix']![0]!.model = 'mutated-model';
    expect(providerLadders.steps['child/fix']![0]!.model).toBe('ollama-cloud/glm-5.2');
  });

  it('child workflow が abort した理由を呼び出し元へ返す', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'aborted', 4);
    childState.lastOutput = makeResponse({ content: 'stale child success' });
    childState.personaSessions.set('reviewer', 'child-session');
    const setActiveResumePoint = vi.fn();

    const childEngine = createChildEngine({
      state: childState,
      abort: {
        kind: 'runtime_error',
        reason: 'Step execution failed: child exploded',
        failure: {
          kind: 'runtime_error',
          step: 'reviewers',
          reason: 'Step execution failed: child exploded',
          error: 'child exploded',
        },
      },
    });
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn().mockReturnValue(childEngine),
      emit: vi.fn(),
      state,
      setActiveResumePoint,
      refreshFindingsState: vi.fn(),
    });

    const result = await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    expect(result.status).toBe('aborted');
    expect(result.abortKind).toBe('runtime_error');
    expect(result.abortReason).toBe('Step execution failed: child exploded');
    expect(result.abortFailure).toEqual({
      kind: 'runtime_error',
      step: 'reviewers',
      reason: 'Step execution failed: child exploded',
      error: 'child exploded',
    });
    expect(state.iteration).toBe(4);
    expect(state.personaSessions.get('reviewer')).toBe('child-session');
    expect(setActiveResumePoint).not.toHaveBeenCalled();
  });

  it('共通 workflow types の child engine 契約だけで executor を駆動できる', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const childEngine = createChildEngine({ state: childState });
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn().mockReturnValue(childEngine),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });

    const result = await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    expect(result.status).toBe('completed');
    expect(childEngine.runWithResult).toHaveBeenCalledTimes(1);
  });

  it('child workflow の論理 return 値を呼び出し元へ引き継ぐ', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child requested retry_plan' });

    const childEngine = createChildEngine({
      state: childState,
      returnValue: 'retry_plan',
    } as WorkflowRunResult);
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn().mockReturnValue(childEngine),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });

    const result = await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true }) as WorkflowState & { returnValue?: string };

    expect(result.status).toBe('completed');
    expect(result.returnValue).toBe('retry_plan');
  });

  it('親が finding_contract を持つとき、子エンジンへ contract・ledgerStore・typed authority を継承させる', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      findingContractAuthority: 'terminal_adjudication',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const childEngine = createChildEngine({ state: childState });
    const createEngine = vi.fn().mockReturnValue(childEngine);
    const ledgerStore = createFakeLedgerStore();
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: FAKE_FINDING_CONTRACT,
      findingLedgerStore: ledgerStore,
    });

    await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    const childOptions = createEngine.mock.calls[0]?.[3];
    expect(childOptions?.inheritedFindingContract).toEqual({
      contract: FAKE_FINDING_CONTRACT,
      ledgerStore,
      managerAuthority: 'terminal_adjudication',
    });
    expect(childOptions).not.toHaveProperty('findingLedgerStore');
  });

  it('親が finding_contract を持たない場合、子エンジンへ inheritedFindingContract を渡さない', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const childEngine = createChildEngine({ state: childState });
    const createEngine = vi.fn().mockReturnValue(childEngine);
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });

    await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    const childOptions = createEngine.mock.calls[0]?.[3];
    expect(childOptions?.inheritedFindingContract).toBeUndefined();
  });

  it('workflow_call 完了後、親の findings 状態を再読込する（refreshFindingsState を呼ぶ）', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const childEngine = createChildEngine({ state: childState });
    const refreshFindingsState = vi.fn();
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine: vi.fn().mockReturnValue(childEngine),
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState,
      findingContract: FAKE_FINDING_CONTRACT,
      findingLedgerStore: createFakeLedgerStore(),
    });

    expect(refreshFindingsState).not.toHaveBeenCalled();

    await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    expect(refreshFindingsState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['findings-manager', INVALID_MANAGER_SEATS],
    ['terminal-adjudicator', INVALID_ADJUDICATOR_SEATS],
  ] as const)('継承した finding_contract の %s seat が不正なとき、子 engine を作る前に fail-fast する', async (_role, internalAgentSeats) => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    // 子ワークフロー自体は自前の finding_contract を持たない（親から継承するだけ）。
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);

    const createEngine = vi.fn();
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
        internalAgentSeats,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: FAKE_FINDING_CONTRACT,
      findingLedgerStore: createFakeLedgerStore(),
    });

    await expect(executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true })).rejects.toThrow(/provider 'opencode' requires model/);

    expect(createEngine).not.toHaveBeenCalled();
  });

  it('子が継承した finding_contract.manager の provider/model が有効なときは従来どおり子 engine を作る', async () => {
    const parentConfig = {
      name: 'parent',
      initialStep: 'delegate',
      maxSteps: 10,
      steps: [],
    } as WorkflowConfig;
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: 'child',
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const state = makeState(parentConfig.name, 'running', 2);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const childEngine = createChildEngine({ state: childState });
    const createEngine = vi.fn().mockReturnValue(childEngine);
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: FAKE_FINDING_CONTRACT,
      findingLedgerStore: createFakeLedgerStore(),
    });

    const result = await executor.execute(prepareExecutionRequest(executor, {
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, 1, []), { syncParentState: true });

    expect(result.status).toBe('completed');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(createEngine.mock.calls[0]?.[3]?.inheritedFindingContract).toMatchObject({
      contract: FAKE_FINDING_CONTRACT,
      managerAuthority: 'standard',
    });
  });
});
