import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DynamicFacetSelectorCoordinator,
  type DynamicFacetSelectorCoordinatorDeps,
} from '../core/workflow/dynamic-facets/dynamicFacetSelectorCoordinator.js';
import type {
  AgentResponse,
  DynamicFacetSelectionSnapshot,
  NormalAgentWorkflowStep,
  ResolvedFacetPool,
  WorkflowState,
} from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { DynamicFacetSelectionStore } from '../core/workflow/dynamic-facets/dynamicFacetSelectionStore.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeIsolatedStructuredInternalAgent: vi.fn(),
}));

import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';
import * as selectorContract from '../core/workflow/dynamic-parallel/selector-contract.js';
import * as contextBuilder from '../core/workflow/dynamic-facets/dynamicFacetContextBuilder.js';

const mockedExecuteAgent = vi.mocked(executeIsolatedStructuredInternalAgent);

function makePool(candidates: { id: string; description: string }[]): ResolvedFacetPool {
  return {
    name: 'fix',
    candidates: candidates.map((c) => ({
      id: c.id,
      description: c.description,
      policyRefs: [],
      knowledgeRefs: [],
      resolvedPolicyContents: [],
      resolvedKnowledgeContents: [],
    })),
  };
}

function makeStep(maxSelected = 4): NormalAgentWorkflowStep {
  return {
    name: 'fix',
    personaDisplayName: 'coder',
    instruction: 'Fix',
    dynamicFacets: { pool: 'fix', maxSelected },
  };
}

function makeState(snapshot?: DynamicFacetSelectionSnapshot, resumedIdentity?: string): WorkflowState {
  const selections = new Map<string, DynamicFacetSelectionSnapshot>();
  if (snapshot) selections.set(snapshot.identity, snapshot);
  return {
    workflowName: 'test-workflow',
    currentStep: 'fix',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    dynamicFacetSelections: selections,
    resumedDynamicFacetSteps: resumedIdentity ? new Set([resumedIdentity]) : new Set(),
    status: 'running',
  };
}

function makeOptions(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    projectCwd: '/tmp/project',
    selectorProvider: {
      provider: 'cursor',
      providerSource: 'step',
      model: 'm',
      modelSource: 'step',
      providerOptions: {},
      nativeTools: [],
    },
    ...overrides,
  } as unknown as WorkflowEngineOptions;
}

function buildIdentity(step: string): string {
  return JSON.stringify({ workflow: 'test-workflow', step, calls: [] });
}

function buildDeps(overrides: Partial<DynamicFacetSelectorCoordinatorDeps> = {}): DynamicFacetSelectorCoordinatorDeps {
  const store = new DynamicFacetSelectionStore(new Map());
  return {
    engineOptions: makeOptions(),
    selectionStore: store,
    getWorkflowReference: () => 'test-workflow',
    workflowCallPath: [],
    commitSelection: vi.fn().mockResolvedValue(undefined),
    getReportDirectory: () => '.takt/reports',
    getReportNames: () => [],
    getCwd: () => '/tmp/project',
    getUnresolvedFindings: () => '',
    inputReader: {
      readInputs: vi.fn().mockResolvedValue({ reports: '', workingTreeDiff: '' }),
    } as unknown as DynamicFacetSelectorCoordinatorDeps['inputReader'],
    ...overrides,
  };
}

