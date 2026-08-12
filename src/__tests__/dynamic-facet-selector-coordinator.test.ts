import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';

vi.mock('../agents/structured-caller/transport.js', () => ({
  executeStructuredAgent: vi.fn(),
}));

import { executeStructuredAgent } from '../agents/structured-caller/transport.js';
import * as contextBuilder from '../core/workflow/dynamic-facets/dynamicFacetContextBuilder.js';

const mockedExecuteAgent = vi.mocked(executeStructuredAgent);

afterEach(() => {
  vi.restoreAllMocks();
});

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

function makeStep(maxSelected: number | undefined = 4): NormalAgentWorkflowStep {
  return {
    name: 'fix',
    personaDisplayName: 'coder',
    instruction: 'Fix',
    dynamicFacets: {
      pool: 'fix',
      ...(maxSelected === undefined ? {} : { maxSelected }),
    },
  };
}

function makeUnlimitedStep(): NormalAgentWorkflowStep {
  return {
    name: 'fix',
    personaDisplayName: 'coder',
    instruction: 'Fix',
    dynamicFacets: { pool: 'fix' },
  };
}

function snapshot(
  identity: string,
  selectedIds: string[],
  round: number,
): DynamicFacetSelectionSnapshot {
  return {
    identity,
    step_name: 'fix',
    round,
    selected_ids: selectedIds,
    selected_policy_refs: [],
    selected_knowledge_refs: [],
    rationale: `round ${round}`,
  };
}

