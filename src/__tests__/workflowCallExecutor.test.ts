import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import type { AgentResponse, FindingContractConfig, FindingLedger, WorkflowConfig, WorkflowState, WorkflowCallStep } from '../core/models/index.js';
import type {
  WorkflowCallChildEngine,
  WorkflowEngineOptions,
  WorkflowRunResult,
} from '../core/workflow/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { getReviewerAnomalyCallCapability } from '../core/workflow/reviewer-anomaly-capability.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { loadWorkflowFileWithResolutionOptions } from '../infra/config/loaders/workflowResolvedLoader.js';
import { resolveWorkflowCallContinuation } from '../core/workflow/run/resume-point.js';
import { StateManager } from '../core/workflow/engine/state-manager.js';

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: 'done',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeState(
  workflowName: string,
  status: WorkflowState['status'],
  iteration: number,
  activeStepName?: string,
): WorkflowState {
  return {
    workflowName,
    currentStep: activeStepName ?? 'review',
    iteration,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: activeStepName === undefined
      ? new Map()
      : new Map([[activeStepName, 1]]),
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
      version: 1,
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    }),
    saveLedger: () => {},
    updateLedger: (mutator) => Promise.resolve(mutator({
      version: 1,
      workflowName: 'fake',
      nextId: 1,
      updatedAt: new Date().toISOString(),
      findings: [],
      rawFindings: [],
      conflicts: [],
    })),
    createRunCopy: () => '/tmp/fake-ledger-copy.json',
    saveRawFindings: () => '/tmp/fake-raw-findings.json',
    saveManagerValidationReport: () => '/tmp/fake-validation-report.json',
  };
}

const FAKE_FINDING_CONTRACT: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
};