describe('DynamicFacetSelectorCoordinator', () => {
  beforeEach(() => {
    mockedExecuteAgent.mockReset();
  });

  it('throws when selected ids exceed max_selected', async () => {
    const pool = makePool([
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
      { id: 'c', description: 'C' },
    ]);
    const step = makeStep(2);
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['a', 'b', 'c'], rationale: 'all' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);

    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    await expect(
      coordinator.resolveDynamicFacets(step, makeState(), 'task', pool),
    ).rejects.toThrow('exceeding max_selected 2');
  });

  it('restores from snapshot without invoking selector when identity is in resumedDynamicFacetSteps', async () => {
    const pool = makePool([{ id: 'backend', description: 'backend' }]);
    const step = makeStep();
    const identity = buildIdentity('fix');
    const snapshot: DynamicFacetSelectionSnapshot = {
      identity,
      step_name: 'fix',
      round: 1,
      selected_ids: ['backend'],
      selected_policy_refs: [],
      selected_knowledge_refs: [],
      rationale: 'prev',
    };
    const store = new DynamicFacetSelectionStore(new Map([[identity, snapshot]]));
    const state = makeState(snapshot, identity);
    const deps = buildDeps({ selectionStore: store });

    const coordinator = new DynamicFacetSelectorCoordinator(deps);
    const result = await coordinator.resolveDynamicFacets(step, state, 'task', pool);

    expect(mockedExecuteAgent).not.toHaveBeenCalled();
    expect(result.selectedIds).toEqual(['backend']);
    expect(state.activeDynamicFacetSelectionIdentity).toBe(identity);
    expect(state.resumedDynamicFacetSteps.has(identity)).toBe(false);
  });

  it('throws when selector provider is not resolved', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    const deps = buildDeps({
      engineOptions: { ...makeOptions(), selectorProvider: undefined } as unknown as WorkflowEngineOptions,
    });
    const coordinator = new DynamicFacetSelectorCoordinator(deps);

    await expect(
      coordinator.resolveDynamicFacets(step, makeState(), 'task', pool),
    ).rejects.toThrow('has no resolved provider');
  });

  // L2: round increment + isReentry propagation through coordinator chain.
  it('increments round and propagates isReentry when selector runs with a previous selection (L2)', async () => {
    const pool = makePool([
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
    ]);
    const step = makeStep();
    const identity = buildIdentity('fix');
    const previous: DynamicFacetSelectionSnapshot = {
      identity,
      step_name: 'fix',
      round: 1,
      selected_ids: ['a'],
      selected_policy_refs: [],
      selected_knowledge_refs: [],
      rationale: 'prev',
    };
    const store = new DynamicFacetSelectionStore(new Map([[identity, previous]]));
    const deps = buildDeps({ selectionStore: store });
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['b'], rationale: 'now needs b' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);
    // Capture isReentry propagation into the selector instruction (order.md:374-375).
    const instructionSpy = vi.spyOn(contextBuilder, 'buildDynamicFacetSelectorInstruction');

    const coordinator = new DynamicFacetSelectorCoordinator(deps);
    const result = await coordinator.resolveDynamicFacets(step, makeState(), 'task', pool);

    expect(result.selectedIds).toEqual(['b']);
    // commitSelection receives the new snapshot with round=2 (previous round 1 + 1).
    const commit = deps.commitSelection as unknown as { mock: { calls: unknown[][] } };
    expect(commit.mock.calls).toHaveLength(1);
    const committed = commit.mock.calls[0]![3] as DynamicFacetSelectionSnapshot;
    expect(committed.round).toBe(2);
    expect(committed.selected_ids).toEqual(['b']);
    // isReentry is true when previous selection exists (coordinator L117).
    expect(instructionSpy).toHaveBeenCalledOnce();
    const instructionInput = instructionSpy.mock.calls[0]![0] as { isReentry: boolean };
    expect(instructionInput.isReentry).toBe(true);
    instructionSpy.mockRestore();
  });

  // L3: coordinator-level secondary unknownId rejection.
  it('throws when selector returns an unknown candidate id (coordinator secondary check, L3)', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['unknown-id'], rationale: 'x' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);
    // The schema enum check rejects unknown ids inside validateSelectorResponse. To exercise the
    // coordinator's defensive secondary check (dynamicFacetSelectorCoordinator.ts:165-171), bypass
    // the validator and inject an unknown id directly.
    const spy = vi.spyOn(selectorContract, 'validateSelectorResponse').mockReturnValueOnce({
      selectedIds: ['unknown-id'],
      rationale: 'x',
    });

    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    await expect(
      coordinator.resolveDynamicFacets(step, makeState(), 'task', pool),
    ).rejects.toThrow(/unknown candidate id/);
    spy.mockRestore();
  });

  it('propagates commitSelection failure and leaves activeDynamicFacetSelectionIdentity unset (C-STATE-RUNTIME: persistence failure)', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['a'], rationale: 'ok' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);
    const state = makeState();
    const deps = buildDeps({
      commitSelection: vi.fn().mockRejectedValue(new Error('metadata write failed')),
    });

    const coordinator = new DynamicFacetSelectorCoordinator(deps);
    await expect(
      coordinator.resolveDynamicFacets(step, state, 'task', pool),
    ).rejects.toThrow('metadata write failed');
    expect(state.activeDynamicFacetSelectionIdentity).toBeUndefined();
  });

  it('throws before main agent execution when abortSignal is already aborted (C-STATE-RUNTIME: pre-execution abort)', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    const controller = new AbortController();
    controller.abort();
    const deps = buildDeps({
      engineOptions: { ...makeOptions(), abortSignal: controller.signal } as unknown as WorkflowEngineOptions,
    });

    const coordinator = new DynamicFacetSelectorCoordinator(deps);
    await expect(
      coordinator.resolveDynamicFacets(step, makeState(), 'task', pool),
    ).rejects.toThrow();
    expect(mockedExecuteAgent).not.toHaveBeenCalled();
  });
});