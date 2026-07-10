import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import type { AgentResponse, FindingContractConfig, FindingLedger, WorkflowConfig, WorkflowState, WorkflowCallStep } from '../core/models/index.js';
import type { WorkflowCallChildEngine, WorkflowRunResult } from '../core/workflow/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';

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
    stepIterations: new Map(),
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
    const state = makeState(parentConfig.name, 'running', 2);
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
    expect(childEngine.on).toHaveBeenCalledWith('step:start', expect.any(Function));
    listeners.get('step:start')?.('payload');
    expect(emit).toHaveBeenCalledWith('step:start', 'payload');
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
    const state = makeState(parentConfig.name, 'running', 2);
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
    const state = makeState(parentConfig.name, 'running', 2);

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
