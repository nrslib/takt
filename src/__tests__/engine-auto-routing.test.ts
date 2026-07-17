import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
import type { AutoRoutingAiRouter } from '../agents/auto-routing-usecase.js';
import type { StepProviderInfo, WorkflowEngineOptions } from '../core/workflow/types.js';
import type { AutoRoutingConfig, WorkflowConfig } from '../core/models/index.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { createUsageEventLogger, type UsageEventLoggerConfig } from '../core/logging/usageEventLogger.js';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { ProviderEventLogRecord } from '../core/logging/providerEvent.js';
import type { UsageEventLogRecord } from '../core/logging/usageEvent.js';
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

function createAutoRoutingConfig(): AutoRoutingConfig {
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
  overrides: Partial<WorkflowEngineOptions> = {},
): WorkflowEngineOptions {
  return {
    projectCwd,
    provider: 'mock',
    model: 'top-level-model',
    providerSource: 'project',
    modelSource: 'project',
    autoRouting: createAutoRoutingConfig(),
    ...overrides,
  };
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

  it('Given a concrete top-level provider and effective auto_routing, When a tag rule matches, Then runAgent receives the selected candidate', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      personaDisplayName: 'coder',
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

  it('Given AI routing emits provider events, When the step runs, Then JSONL records the router and selected provider contexts', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-provider-events',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'ai-routing-events',
      runId: 'ai-routing-events-run',
      enabled: true,
    });
    const onStream = vi.fn();
    const onProviderStream = vi.fn((context, event) => providerLogger.logEvent(context, event));
    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      onStream,
      onProviderStream,
    }));
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      if (persona === 'auto-router') {
        options?.onStream?.({ type: 'text', data: { text: 'router-stream' } });
        return makeResponse({
          persona: 'auto-router',
          content: '{"selected_candidate":"coding"}',
          structuredOutput: { selected_candidate: 'coding' },
        });
      }
      options?.onStream?.({
        type: 'init',
        data: {
          model: options.resolvedModel ?? '(default)',
          sessionId: `session-${options.resolvedProvider}`,
        },
      });
      return makeResponse({ persona: step.persona, content: 'done' });
    });
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const providerRecords = readFileSync(providerLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(providerRecords).toEqual([
      expect.objectContaining({
        step: 'implement',
        provider: 'claude-sdk',
        provider_model: 'claude-haiku-4-5-20251001',
        data: { text: 'router-stream' },
      }),
      expect.objectContaining({
        step: 'implement',
        provider: 'codex',
        provider_model: 'gpt-5',
        data: expect.objectContaining({ model: 'gpt-5' }),
      }),
    ]);
    const routerStreamCalls = onStream.mock.calls.filter(([event]) =>
      event.type === 'text' && event.data.text === 'router-stream');
    const routerProviderCalls = onProviderStream.mock.calls.filter(([, event]) =>
      event.type === 'text' && event.data.text === 'router-stream');
    expect(routerStreamCalls).toHaveLength(1);
    expect(routerProviderCalls).toHaveLength(1);
    expect(routerProviderCalls[0]?.[1]).toBe(routerStreamCalls[0]?.[0]);
  });

  it('Given a CLI provider and model with effective auto_routing, When a step runs, Then the CLI pair wins without a routing decision', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-cli-priority',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const routingDecision = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      provider: 'claude-sdk',
      model: 'claude-opus-4-20250514',
      providerSource: 'cli',
      modelSource: 'cli',
    }));
    engine.on('routing:decision', routingDecision);
    mockRunAgentSequence([makeResponse({ persona: step.persona, content: 'done' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-opus-4-20250514',
    });
    expect(routingDecision).not.toHaveBeenCalled();
  });

  it('Given provider_routing with effective auto_routing, When a matching step runs, Then provider_routing wins', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-provider-routing-priority',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarted = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      providerRouting: {
        tags: {
          implementation: { provider: 'mock', model: 'provider-routing-model' },
        },
      },
    }));
    engine.on('step:start', stepStarted);
    mockRunAgentSequence([makeResponse({ persona: step.persona, content: 'done' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const providerInfo = stepStarted.mock.calls[0]?.[3] as StepProviderInfo | undefined;
    expect(providerInfo).toMatchObject({
      provider: 'mock',
      model: 'provider-routing-model',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
    expect(providerInfo?.autoRoutingDecision).toBeUndefined();
  });

  it('Given persona_providers with effective auto_routing, When a matching persona runs, Then persona_providers wins', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      personaDisplayName: 'coder',
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-persona-provider-priority',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarted = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      personaProviders: {
        coder: { provider: 'mock', model: 'persona-model' },
      },
    }));
    engine.on('step:start', stepStarted);
    mockRunAgentSequence([makeResponse({ persona: step.persona, content: 'done' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const providerInfo = stepStarted.mock.calls[0]?.[3] as StepProviderInfo | undefined;
    expect(providerInfo).toMatchObject({
      provider: 'mock',
      model: 'persona-model',
      providerSource: 'persona_providers',
      modelSource: 'persona_providers',
    });
    expect(providerInfo?.autoRoutingDecision).toBeUndefined();
  });

  it('Given no effective auto_routing, When an unoverridden step runs, Then the concrete top-level pair is used', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'concrete-top-level-without-auto-routing',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const stepStarted = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      autoRouting: undefined,
    }));
    engine.on('step:start', stepStarted);
    mockRunAgentSequence([makeResponse({ persona: step.persona, content: 'done' })]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const providerInfo = stepStarted.mock.calls[0]?.[3] as StepProviderInfo | undefined;
    expect(providerInfo).toMatchObject({
      provider: 'mock',
      model: 'top-level-model',
      providerSource: 'project',
      modelSource: 'project',
    });
    expect(providerInfo?.autoRoutingDecision).toBeUndefined();
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

  it('Given workflow-level and config-level autoRouting, When a normal step runs, Then the workflow-level config wins', async () => {
    const step = makeStep('implement', {
      tags: ['implementation'],
      providerRoutingPersonaKey: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-workflow-level',
      provider: 'mock',
      autoRouting: {
        ...createAutoRoutingConfig(),
        rules: { tags: { implementation: 'lightweight' } },
      },
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
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: { candidateName: 'lightweight' },
    });
  });

  it('Given direct engine strategy override requires a missing tier, When constructing the engine, Then validation fails fast', () => {
    const onEffectiveAutoRoutingReached = vi.fn();
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
      onEffectiveAutoRoutingReached,
    }))).toThrow(/performance|high|candidate/i);
    expect(onEffectiveAutoRoutingReached).toHaveBeenCalledOnce();
  });

  it('Given root effective auto routing, When constructing the real engine with a strategy override, Then it reports reaching the configuration once', () => {
    const onEffectiveAutoRoutingReached = vi.fn();
    const config: WorkflowConfig = {
      name: 'auto-routing-root-strategy-notification',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [makeStep('implement', { rules: [makeRule('done', 'COMPLETE')] })],
      autoRouting: createAutoRoutingConfig(),
    };

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      autoStrategyOverride: 'cost',
      onEffectiveAutoRoutingReached,
    }));

    expect(onEffectiveAutoRoutingReached).toHaveBeenCalledOnce();
  });

  it('Given auto routing selects a provider incompatible with a step model, When constructing the engine, Then validation fails fast', () => {
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

    expect(() => new WorkflowEngine(
      config,
      tmpDir,
      'implement feature',
      createEngineOptions(tmpDir),
    )).toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
  });

  it('Given a step explicitly sets provider, When effective auto_routing exists, Then explicit step provider still wins', async () => {
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

  it('Given a step sets only model, When effective auto_routing exists, Then auto routing selects provider and keeps the step model', async () => {
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

  it('Given a top-level concrete model and effective auto_routing, When a rule matches, Then auto routing uses the candidate model', async () => {
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

  it('Given provider_routing sets only model, When effective auto_routing exists, Then auto routing selects provider and keeps the routed model', async () => {
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

  it('Given effective auto_routing and parallel sub-steps, When the parent runs, Then JSONL records each concrete candidate', async () => {
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

    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'parallel-routing',
      runId: 'parallel-routing-run',
      enabled: true,
    });
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'parallel-routing',
      runId: 'parallel-routing-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const routingEvents: unknown[][] = [];
    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir, {
      onProviderStream: (context, event) => providerLogger.logEvent(context, event),
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    }));
    engine.on('routing:decision', (...args) => {
      routingEvents.push(args);
    });

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      options?.onStream?.({
        type: 'init',
        data: {
          model: options.resolvedModel ?? '(default)',
          sessionId: `session-${options.resolvedProvider}`,
        },
      });
      const isCodex = options?.resolvedProvider === 'codex';
      return makeResponse({
        persona: isCodex ? 'api-review' : 'format-review',
        content: 'approved',
        providerUsage: {
          inputTokens: isCodex ? 11 : 21,
          outputTokens: isCodex ? 7 : 9,
          totalTokens: isCodex ? 18 : 30,
          usageMissing: false,
        },
      });
    });
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

    const providerRecords = readFileSync(providerLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(providerRecords).toEqual([
      expect.objectContaining({ step: 'api-review', provider: 'codex' }),
      expect.objectContaining({ step: 'format-review', provider: 'claude-sdk' }),
    ]);
    expect(providerRecords).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'reviewers', provider: 'mock' }),
    ]));

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    expect(usageRecords).toEqual([
      expect.objectContaining({
        step: 'api-review',
        step_type: 'parallel',
        provider: 'codex',
        provider_model: 'gpt-5',
        usage: expect.objectContaining({ total_tokens: 18 }),
      }),
      expect.objectContaining({
        step: 'format-review',
        step_type: 'parallel',
        provider: 'claude-sdk',
        provider_model: 'claude-haiku-4-5-20251001',
        usage: expect.objectContaining({ total_tokens: 30 }),
      }),
    ]);
  });

  it('Given one parallel sub-step has an explicit pair, When effective auto_routing resolves the batch, Then only the unoverridden sibling is routed', async () => {
    const config: WorkflowConfig = {
      name: 'auto-routing-parallel-explicit-priority',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('explicit-review', {
              provider: 'mock',
              model: 'explicit-parallel-model',
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
    const routingDecision = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir));
    engine.on('routing:decision', routingDecision);
    mockRunAgentSequence([
      makeResponse({ persona: 'explicit-review', content: 'approved' }),
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
      resolvedProvider: 'mock',
      resolvedModel: 'explicit-parallel-model',
    });
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-haiku-4-5-20251001',
    });
    expect(routingDecision).toHaveBeenCalledOnce();
    expect(routingDecision.mock.calls[0]?.[0]).toMatchObject({ name: 'format-review' });
  });

  it('Given auto routing selects a provider incompatible with a parallel sub-step model, When constructing the engine, Then validation fails fast', () => {
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

    expect(() => new WorkflowEngine(
      config,
      tmpDir,
      'review feature',
      createEngineOptions(tmpDir),
    )).toThrow(/model 'sonnet'|provider is 'codex'|auto_routing resolved model/i);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('Given cancellation is requested while AI routing, When routing resolves, Then no step starts and no provider call runs', async () => {
    const autoRouting = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const step = makeStep('implement', {
      tags: ['unknown'],
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'auto-routing-cancel-before-step',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [step],
    };
    const routeStep = vi.fn(async () => {
      engine?.abort();
      return autoRouting.candidates[0];
    });
    const stepStart = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'implement feature', createEngineOptions(tmpDir, {
      autoRouting,
      autoRoutingAiRouter: {
        routeStep,
        routeBatch: vi.fn(),
      },
    }));
    engine.on('step:start', stepStart);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(routeStep).toHaveBeenCalledOnce();
    expect(stepStart).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('Given parallel sub-steps need AI routing, When the parent runs, Then routeBatch receives raw instructions once', async () => {
    const autoRouting = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const codingCandidate = autoRouting.candidates[0]!;
    const lightweightCandidate = autoRouting.candidates[1]!;
    const routeBatch = vi.fn<AutoRoutingAiRouter['routeBatch']>().mockResolvedValue(new Map([
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

    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'parallel-rejection',
      runId: 'parallel-rejection-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const routingEvents: unknown[][] = [];
    engine = new WorkflowEngine(config, tmpDir, 'review feature', createEngineOptions(tmpDir, {
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    }));
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

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    expect(usageRecords).toEqual([
      expect.objectContaining({
        step: 'api-review',
        step_type: 'parallel',
        provider: 'codex',
        provider_model: 'gpt-5',
        success: false,
      }),
      expect.objectContaining({
        step: 'format-review',
        step_type: 'parallel',
        provider: 'claude-sdk',
        provider_model: 'claude-haiku-4-5-20251001',
        success: true,
      }),
    ]);
    expect(usageRecords).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'reviewers' }),
    ]));
  });
});
