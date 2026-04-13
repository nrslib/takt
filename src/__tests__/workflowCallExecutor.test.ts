import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import type { AgentResponse, WorkflowConfig, WorkflowState, WorkflowCallStep } from '../core/models/index.js';

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
    const childEngine = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      run: vi.fn().mockResolvedValue(childState),
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
});
