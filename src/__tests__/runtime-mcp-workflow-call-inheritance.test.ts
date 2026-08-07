import { describe, expect, it, vi } from 'vitest';
import { WorkflowCallExecutor } from '../core/workflow/engine/WorkflowCallExecutor.js';
import { restoreWorkflowCallInvocationEvidence } from '../core/workflow/workflow-call-invocation-index.js';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowCallStep,
} from '../core/models/index.js';
import type {
  WorkflowCallChildEngine,
  WorkflowRunResult,
  WorkflowSharedRuntimeState,
} from '../core/workflow/types.js';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';

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
    resumedDynamicParallelSteps: new Set(),
    status,
  };
}

function buildMcpSection(): McpAssignmentSection {
  return {
    servers: {
      'common-tools': { type: 'stdio', command: 'common-srv' },
      'github': { type: 'http', url: 'https://api.github.com/mcp' },
    },
    defaults: { servers: ['common-tools'] },
    targets: {
      personas: {
        'release-manager': { servers: ['github'] },
      },
      steps: {
        'leaf/execute': { servers: ['github'] },
      },
    },
  } as unknown as McpAssignmentSection;
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

describe('WorkflowCallExecutor mcpAssignment inheritance (要件114)', () => {
  it('Given parent WorkflowEngineOptions with mcpAssignment, When execute is called, Then childOptions.mcpAssignment equals the parent section (same reference)', async () => {
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
    state.stepIterations.set('delegate', 1);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const evidence = restoreWorkflowCallInvocationEvidence(undefined);
    const sharedRuntime: WorkflowSharedRuntimeState = {
      startedAtMs: Date.now(),
      maxSteps: 10,
      workflowCallInvocationEvidence: evidence,
    };

    const mcpAssignment = buildMcpSection();
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: childState } satisfies WorkflowRunResult),
    } satisfies WorkflowCallChildEngine);

    const executor = new WorkflowCallExecutor({
      getConfig: () => parentConfig,
      getOptions: () => ({
        projectCwd: '/tmp/project',
        reportDirName: 'run',
        mcpAssignment,
      }),
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      getCwd: () => '/tmp/project',
      projectCwd: '/tmp/project',
      task: 'task',
      sharedRuntime,
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: { slug: 'run' } as never,
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
      providerRouting: undefined,
    }, 1, []), { syncParentState: true });

    expect(createEngine).toHaveBeenCalledTimes(1);
    const childOptions = createEngine.mock.calls[0]?.[3] as { mcpAssignment?: McpAssignmentSection } | undefined;
    expect(childOptions?.mcpAssignment).toBeDefined();
    expect(childOptions?.mcpAssignment).toBe(mcpAssignment);
  });

  it('Given parent WorkflowEngineOptions without mcpAssignment, When execute is called, Then childOptions.mcpAssignment is undefined', async () => {
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
    state.stepIterations.set('delegate', 1);
    const childState = makeState(childConfig.name, 'completed', 3);
    childState.lastOutput = makeResponse({ content: 'child complete' });

    const evidence = restoreWorkflowCallInvocationEvidence(undefined);
    const sharedRuntime: WorkflowSharedRuntimeState = {
      startedAtMs: Date.now(),
      maxSteps: 10,
      workflowCallInvocationEvidence: evidence,
    };

    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: childState } satisfies WorkflowRunResult),
    } satisfies WorkflowCallChildEngine);

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
      sharedRuntime,
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: { slug: 'run' } as never,
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
      providerRouting: undefined,
    }, 1, []), { syncParentState: true });

    expect(createEngine).toHaveBeenCalledTimes(1);
    const childOptions = createEngine.mock.calls[0]?.[3] as { mcpAssignment?: McpAssignmentSection } | undefined;
    expect(childOptions?.mcpAssignment).toBeUndefined();
  });
});