const FAKE_FINDING_CONTRACT_WITH_INVALID_MANAGER_PROVIDER: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
    // opencode は model 必須。manager.provider を直接指定すると workflow の
    // provider/model フォールバックが働かなくなる（buildFindingManagerStep 参照）
    // ため、この組み合わせは常に不正になる。
    provider: 'opencode',
  },
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

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
    expect(childOptions?.traceTaskMetadata).toBe(traceTaskMetadata);
    expect(childOptions?.resumeStackPrefix).toEqual([{
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
      step_iterations: { delegate: 3 },
    }]);
    expect(childEngine.on).toHaveBeenCalledWith('step:start', expect.any(Function));
    const childStep = childConfig.steps[0];
    const childProviderInfo = { provider: 'mock', model: 'test-model' };
    listeners.get('step:start')?.(
      childStep,
      3,
      'child instruction',
      childProviderInfo,
      childConfig.name,
      childStep?.name,
      5,
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
    );
    expect(childEngine.on).toHaveBeenCalledWith('step:complete', expect.any(Function));
    const childResponse = makeResponse({ content: 'relayed response' });
    listeners.get('step:complete')?.(
      childStep,
      childResponse,
      'child instruction',
      childStep?.name,
    );
    expect(emit).toHaveBeenCalledWith(
      'step:complete',
      childStep,
      childResponse,
      'child instruction',
      step.name,
    );
    expect(childEngine.on).toHaveBeenCalledWith('findings:ledger', expect.any(Function));
    const ledger: FindingLedger = {
      version: 1,
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-06-13T02:00:00.000Z',
      findings: [],
      rawFindings: [],
      conflicts: [],
    };
    listeners.get('findings:ledger')?.(ledger);
    expect(emit).toHaveBeenCalledWith('findings:ledger', ledger);
    expect(state.iteration).toBe(4);
    expect(state.personaSessions.get('coder')).toBe('session-2');
    expect(setActiveResumePoint).toHaveBeenCalledWith(step, 4);
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
    const childState = makeState(childConfig.name, 'aborted', 4);
    childState.lastOutput = makeResponse({ content: 'stale child success' });

    const childEngine = createChildEngine({
      state: childState,
      abort: {
        kind: 'runtime_error',
        reason: 'Step execution failed: child exploded',
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

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true }) as WorkflowState & { abortKind?: string; abortReason?: string };

    expect(result.status).toBe('aborted');
    expect(result.abortKind).toBe('runtime_error');
    expect(result.abortReason).toBe('Step execution failed: child exploded');
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true }) as WorkflowState & { returnValue?: string };

    expect(result.status).toBe('completed');
    expect(result.returnValue).toBe('retry_plan');
  });

  it('親が finding_contract を持つとき、子エンジンへ contract と ledgerStore を継承させる', async () => {
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

    const childOptions = createEngine.mock.calls[0]?.[3];
    expect(childOptions?.inheritedFindingContract).toEqual({
      contract: FAKE_FINDING_CONTRACT,
      ledgerStore,
    });
  });

  it('通常 retry は source run を継承せず、新しい出力 run の invocation ID で capability を発行する', async () => {
    const projectCwd = process.cwd();
    const childConfig = loadWorkflowFileWithResolutionOptions(
      `${getBuiltinWorkflowsDir('ja')}/merge-readiness-finding-contract-final-gate.yaml`,
      {
        projectCwd,
        lookupCwd: projectCwd,
        source: 'builtin',
      },
    );
    const step = {
      name: 'final-gate',
      call: childConfig.name,
      personaDisplayName: 'final-gate',
      instruction: '',
    } as WorkflowCallStep;
    const parentConfig = {
      name: 'parent',
      initialStep: step.name,
      maxSteps: 10,
      steps: [step],
    } as WorkflowConfig;
    const state = makeState(parentConfig.name, 'running', 2, step.name);
    const childState = makeState(childConfig.name, 'completed', 4);
    const createEngine = vi.fn().mockReturnValue(createChildEngine({ state: childState }));
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd,
        reportDirName: 'run',
        resumeSource: {
          sourceRunSlug: 'source-run',
          resumeMode: 'retry',
        },
        workflowCallContinuation: {
          invocationRunId: 'source-run',
        } as unknown as NonNullable<WorkflowEngineOptions['workflowCallContinuation']>,
        resumePoint: {
          version: 1,
          stack: [buildWorkflowResumePointEntry(
            parentConfig,
            step.name,
            'workflow_call',
            new Map([[step.name, 1]]),
          )],
          iteration: 2,
          elapsed_ms: 100,
        },
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => projectCwd,
      projectCwd,
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

    const childOptions = createEngine.mock.calls[0]?.[3] as object;
    const capability = getReviewerAnomalyCallCapability(childOptions);
    expect(capability).toMatchObject({
      kind: 'reviewer_anomaly_acknowledgement',
      approvalSteps: ['merge-readiness-review', 'supervise'],
      evidenceReferences: [],
      gate: {
        invocationId: 'run:final-gate#1',
      },
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(getReviewerAnomalyCallCapability({ ...childOptions })).toBeUndefined();
    const descriptorCopy = {};
    for (const symbol of Object.getOwnPropertySymbols(childOptions)) {
      const descriptor = Object.getOwnPropertyDescriptor(childOptions, symbol);
      if (descriptor !== undefined) {
        Object.defineProperty(descriptorCopy, symbol, descriptor);
      }
    }
    expect(getReviewerAnomalyCallCapability(descriptorCopy)).toBeUndefined();
  });

  it('StateManager が保存 invocation を復元後に resolver child が変わると namespace 再利用前に失敗する', async () => {
    const projectCwd = process.cwd();
    const validatedChild = loadWorkflowFileWithResolutionOptions(
      `${getBuiltinWorkflowsDir('ja')}/merge-readiness-finding-contract-final-gate.yaml`,
      {
        projectCwd,
        lookupCwd: projectCwd,
        source: 'builtin',
      },
    );
    const replacementChild = loadWorkflowFileWithResolutionOptions(
      `${getBuiltinWorkflowsDir('en')}/merge-readiness-finding-contract-final-gate.yaml`,
      {
        projectCwd,
        lookupCwd: projectCwd,
        source: 'builtin',
      },
    );
    const step = {
      name: 'final-gate',
      call: validatedChild.name,
      personaDisplayName: 'final-gate',
      instruction: '',
    } as WorkflowCallStep;
    const parentConfig = {
      name: 'parent',
      initialStep: step.name,
      maxSteps: 10,
      steps: [step],
    } as WorkflowConfig;
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(
          parentConfig,
          step.name,
          'workflow_call',
          new Map([[step.name, 3]]),
        ),
        buildWorkflowResumePointEntry(validatedChild, validatedChild.initialStep, 'agent'),
      ],
      iteration: 2,
      elapsed_ms: 100,
    };
    const continuation = resolveWorkflowCallContinuation({
      workflow: parentConfig,
      resumePoint,
      invocationRunId: 'source-run',
      resolveWorkflowCall: () => validatedChild,
    });
    expect(continuation).toBeDefined();
    const stateManager = new StateManager(parentConfig, {
      projectCwd,
      startStep: step.name,
      resumePoint,
      workflowCallContinuation: continuation,
      initialIteration: resumePoint.iteration,
    });
    expect(stateManager.state.stepIterations.get(step.name)).toBe(2);
    stateManager.state.iteration += 1;
    expect(stateManager.incrementStepIteration(step.name)).toBe(3);
    const state = stateManager.state;
    const childState = makeState(replacementChild.name, 'completed', 4);
    const createEngine = vi.fn().mockReturnValue(createChildEngine({ state: childState }));
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd,
        reportDirName: 'run',
        resumePoint,
        workflowCallContinuation: continuation,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => projectCwd,
      projectCwd,
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
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

    await expect(executor.execute({
      step,
      childWorkflow: replacementChild,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true })).rejects.toThrow(
      /resolved to a different child while resuming a persisted invocation.*refusing to reuse its iteration and finding namespace/s,
    );

    expect(state.stepIterations.get(step.name)).toBe(3);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('StateManager が保存 invocation を復元後に child step kind が変わると namespace 発行前に失敗する', async () => {
    const projectCwd = process.cwd();
    const validatedChild = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 10,
      steps: [{
        name: 'review',
        personaDisplayName: 'review',
        instruction: '',
      }],
    } as WorkflowConfig;
    const replacementChild = {
      ...validatedChild,
      steps: [{
        name: 'review',
        kind: 'system',
        action: 'report',
      }],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      kind: 'workflow_call',
      call: validatedChild.name,
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const parentConfig = {
      name: 'parent',
      initialStep: step.name,
      maxSteps: 10,
      steps: [step],
    } as WorkflowConfig;
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(
          parentConfig,
          step.name,
          'workflow_call',
          new Map([[step.name, 3]]),
        ),
        buildWorkflowResumePointEntry(validatedChild, validatedChild.initialStep, 'agent'),
      ],
      iteration: 2,
      elapsed_ms: 100,
    };
    const continuation = resolveWorkflowCallContinuation({
      workflow: parentConfig,
      resumePoint,
      invocationRunId: 'source-run',
      resolveWorkflowCall: () => validatedChild,
    });
    expect(continuation).toBeDefined();
    const stateManager = new StateManager(parentConfig, {
      projectCwd,
      startStep: step.name,
      resumePoint,
      workflowCallContinuation: continuation,
      initialIteration: resumePoint.iteration,
    });
    expect(stateManager.state.stepIterations.get(step.name)).toBe(2);
    stateManager.state.iteration += 1;
    expect(stateManager.incrementStepIteration(step.name)).toBe(3);
    const createEngine = vi.fn();
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd,
        reportDirName: 'run',
        resumePoint,
        workflowCallContinuation: continuation,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => projectCwd,
      projectCwd,
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state: stateManager.state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
    });

    await expect(executor.execute({
      step,
      childWorkflow: replacementChild,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    }, { syncParentState: true })).rejects.toThrow(
      /resolved to a different child while resuming a persisted invocation.*refusing to reuse its iteration and finding namespace/s,
    );

    expect(stateManager.state.stepIterations.get(step.name)).toBe(3);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('attestation のない通常 child は第二ステップの resume point を変更しない', async () => {
    const childConfig = {
      name: 'ordinary-child',
      subworkflow: { callable: true },
      initialStep: 'first',
      maxSteps: 10,
      steps: [
        { name: 'first' },
        { name: 'second' },
      ],
    } as WorkflowConfig;
    const step = {
      name: 'delegate',
      call: childConfig.name,
      personaDisplayName: 'delegate',
      instruction: '',
    } as WorkflowCallStep;
    const parentConfig = {
      name: 'parent',
      initialStep: step.name,
      maxSteps: 10,
      steps: [step],
    } as WorkflowConfig;
    const resumePoint = {
      version: 1 as const,
      stack: [
        buildWorkflowResumePointEntry(parentConfig, step.name, 'workflow_call'),
        buildWorkflowResumePointEntry(childConfig, 'second', 'agent'),
      ],
      iteration: 2,
      elapsed_ms: 100,
    };
    const state = makeState(parentConfig.name, 'running', 2, step.name);
    const childState = makeState(childConfig.name, 'completed', 3);
    const createEngine = vi.fn().mockReturnValue(createChildEngine({ state: childState }));
    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
        resumePoint,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime: { startedAtMs: Date.now(), maxSteps: 10 },
      resumeStackPrefix: [],
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

    const childOptions = createEngine.mock.calls[0]?.[3];
    expect(childOptions?.startStep).toBe('second');
    expect(childOptions?.resumePoint).toEqual(resumePoint);
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

    expect(refreshFindingsState).toHaveBeenCalledTimes(1);
  });

  it('子が継承した finding_contract.manager の provider/model が不正なとき、子 engine を作る前に fail-fast する', async () => {
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
    const state = makeState(parentConfig.name, 'running', 2, step.name);

    const createEngine = vi.fn();
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
      runPaths: {
        slug: 'run',
      } as never,
      resolveWorkflowCall: vi.fn(),
      createEngine,
      emit: vi.fn(),
      state,
      setActiveResumePoint: vi.fn(),
      refreshFindingsState: vi.fn(),
      findingContract: FAKE_FINDING_CONTRACT_WITH_INVALID_MANAGER_PROVIDER,
      findingLedgerStore: createFakeLedgerStore(),
    });

    await expect(executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true })).rejects.toThrow(/provider 'opencode' requires model/);

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
    const state = makeState(parentConfig.name, 'running', 2, step.name);
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

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }, { syncParentState: true });

    expect(result.status).toBe('completed');
    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});
