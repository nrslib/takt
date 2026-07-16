import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import type { StepProviderInfo, WorkflowEngineOptions } from '../core/workflow/types.js';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

function createAutoRoutingConfig() {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
        providerOptions: {
          codex: { reasoningEffort: 'high' },
        },
      },
      {
        name: 'lightweight',
        description: 'Formatting and small edits',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        costTier: 'low',
      },
    ],
    rules: {
      tags: {
        implementation: 'coding',
        format: 'lightweight',
      },
    },
  };
}

function createEngineOptions(
  projectCwd: string,
  overrides: Record<string, unknown> = {},
): WorkflowEngineOptions {
  return {
    projectCwd,
    provider: 'auto' as never,
    providerSource: 'cli',
    autoRouting: createAutoRoutingConfig(),
    ...overrides,
  } as unknown as WorkflowEngineOptions;
}

function queueRunAgentRejection(error: Error): void {
  vi.mocked(runAgent).mockImplementationOnce(async (persona, task, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: task,
    });
    throw error;
  });
}

describe('WorkflowEngine auto routing integration', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Given provider auto and a tag rule match, When a normal step runs, Then runAgent receives the selected provider model and provider_options', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-normal',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarts: StepProviderInfo[] = [];

    const routingEvents: unknown[][] = [];
    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir));
    engine.on('step:start', (_step, _iteration, _instruction, providerInfo) => {
      stepStarts.push(providerInfo);
    });
    engine.on('routing:decision', (...args) => {
      routingEvents.push(args);
    });

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(stepStarts[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
    });
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
    });
    expect(routingEvents).toHaveLength(1);
    expect(routingEvents[0]?.[0]).toMatchObject({ name: 'implement' });
    expect(routingEvents[0]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(routingEvents[0]?.[4]).toBe('normal');
    expect(typeof routingEvents[0]?.[5]).toBe('number');
    expect(routingEvents[0]?.[7]).toBe('auto-routing-normal');
  });

  it('Given a normal step needs AI routing, When the router prompt is built, Then it receives raw step instruction only', async () => {
    const step = makeStep('implement', {
      instruction: 'Route using workflow instruction with {task} and {previous_response}',
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const autoRouting = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const config: WorkflowConfig = {
      name: 'auto-routing-normal-ai-raw-instruction',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"selected_candidate":"coding"}',
        });
      }
      return makeResponse({ persona: step.persona, content: 'done' });
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(
      config,
      tmpDir,
      'SECRET_TASK_SHOULD_NOT_REACH_ROUTER',
      createEngineOptions(tmpDir, { autoRouting }),
    );

    const state = await engine.run();
    const routerPrompt = vi.mocked(runAgent).mock.calls.find(([persona]) => persona === 'auto-router')?.[1];

    expect(state.status).toBe('completed');
    expect(routerPrompt).toContain('instruction: Route using workflow instruction with {task} and {previous_response}');
    expect(routerPrompt).not.toContain('SECRET_TASK_SHOULD_NOT_REACH_ROUTER');
    expect(routerPrompt).not.toContain('Previous Response');
    expect(routerPrompt).not.toContain('Report Directory');
  });

  it('Given workflow-level autoRouting and direct engine options omit autoRouting, When a normal step runs, Then the engine uses the workflow-level config', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-workflow-level',
      provider: 'auto',
      autoRouting: createAutoRoutingConfig(),
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarts: StepProviderInfo[] = [];

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'auto',
      providerSource: 'cli',
    });
    engine.on('step:start', (_step, _iteration, _instruction, providerInfo) => {
      stepStarts.push(providerInfo);
    });

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(stepStarts[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: { candidateName: 'coding' },
    });
  });

  it('Given direct engine strategy override requires a missing tier, When constructing the engine, Then validation fails fast', () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-missing-override-tier',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };

    expect(() => new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      autoRouting: {
        ...createAutoRoutingConfig(),
        candidates: [
          {
            name: 'coding',
            description: 'Implementation and tests',
            provider: 'codex',
            model: 'gpt-5',
            costTier: 'medium',
          },
        ],
      },
      autoStrategyOverride: 'performance',
    }))).toThrow(/performance|high|candidate/i);
  });

  it('Given auto routing selects a provider incompatible with a step model, When a normal step runs, Then validation fails fast', async () => {
    const step = makeStep('implement', {
      model: 'sonnet',
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-normal-incompatible-model',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir));

    await expect(engine.run()).rejects.toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given a step explicitly sets provider, When engine provider is auto, Then explicit step provider still wins', async () => {
    const step = makeStep('security-audit', {
      provider: 'claude-sdk',
      model: 'claude-opus-4-20250514',
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-explicit-step',
      initialStep: 'security-audit',
      maxSteps: 1,
      steps: [step],
    };

    engine = new WorkflowEngine(config, tmpDir, 'audit security', createEngineOptions(tmpDir));

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-opus-4-20250514',
    });
  });

  it('Given a step sets only model, When engine provider is auto, Then auto routing selects provider and keeps the step model', async () => {
    const step = makeStep('implement', {
      model: 'gpt-5-step-override',
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-step-model-only',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarts: StepProviderInfo[] = [];

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir));
    engine.on('step:start', (_step, _iteration, _instruction, providerInfo) => {
      stepStarts.push(providerInfo);
    });

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(stepStarts[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-step-override',
      providerSource: 'auto.rules',
      modelSource: 'step',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5-step-override',
    });
  });

  it('Given engine-level model is configured with provider auto, When a rule matches, Then auto routing uses the candidate model', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-engine-model',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarts: StepProviderInfo[] = [];

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      model: 'gpt-5-project-default',
      modelSource: 'project',
    }));
    engine.on('step:start', (_step, _iteration, _instruction, providerInfo) => {
      stepStarts.push(providerInfo);
    });

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(stepStarts[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    });
  });

  it('Given provider_routing sets only model, When engine provider is auto, Then auto routing selects provider and keeps the routed model', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-provider-routing-model-only',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarts: StepProviderInfo[] = [];

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      providerRouting: {
        tags: {
          implementation: {
            model: 'gpt-5-provider-routing',
          },
        },
      },
    }));
    engine.on('step:start', (_step, _iteration, _instruction, providerInfo) => {
      stepStarts.push(providerInfo);
    });

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(stepStarts[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-provider-routing',
      providerSource: 'auto.rules',
      modelSource: 'provider_routing.tags',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5-provider-routing',
    });
  });

  it('Given provider auto on parallel sub-steps, When the parent runs, Then each sub-step receives its own routed provider', async () => {
    const config: WorkflowConfig = {
      name: 'auto-routing-parallel',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('api-review', {
              tags: ['implementation'],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
            makeStep('format-review', {
              tags: ['format'],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('all("approved")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
          ],
        }),
      ],
    };

    const routingEvents: unknown[][] = [];
    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir));
    engine.on('routing:decision', (...args) => {
      routingEvents.push(args);
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'api-review', content: 'approved' }),
      makeResponse({ persona: 'format-review', content: 'approved' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    });
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-haiku-4-5-20251001',
    });
    expect(routingEvents).toHaveLength(2);
    expect(routingEvents[0]?.[0]).toMatchObject({ name: 'api-review' });
    expect(routingEvents[0]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(routingEvents[0]?.[4]).toBe('parallel');
    expect(routingEvents[0]?.[7]).toBe('auto-routing-parallel');
    expect(routingEvents[1]?.[0]).toMatchObject({ name: 'format-review' });
    expect(routingEvents[1]?.[3]).toMatchObject({
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      autoRoutingDecision: { candidateName: 'lightweight' },
    });
    expect(routingEvents[1]?.[4]).toBe('parallel');
    expect(routingEvents[1]?.[7]).toBe('auto-routing-parallel');
  });

  it('Given auto routing selects a provider incompatible with a parallel sub-step model, When the parent runs, Then validation fails fast', async () => {
    const config: WorkflowConfig = {
      name: 'auto-routing-parallel-incompatible-model',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('api-review', {
              model: 'sonnet',
              tags: ['implementation'],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('all("approved")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
          ],
        }),
      ],
    };

    const abortReasons: string[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir));
    engine.on('workflow:abort', (_state, reason) => {
      abortReasons.push(reason);
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons[0]).toMatch(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('Given parallel sub-steps need AI routing, When the parent runs, Then routeBatch receives raw instructions once', async () => {
    const autoRouting = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const codingCandidate = autoRouting.candidates[0]!;
    const lightweightCandidate = autoRouting.candidates[1]!;
    const routeBatch = vi.fn().mockResolvedValue(new Map([
      ['api-review', codingCandidate],
      ['format-review', lightweightCandidate],
    ]));
    const config: WorkflowConfig = {
      name: 'auto-routing-parallel-ai',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('api-review', {
              tags: ['implementation'],
              instruction: 'Review API changes for {task} without expanded context',
              rules: [makeRule('approved', 'COMPLETE')],
            }),
            makeStep('format-review', {
              tags: ['format'],
              instruction: 'Review formatting for {task} without expanded context',
              rules: [makeRule('approved', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('all("approved")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
          ],
        }),
      ],
    };

    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir, {
      autoRouting,
      autoRoutingAiRouter: {
        routeStep: vi.fn(),
        routeBatch,
      },
    }));
    mockRunAgentSequence([
      makeResponse({ persona: 'api-review', content: 'approved' }),
      makeResponse({ persona: 'format-review', content: 'approved' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(routeBatch).toHaveBeenCalledOnce();
    expect(routeBatch.mock.calls[0]?.[1]).toEqual([
      {
        id: 'api-review',
        name: 'api-review',
        tags: ['implementation'],
        personaKey: undefined,
        instruction: 'Review API changes for {task} without expanded context',
      },
      {
        id: 'format-review',
        name: 'format-review',
        tags: ['format'],
        personaKey: undefined,
        instruction: 'Review formatting for {task} without expanded context',
      },
    ]);
    const routedInstructions = routeBatch.mock.calls[0]?.[1].map((step) => step.instruction);
    expect(routedInstructions).toEqual([
      'Review API changes for {task} without expanded context',
      'Review formatting for {task} without expanded context',
    ]);
    expect(routedInstructions?.join('\n')).not.toContain('review feature');
    expect(routedInstructions?.join('\n')).not.toContain('test-report-dir');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    });
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-haiku-4-5-20251001',
    });
  });

  it('Given an auto-routed parallel sub-step rejects, When the parent maps the failure, Then routing telemetry still records the failed decision', async () => {
    const config: WorkflowConfig = {
      name: 'auto-routing-parallel-rejection',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('api-review', {
              tags: ['implementation'],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
            makeStep('format-review', {
              tags: ['format'],
              rules: [makeRule('approved', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('all("approved")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
          ],
        }),
      ],
    };

    const routingEvents: unknown[][] = [];
    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir));
    engine.on('routing:decision', (...args) => {
      routingEvents.push(args);
    });

    queueRunAgentRejection(new Error('agent crashed'));
    mockRunAgentSequence([
      makeResponse({ persona: 'format-review', content: 'approved' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(routingEvents).toHaveLength(2);
    expect(routingEvents[0]?.[0]).toMatchObject({ name: 'api-review' });
    expect(routingEvents[0]?.[1]).toMatchObject({
      status: 'error',
      error: 'agent crashed',
    });
    expect(routingEvents[0]?.[2]).toContain('Run api-review');
    expect(routingEvents[0]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      autoRoutingDecision: { candidateName: 'coding' },
    });
    expect(routingEvents[0]?.[4]).toBe('parallel');
    expect(routingEvents[0]?.[7]).toBe('auto-routing-parallel-rejection');
    expect(routingEvents[1]?.[0]).toMatchObject({ name: 'format-review' });
    expect(routingEvents[1]?.[3]).toMatchObject({
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      autoRoutingDecision: { candidateName: 'lightweight' },
    });
  });
});
