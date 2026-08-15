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

vi.mock('../agents/structured-caller/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/structured-caller/transport.js')>();
  return {
    ...actual,
    executeStructuredAgent: vi.fn(),
  };
});

import { executeStructuredAgent } from '../agents/structured-caller/transport.js';

const mockedExecuteAgent = vi.mocked(executeStructuredAgent);

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
    getReportsRootDirectory: () => '.takt/reports',
    getReportNames: () => [],
    getWorkflowReference: () => 'test-workflow',
    workflowCallPath: [],
    commitSelection: vi.fn().mockResolvedValue(undefined),
    inputReader: {
      readInputs: vi.fn().mockImplementation(async (reportDirectory, reportNames) => ({
        reportDirectory,
        reportNames,
        changedPaths: ['src/changed.ts'],
      })),
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

    expect(deps.inputReader?.readInputs).toHaveBeenCalledWith(
      '.takt/reports',
      [],
      '/project',
      undefined,
    );
    const outputSchema = mockedExecuteAgent.mock.calls[0]?.[1];
    if (outputSchema === undefined) throw new Error('Selector output schema was not sent');
    expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
    expect(outputSchema).not.toHaveProperty('properties.selected_ids.uniqueItems');
    expect(participants.map(({ name }) => name)).toEqual(['architecture', 'frontend']);
    expect(deps.commitSelection).toHaveBeenCalledOnce();
  });

  it('passes configured selector reports to the input reader', async () => {
    mockedExecuteAgent.mockResolvedValueOnce({
      persona: 'selector',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput: { selected_ids: ['frontend'], rationale: 'frontend is relevant' },
    });
    const deps = dependencies();
    const coordinator = new DynamicParallelSelectorCoordinator(deps);

    await coordinator.selectParticipants(
      dynamicParallelStep({
        mode: 'replace',
        reports: ['review-resolution.md'],
      }),
      workflowState(),
      'review frontend changes',
    );

    expect(deps.inputReader?.readInputs).toHaveBeenCalledWith(
      '.takt/reports',
      ['review-resolution.md'],
      '/project',
      undefined,
    );
  });

  it('passes selector guidance to the read-only structured agent without changing participant selection', async () => {
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

    const [instruction, outputSchema, options] = mockedExecuteAgent.mock.calls[0] ?? [];
    expect(options?.systemPrompt).toContain('internal dynamic parallel selector');
    expect(instruction).toContain('Select reviewers from the changed paths and prior reports.');
    expect(instruction).toContain('Task:\nreview frontend changes');
    expect(instruction).toContain('Changed file paths:\n- src/changed.ts');
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
      allowedTools: ['Read', 'Glob', 'Grep'],
      resolution: expect.objectContaining({ permissionMode: 'readonly' }),
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
