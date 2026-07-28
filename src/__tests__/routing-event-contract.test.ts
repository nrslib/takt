import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkRequirementEstimator } from '../agents/auto-routing-usecase.js';
import { runAgent } from '../agents/runner.js';
import { resolveAutoRoutingRuntime } from '../core/workflow/auto-routing/resolver.js';
import { RoutingRuntime } from '../core/workflow/auto-routing/runtime.js';
import type { AutoRoutingConfig, WorkflowStep } from '../core/models/index.js';
import type { StepProviderInfo } from '../core/workflow/types.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

function createAutoRoutingConfig(rules: AutoRoutingConfig['rules'] = {}): AutoRoutingConfig {
  return {
    strategy: 'cost',
    router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
    candidates: [
      { name: 'terra', provider: 'codex', model: 'gpt-5', routingTier: 'medium' },
      { name: 'sol', provider: 'claude-sdk', model: 'claude-opus-4-20250514', routingTier: 'high' },
    ],
    defaultPool: 'general',
    candidatePools: { general: { candidates: ['terra', 'sol'], fallback: 'sol' } },
    rules,
  };
}

function createSnapshot() {
  return {
    goal: 'Apply the requested change',
    step: { name: 'implement', tags: ['implementation'], stepType: 'normal' as const, edit: true },
    remainingWork: [{ source: 'task' as const, description: 'Apply the requested change' }],
    progress: { previousAttemptFailed: false, noProgress: false, retryingSameWork: false },
  };
}

