import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/types.js';
import {
  DynamicParallelSelectorCoordinator,
  type DynamicParallelSelectorCoordinatorDeps,
} from '../core/workflow/dynamic-parallel/selector-coordinator.js';
import { DynamicParallelSelectionStore } from '../core/workflow/dynamic-parallel/selection-store.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { makeStep } from './engine-test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeIsolatedStructuredInternalAgent: vi.fn(),
}));

import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';

const mockedExecuteAgent = vi.mocked(executeIsolatedStructuredInternalAgent);

function dynamicParallelStep(): WorkflowStep {
  return makeStep('reviewers', {
    parallel: {
      kind: 'dynamic',
      fixed: [makeStep('architecture')],
      pool: [
        { ...makeStep('frontend'), description: 'frontend review' },
        { ...makeStep('backend'), description: 'backend review' },
      ],
      selection: { mode: 'replace' },
    },
  });
}

function workflowState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'reviewers',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    resumedDynamicParallelSteps: new Set(),
    dynamicFacetSelections: new Map(),
    resumedDynamicFacetSteps: new Set(),
    status: 'running',
  };
}

function dependencies(): DynamicParallelSelectorCoordinatorDeps {
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: '/project',
    selectorProvider: {
      provider: 'mock',
      model: undefined,
      providerOptions: {},
      nativeTools: [],
    },
  };
  return {
    engineOptions,
    selectionStore: new DynamicParallelSelectionStore(new Map()),
    getCwd: () => '/project',
    getReportDirectory: () => '.takt/reports',
    getReportNames: () => [],
    getWorkflowReference: () => 'test-workflow',
    workflowCallPath: [],
    commitSelection: vi.fn().mockResolvedValue(undefined),
    inputReader: {
      readInputs: vi.fn().mockResolvedValue({ reports: '', workingTreeDiff: '' }),
    } as DynamicParallelSelectorCoordinatorDeps['inputReader'],
  };
}

describe('DynamicParallelSelectorCoordinator', () => {
  it('should send a provider-compatible schema and validate the returned selection', async () => {
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['frontend'], rationale: 'frontend is relevant' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);
    const deps = dependencies();
    const coordinator = new DynamicParallelSelectorCoordinator(deps);

    const participants = await coordinator.selectParticipants(
      dynamicParallelStep(),
      workflowState(),
      'review frontend changes',
    );

    const outputSchema = mockedExecuteAgent.mock.calls[0]?.[2];
    if (outputSchema === undefined) throw new Error('Selector output schema was not sent');
    expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
    expect(outputSchema).not.toHaveProperty('properties.selected_ids.uniqueItems');
    expect(participants.map(({ name }) => name)).toEqual(['architecture', 'frontend']);
    expect(deps.commitSelection).toHaveBeenCalledOnce();
  });
});