function makeState(snapshot?: DynamicFacetSelectionSnapshot): WorkflowState {
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
    stepIterations: new Map([['fix', 1]]),
    dynamicParallelSelections: new Map(),
    dynamicFacetSelections: selections,
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
    failureDir: '/tmp/project/.takt/runs/run/failures',
    selectionStore: store,
    getWorkflowReference: () => 'test-workflow',
    workflowCallPath: [],
    commitSelection: vi.fn().mockResolvedValue(undefined),
    getReportDirectory: () => '.takt/reports',
    getReportNames: () => [],
    getCwd: () => '/tmp/project',
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
    ).rejects.toThrow('must NOT have more than 2 items');
  });

  it('accepts all pool candidates when max_selected is omitted', async () => {
    const pool = makePool([
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
      { id: 'c', description: 'C' },
    ]);
    const step = makeUnlimitedStep();
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['a', 'b', 'c'], rationale: 'all facets are relevant' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);

    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    const result = await coordinator.resolveDynamicFacets(step, makeState(), 'task', pool);

    expect(result.selectedIds).toEqual(['a', 'b', 'c']);
    const executeOptions = mockedExecuteAgent.mock.calls[0]?.[2] as { properties?: { selected_ids?: { maxItems?: number } } };
    expect(executeOptions.properties?.selected_ids?.maxItems).toBeUndefined();
  });

  it('keeps base facets unchanged when the selector returns an empty selection (DFP-005)', async () => {
    const pool: ResolvedFacetPool = {
      name: 'fix',
      candidates: [{
        id: 'extra',
        description: 'extra facet',
        policyRefs: ['extra-policy'],
        knowledgeRefs: ['extra-knowledge'],
        resolvedPolicyContents: [{ content: 'EXTRA POLICY' }],
        resolvedKnowledgeContents: [{ content: 'EXTRA KNOWLEDGE' }],
      }],
    };
    const step: NormalAgentWorkflowStep = {
      ...makeStep(1),
      policyContents: [{ content: 'BASE POLICY' }],
      knowledgeContents: [{ content: 'BASE KNOWLEDGE' }],
    };
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: [], rationale: 'no extra facet is needed' },
    });

    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    const result = await coordinator.resolveDynamicFacets(step, makeState(), 'task', pool);

    expect(result.selectedIds).toEqual([]);
    expect(result.effectivePolicyContents).toEqual(['BASE POLICY']);
    expect(result.effectiveKnowledgeContents).toEqual(['BASE KNOWLEDGE']);
    expect(result.effectivePolicyContents).not.toContain('EXTRA POLICY');
    expect(result.effectiveKnowledgeContents).not.toContain('EXTRA KNOWLEDGE');
  });

  it('sends a provider-compatible schema to the structured selector', async () => {
    const pool = makePool([
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
    ]);
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['a'], rationale: 'a is relevant' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);

    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    await coordinator.resolveDynamicFacets(makeStep(1), makeState(), 'task', pool);

    const outputSchema = mockedExecuteAgent.mock.calls[0]?.[1];
    if (outputSchema === undefined) throw new Error('Selector output schema was not sent');
    expect(mockedExecuteAgent.mock.calls[0]?.[3]).toMatchObject({
      failureDir: '/tmp/project/.takt/runs/run/failures',
    });
    expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
    expect(outputSchema).not.toHaveProperty('properties.selected_ids.uniqueItems');
    expect(outputSchema).toHaveProperty('properties.selected_ids.maxItems', 1);
  });

  it('should run the selector instead of restoring a run-local selection as a resume snapshot', async () => {
    const pool = makePool([
      { id: 'frontend', description: 'frontend' },
      { id: 'backend', description: 'backend' },
    ]);
    const step = makeStep();
    const identity = buildIdentity('fix');
    const previous = snapshot(identity, ['frontend'], 1);
    const deps = buildDeps({
      selectionStore: new DynamicFacetSelectionStore(new Map([[identity, previous]])),
    });
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['backend'], rationale: 'backend is relevant now' },
    });

    const result = await new DynamicFacetSelectorCoordinator(deps)
      .resolveDynamicFacets(step, makeState(), 'task', pool);

    expect(mockedExecuteAgent).toHaveBeenCalledOnce();
    expect(result.selectedIds).toEqual(['backend']);
    expect(result.snapshot.round).toBe(2);
  });

  it('should start a resumed selector at round one with no re-entry history', async () => {
    const pool = makePool([
      { id: 'transaction', description: 'transaction' },
      { id: 'database', description: 'database' },
    ]);
    const step = makeStep();
    const getReportNames = vi.fn().mockReturnValue([]);
    const deps = buildDeps({ getReportNames });
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['database'], rationale: 'database is relevant now' },
    });
    const instructionSpy = vi.spyOn(contextBuilder, 'buildDynamicFacetSelectorInstruction');

    const result = await new DynamicFacetSelectorCoordinator(deps)
      .resolveDynamicFacets(step, makeState(), 'task', pool);

    expect(result.snapshot.round).toBe(1);
    expect(getReportNames).toHaveBeenCalledWith(step, expect.any(Object));
    expect(deps.inputReader?.readInputs).toHaveBeenCalledWith(
      '.takt/reports',
      [],
      '/tmp/project',
      undefined,
    );
    expect(instructionSpy).toHaveBeenCalledOnce();
    const instructionInput = instructionSpy.mock.calls[0]![0] as {
      isReentry: boolean;
      reports: string;
    };
    expect(instructionInput.isReentry).toBe(false);
    expect(instructionInput.reports).toBe('');
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

  it('fails fast when the selector does not receive a resolved step iteration', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    const state = makeState();
    state.stepIterations.clear();
    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());

    await expect(
      coordinator.resolveDynamicFacets(step, state, 'task', pool),
    ).rejects.toThrow('requires a resolved step iteration');
    expect(mockedExecuteAgent).not.toHaveBeenCalled();
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
    const committed = commit.mock.calls[0]![1] as DynamicFacetSelectionSnapshot;
    expect(committed.round).toBe(2);
    expect(committed.selected_ids).toEqual(['b']);
    // isReentry is true when previous selection exists (coordinator L117).
    expect(instructionSpy).toHaveBeenCalledOnce();
    const instructionInput = instructionSpy.mock.calls[0]![0] as { isReentry: boolean };
    expect(instructionInput.isReentry).toBe(true);
  });

  it('uses the captured parallel child iteration and parent frame in the run-local identity', async () => {
    const pool = makePool([{ id: 'a', description: 'A' }]);
    const step = makeStep();
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['a'], rationale: 'parallel selection' },
    });
    const instructionSpy = vi.spyOn(contextBuilder, 'buildDynamicFacetSelectorInstruction');
    const parentFrame = {
      workflow: 'test-workflow',
      workflow_ref: 'test-workflow',
      step: 'reviewers',
      kind: 'parallel' as const,
      occurrence: 2,
    };
    const deps = buildDeps();
    const coordinator = new DynamicFacetSelectorCoordinator(deps);

    await coordinator.resolveDynamicFacets(step, makeState(), 'task', pool, {
      identityPath: [parentFrame],
      stepIteration: 7,
    });

    expect(instructionSpy).toHaveBeenCalledWith(expect.objectContaining({ stepIteration: 7 }));
    const commit = deps.commitSelection as unknown as { mock: { calls: unknown[][] } };
    expect(JSON.parse(commit.mock.calls[0]?.[0] as string)).toEqual({
      workflow: 'test-workflow',
      step: 'fix',
      calls: [{
        workflow: 'test-workflow',
        step: 'reviewers',
        kind: 'parallel',
        instance: 2,
      }],
    });
    instructionSpy.mockRestore();
  });

  it('throws when selector returns an unknown candidate id through the shared contract', async () => {
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
    const coordinator = new DynamicFacetSelectorCoordinator(buildDeps());
    await expect(
      coordinator.resolveDynamicFacets(step, makeState(), 'task', pool),
    ).rejects.toThrow(/invalid structured output/);
  });

  it('propagates run-local selection commit failure and leaves active identity unset', async () => {
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