describe('routing event contract', () => {
  let testDir: string;
  let routingEventsDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-routing-event-contract-${Date.now()}`);
    routingEventsDir = join(testDir, '.takt', 'events');
    mkdirSync(testDir, { recursive: true });
    initAnalyticsWriter(true, testDir, { routingEventsDir });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sets requiredRoutingTier for dynamic, hard-rule, and explicit-fallback resolutions', async () => {
    const dynamic = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: { name: 'implement', tags: [] },
      snapshot: createSnapshot(),
      estimator: { estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }) },
      currentProviderInfo: { provider: undefined, model: undefined },
    });
    const hardRule = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig({ tags: { implementation: 'terra' } }),
      step: { name: 'implement', tags: ['implementation'] },
      snapshot: createSnapshot(),
      estimator: { estimate: vi.fn() },
      currentProviderInfo: { provider: undefined, model: undefined },
    });
    const fallback = await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: { name: 'implement', tags: [] },
      snapshot: createSnapshot(),
      estimator: { estimate: vi.fn().mockRejectedValue(new Error('router unavailable')) },
      currentProviderInfo: { provider: undefined, model: undefined },
    });

    const providerInfos = [
      dynamic?.providerInfo,
      hardRule?.providerInfo,
      fallback?.providerInfo,
    ];
    for (const providerInfo of providerInfos) {
      expect(providerInfo).toBeDefined();
      emitRoutingDecision(providerInfo!);
    }

    const events = readFileSync(join(routingEventsDir, '2026-07-26.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { resolutionSource: string; requiredRoutingTier: string })
      .map(({ resolutionSource, requiredRoutingTier }) => ({ resolutionSource, requiredRoutingTier }));
    expect(events).toEqual([
      { resolutionSource: 'auto.dynamic', requiredRoutingTier: 'medium' },
      { resolutionSource: 'auto.rules', requiredRoutingTier: 'medium' },
      { resolutionSource: 'auto.fallback', requiredRoutingTier: 'high' },
    ]);
  });

  it('converts untrusted estimator reason codes into fallback without persisting task, credential, or path text', async () => {
    const taskBody = 'task body: reset the deployment account';
    const credential = 'api_key=secret-value';
    const path = '/tmp/private-routing-repo';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({ required_tier: 'medium', reason_codes: [taskBody, credential, path] }),
      timestamp: new Date('2026-07-26T00:00:00.000Z'),
    });
    const providerInfo = (await resolveAutoRoutingRuntime({
      autoRouting: createAutoRoutingConfig(),
      step: { name: 'implement', tags: [] },
      snapshot: createSnapshot(),
      estimator: createWorkRequirementEstimator({
        cwd: '/repo', provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001',
      }),
      currentProviderInfo: { provider: undefined, model: undefined },
    }))?.providerInfo;

    expect(providerInfo?.autoRoutingDecision).toMatchObject({
      requiredTier: 'high',
      fallbackReason: 'estimator-failure',
    });
    emitRoutingDecision(providerInfo!);

    const eventText = readFileSync(join(routingEventsDir, '2026-07-26.jsonl'), 'utf-8');
    expect(eventText).not.toContain(taskBody);
    expect(eventText).not.toContain(credential);
    expect(eventText).not.toContain(path);
  });

  it('records no-progress distinctly from a failed attempt', async () => {
    const estimator = { estimate: vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] }) };
    const runtime = new RoutingRuntime({ autoRouting: createAutoRoutingConfig(), estimator });
    const input = {
      autoRouting: createAutoRoutingConfig(),
      scope: 'implement',
      step: { name: 'implement', tags: [] },
      snapshot: createSnapshot(),
      estimator,
      runtime,
      currentProviderInfo: { provider: undefined, model: undefined },
    };

    await resolveAutoRoutingRuntime(input);
    runtime.recordExecutionResult({ scope: 'implement', status: 'done' });
    const retry = await resolveAutoRoutingRuntime(input);

    expect(retry?.providerInfo.autoRoutingDecision?.retryReason).toBe('no-progress');
    emitRoutingDecision(retry!.providerInfo);
    const event = JSON.parse(readFileSync(join(routingEventsDir, '2026-07-26.jsonl'), 'utf-8')) as { retryReason?: string };
    expect(event.retryReason).toBe('no-progress');
  });

  it('rejects a manually injected invalid reason code at the event-write boundary', () => {
    emitRoutingDecision({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.dynamic',
      modelSource: 'auto.dynamic',
      autoRoutingDecision: {
        candidateName: 'terra',
        routingTier: 'medium',
        requiredTier: 'medium',
        reasonCodes: ['task body password=hunter2'],
        strategy: 'cost',
        candidateCount: 2,
      },
    });

    expect(existsSync(join(routingEventsDir, '2026-07-26.jsonl'))).toBe(false);
  });

  it('persists only normalized step metadata for normal, parallel, and team leader routing events', () => {
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.dynamic',
      modelSource: 'auto.dynamic',
      autoRoutingDecision: {
        candidateName: 'terra',
        routingTier: 'medium',
        requiredTier: 'medium',
        strategy: 'cost',
        candidateCount: 2,
      },
    };
    const metadataByStepType = [
      {
        stepType: 'normal' as const,
        name: 'normal.password=normal-name-credential',
        tag: 'normal-token=normal-tag-credential',
        persona: 'normal.api_key=normal-persona-credential',
      },
      {
        stepType: 'parallel' as const,
        name: 'parallel.password=parallel-name-credential',
        tag: 'parallel-token=parallel-tag-credential',
        persona: 'parallel.api_key=parallel-persona-credential',
      },
      {
        stepType: 'agent' as const,
        name: 'leader.password=leader-name-credential',
        tag: 'leader-token=leader-tag-credential',
        persona: 'leader.api_key=leader-persona-credential',
      },
    ];
    const emitter = new AnalyticsEmitter('routing-contract', false);

    for (const metadata of metadataByStepType) {
      emitter.onRoutingDecision(
        { name: metadata.name, tags: [metadata.tag], persona: metadata.persona } as WorkflowStep,
        { persona: 'coder', status: 'done', content: 'done', timestamp: new Date('2026-07-26T00:00:00.000Z') },
        'Apply the requested change',
        providerInfo,
        metadata.stepType,
        1,
        1,
        'workflow',
      );
    }

    const eventText = readFileSync(join(routingEventsDir, '2026-07-26.jsonl'), 'utf-8');
    for (const metadata of metadataByStepType) {
      expect(eventText).not.toContain(metadata.name);
      expect(eventText).not.toContain(metadata.tag);
      expect(eventText).not.toContain(metadata.persona);
    }
    const events = eventText.trim().split('\n')
      .map((line) => JSON.parse(line) as {
        stepName: string;
        stepTags: string[];
        personaKey: string;
      })
      .map(({ stepName, stepTags, personaKey }) => ({ stepName, stepTags, personaKey }));
    expect(events).toEqual([
      {
        stepName: 'normal.password=[REDACTED]',
        stepTags: ['normal-token=[REDACTED]'],
        personaKey: 'normal.api_key=[REDACTED]',
      },
      {
        stepName: 'parallel.password=[REDACTED]',
        stepTags: ['parallel-token=[REDACTED]'],
        personaKey: 'parallel.api_key=[REDACTED]',
      },
      {
        stepName: 'leader.password=[REDACTED]',
        stepTags: ['leader-token=[REDACTED]'],
        personaKey: 'leader.api_key=[REDACTED]',
      },
    ]);
  });

  it('redacts and truncates all free-text routing decision metadata before persistence', () => {
    const secretMetadata = {
      workflowName: 'workflow.password=workflow-credential',
      provider: 'provider.api_key=provider-credential',
      model: 'model.token=model-credential',
      candidateName: 'candidate.secret=candidate-credential',
    };
    const longMetadata = 'overlong routing metadata '.repeat(100);
    const emitter = new AnalyticsEmitter('routing-contract', false);

    emitter.onRoutingDecision(
      { name: 'implement', tags: ['implementation'], persona: 'coder' } as WorkflowStep,
      { persona: 'coder', status: 'done', content: 'done', timestamp: new Date('2026-07-26T00:00:00.000Z') },
      'Apply the requested change',
      {
        provider: secretMetadata.provider,
        model: secretMetadata.model,
        providerSource: 'auto.dynamic',
        modelSource: 'auto.dynamic',
        autoRoutingDecision: {
          candidateName: secretMetadata.candidateName,
          routingTier: 'medium',
          requiredTier: 'medium',
          strategy: 'cost',
          candidateCount: 2,
        },
      },
      'normal',
      1,
      1,
      secretMetadata.workflowName,
    );
    emitter.onRoutingDecision(
      { name: 'implement', tags: ['implementation'], persona: 'coder' } as WorkflowStep,
      { persona: 'coder', status: 'done', content: 'done', timestamp: new Date('2026-07-26T00:00:00.000Z') },
      'Apply the requested change',
      {
        provider: longMetadata,
        model: longMetadata,
        providerSource: 'auto.dynamic',
        modelSource: 'auto.dynamic',
        autoRoutingDecision: {
          candidateName: longMetadata,
          routingTier: 'medium',
          requiredTier: 'medium',
          strategy: 'cost',
          candidateCount: 2,
        },
      },
      'normal',
      1,
      1,
      longMetadata,
    );

    const eventText = readFileSync(join(routingEventsDir, '2026-07-26.jsonl'), 'utf-8');
    for (const value of Object.values(secretMetadata)) {
      expect(eventText).not.toContain(value);
    }
    const events = eventText.trim().split('\n')
      .map((line) => JSON.parse(line) as {
        workflowName: string;
        provider: string;
        model: string;
        selectedCategory: string;
      })
      .map(({ workflowName, provider, model, selectedCategory }) => ({
        workflowName,
        provider,
        model,
        selectedCategory,
      }));
    expect(events[0]).toMatchObject({
      workflowName: 'workflow.password=[REDACTED]',
      provider: 'provider.api_key=[REDACTED]',
      model: 'model.token=[REDACTED]',
      selectedCategory: 'candidate.secret=[REDACTED]',
    });
    for (const value of Object.values(events[1])) {
      expect(value.length).toBeLessThanOrEqual(2_000);
    }
  });

  function emitRoutingDecision(providerInfo: StepProviderInfo): void {
    const emitter = new AnalyticsEmitter('routing-contract', false);
    emitter.onRoutingDecision(
      { name: 'implement', tags: ['implementation'], persona: 'coder' } as WorkflowStep,
      { persona: 'coder', status: 'done', content: 'done', timestamp: new Date('2026-07-26T00:00:00.000Z') },
      'Apply the requested change',
      providerInfo,
      'normal',
      1,
      1,
      'workflow',
    );
  }
});
