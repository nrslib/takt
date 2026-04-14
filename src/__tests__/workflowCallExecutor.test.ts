import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import type { AgentResponse, WorkflowConfig, WorkflowState, WorkflowCallStep } from '../core/models/index.js';
import type { WorkflowCallChildEngine, WorkflowRunResult } from '../core/workflow/types.js';

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
      emit,
      state,
      setActiveResumePoint,
    });

    await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    });

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      '/tmp/project',
      'task',
      expect.objectContaining({
        provider: 'mock',
        model: 'test-model',
        reportDirName: 'run',
        runPathNamespace: ['subworkflows', expect.stringContaining('step-delegate')],
      }),
    );
    expect(childEngine.on).toHaveBeenCalledWith('step:start', expect.any(Function));
    listeners.get('step:start')?.('payload');
    expect(emit).toHaveBeenCalledWith('step:start', 'payload');
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
    });

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    }) as WorkflowState & { abortKind?: string; abortReason?: string };

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
    });

    const result = await executor.execute({
      step,
      childWorkflow: childConfig,
      childProviderInfo: { provider: 'mock', model: 'test-model' },
      parentProviderOptions: undefined,
      personaProviders: undefined,
    });

    expect(result.status).toBe('completed');
    expect(childEngine.runWithResult).toHaveBeenCalledTimes(1);
  });
});
