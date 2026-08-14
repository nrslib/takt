import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentResponse,
  DynamicParallelSubSteps,
  WorkflowState,
  WorkflowStep,
} from '../core/models/types.js';
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

function dynamicParallelStep(selection: unknown = { mode: 'replace' }): WorkflowStep {
  return makeStep('reviewers', {
    parallel: {
      kind: 'dynamic',
      fixed: [makeStep('architecture')],
      pool: [
        { ...makeStep('frontend'), description: 'frontend review' },
        { ...makeStep('backend'), description: 'backend review' },
      ],
      selection: selection as DynamicParallelSubSteps['selection'],
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
    dynamicFacetSelections: new Map(),
    status: 'running',
  };
}

function dependencies(): DynamicParallelSelectorCoordinatorDeps {
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: '/project',
    workflowBundleResourceRoot: '/project/.takt/runs/bundle/resources',
    selectorProvider: {
      provider: 'mock',
      model: undefined,
      providerOptions: {},
    },
  };
  return {
    engineOptions,
    failureDir: '/project/.takt/runs/run/failures',
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('passes selector guidance to the isolated agent without changing participant selection', async () => {
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['frontend'], rationale: 'frontend changes are present' },
    });
    const onActivity = vi.fn();
    const deps = { ...dependencies(), onActivity };
    const coordinator = new DynamicParallelSelectorCoordinator(deps);
    const step = dynamicParallelStep({
      mode: 'replace',
      selector: {
        persona: 'reviewer-selector',
        personaPath: '/project/.takt/facets/personas/reviewer-selector.md',
        instruction: 'Select reviewers from the changed paths and prior reports.',
      },
    });

    const participants = await coordinator.selectParticipants(
      step,
      workflowState(),
      'review frontend changes',
    );

    const [systemPrompt, instruction, outputSchema, options] = mockedExecuteAgent.mock.calls[0] ?? [];
    expect(systemPrompt).toContain('internal dynamic parallel selector');
    expect(instruction).toContain('Select reviewers from the changed paths and prior reports.');
    expect(instruction).toContain('Task:\nreview frontend changes');
    expect(instruction).toContain('- frontend: frontend review');
    expect(outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['selected_ids', 'rationale'],
      properties: {
        selected_ids: {
          type: 'array',
          items: { type: 'string', enum: ['frontend', 'backend'] },
        },
        rationale: { type: 'string' },
      },
    });
    expect(options).toEqual(expect.objectContaining({
      persona: 'reviewer-selector',
      personaPath: '/project/.takt/facets/personas/reviewer-selector.md',
      workflowBundleResourceRoot: '/project/.takt/runs/bundle/resources',
      onActivity,
    }));
    expect(participants.map(({ name }) => name)).toEqual(['architecture', 'frontend']);
  });

  it('should run the selector when run-local state has no resume selection', async () => {
    const response: AgentResponse = {
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['backend'], rationale: 'backend is relevant' },
    };
    mockedExecuteAgent.mockResolvedValueOnce(response);
    const deps = dependencies();
    const coordinator = new DynamicParallelSelectorCoordinator(deps);

    const participants = await coordinator.selectParticipants(
      dynamicParallelStep(),
      workflowState(),
      'review backend changes',
    );

    expect(mockedExecuteAgent).toHaveBeenCalledOnce();
    expect(participants.map(({ name }) => name)).toEqual(['architecture', 'backend']);
  });
});
