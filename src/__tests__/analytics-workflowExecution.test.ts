/**
 * Tests for analytics integration in workflow execution.
 *
 * Validates the analytics initialization logic (analytics.enabled gate)
 * and event firing for review_finding and fix_action events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import {
  initAnalyticsWriter,
  isAnalyticsEnabled,
  writeAnalyticsEvent,
} from '../features/analytics/index.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import type { AgentResponse, WorkflowStep } from '../core/models/index.js';
import type {
  StepResultEvent,
  ReviewFindingEvent,
  FixActionEvent,
  RoutingDecisionEvent,
} from '../features/analytics/index.js';
import type { StepProviderInfo } from '../core/workflow/types.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';

describe('workflow execution analytics initialization', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-analytics-init-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should enable analytics when analytics.enabled=true', () => {
    const analyticsEnabled = true;
    initAnalyticsWriter(analyticsEnabled, testDir);
    expect(isAnalyticsEnabled()).toBe(true);
  });

  it('should disable analytics when analytics.enabled=false', () => {
    const analyticsEnabled = false;
    initAnalyticsWriter(analyticsEnabled, testDir);
    expect(isAnalyticsEnabled()).toBe(false);
  });

  it('should disable analytics when analytics is undefined', () => {
    const resolveEnabled = (
      analytics: { readonly enabled?: boolean } | undefined,
    ): boolean => analytics?.enabled === true;
    const analyticsEnabled = resolveEnabled(undefined);
    initAnalyticsWriter(analyticsEnabled, testDir);
    expect(isAnalyticsEnabled()).toBe(false);
  });
});

describe('step_result event assembly', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-mvt-result-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should write step_result event with correct fields', () => {
    initAnalyticsWriter(true, testDir);

    const event: StepResultEvent = {
      type: 'step_result',
      step: 'ai_review',
      provider: 'claude',
      model: 'sonnet',
      decisionTag: 'REJECT',
      iteration: 3,
      workflowName: 'peer-review',
      scopeIdentity: 'peer-review-scope',
      runId: 'test-run',
      timestamp: '2026-02-18T10:00:00.000Z',
    };

    writeAnalyticsEvent(event);

    const filePath = join(testDir, '2026-02-18.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as StepResultEvent;

    expect(parsed.type).toBe('step_result');
    expect(parsed.step).toBe('ai_review');
    expect(parsed.decisionTag).toBe('REJECT');
    expect(parsed.iteration).toBe(3);
    expect(parsed.runId).toBe('test-run');
  });
});

describe('routing_decision event assembly', () => {
  let testDir: string;
  let routingEventsDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-routing-decision-${Date.now()}`);
    routingEventsDir = join(testDir, '.takt', 'events');
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes normal step routing decisions from explicit routing event data', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-routing', false);
    const sentinelInstruction = 'Implement API with SECRET_PROMPT_SENTINEL and /tmp/private-repo';
    const step = {
      name: 'implement',
      tags: ['implementation'],
      persona: 'coder',
      instruction: sentinelInstruction,
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    emitter.onRoutingDecision(step, {
      persona: 'coder',
      status: 'done',
      content: 'done',
      timestamp: new Date('2026-02-18T10:00:04.200Z'),
    }, sentinelInstruction, providerInfo, 'normal', 4200, 3, 'auto-workflow');

    const content = readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim();
    const lines = content.split('\n');
    const routingEvent = JSON.parse(lines[0]) as RoutingDecisionEvent;
    expect(routingEvent).toMatchObject({
      type: 'routing_decision',
      stepName: 'implement',
      provider: 'codex',
      model: 'gpt-5',
      selectedCategory: 'coding',
      durationMs: 4200,
      workflowName: 'auto-workflow',
      iteration: 3,
    });
    expect(Object.keys(routingEvent).sort()).toEqual([
      'candidateCount',
      'durationMs',
      'instructionTokenCount',
      'iteration',
      'model',
      'personaKey',
      'phaseCount',
      'provider',
      'requiredRoutingTier',
      'resolutionSource',
      'runId',
      'selectedCategory',
      'selectedRoutingTier',
      'stepName',
      'stepSuccess',
      'stepTags',
      'stepType',
      'strategy',
      'taktVersion',
      'timestamp',
      'type',
      'workflowName',
    ].sort());
    const eventValues = Object.values(routingEvent)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .map(String)
      .join('\n');
    expect(eventValues).not.toContain('SECRET_PROMPT_SENTINEL');
    expect(eventValues).not.toContain('/tmp/private-repo');
  });

  it('does not duplicate routing decisions when the same step completes', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-routing-single', false);
    const step = {
      name: 'implement',
      tags: ['implementation'],
      persona: 'coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };
    const response = {
      persona: 'coder',
      status: 'done',
      content: 'done',
      timestamp: new Date('2026-02-18T10:00:04.200Z'),
    } as const;

    emitter.onRoutingDecision(step, response, 'Implement API', providerInfo, 'normal', 4200, 3, 'auto-workflow');
    emitter.onStepComplete(step, response, {
      iteration: 3,
      provider: 'codex',
      model: 'gpt-5',
      workflowName: 'auto-workflow',
      scopeIdentity: 'auto-workflow-scope',
    });

    const lines = readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim().split('\n');
    const routingEvents = lines
      .map((line) => JSON.parse(line) as StepResultEvent | RoutingDecisionEvent)
      .filter((event) => event.type === 'routing_decision');
    expect(routingEvents).toHaveLength(1);
  });

  it('writes team leader worker routing decisions from explicit routing event data', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-worker-routing', false);
    const partStep = {
      name: 'implement.part-1',
      tags: ['implementation'],
      providerRoutingPersonaKey: 'coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.dynamic',
      modelSource: 'auto.dynamic',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    emitter.onRoutingDecision(
      partStep,
      {
        persona: 'implement.part-1',
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-02-18T10:00:05.000Z'),
      },
      'Implement API',
      providerInfo,
      'agent',
      900,
      4,
      'team-workflow',
    );

    const parsed = JSON.parse(readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim()) as RoutingDecisionEvent;
    expect(parsed).toMatchObject({
      type: 'routing_decision',
      stepName: 'implement.part-1',
      stepType: 'agent',
      durationMs: 900,
      resolutionSource: 'auto.dynamic',
      iteration: 4,
    });
  });

  it.each([
    ['a single semantic candidate', ['approved'], 2],
    ['multiple semantic candidates', ['approved', 'needs_fix'], 3],
  ])('writes the executed phaseCount for %s', (_case, conditions, expectedPhaseCount) => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-phase-count', false);
    const step = {
      name: 'review',
      tags: ['review'],
      persona: 'reviewer',
      instruction: 'Review API',
      outputContracts: [{ name: 'review.md', useJudge: true }],
      rules: conditions.map((condition) => ({
        condition: parseWorkflowRuleCondition(condition),
        next: 'COMPLETE',
      })),
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'claude-sdk',
      model: 'claude-sonnet-4-20250514',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'review',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    emitter.onRoutingDecision(
      step,
      {
        persona: 'reviewer',
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-02-18T10:00:05.000Z'),
      },
      'Review API',
      providerInfo,
      'normal',
      900,
      4,
      'auto-workflow',
    );

    const parsed = JSON.parse(readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim()) as RoutingDecisionEvent;
    expect(parsed.phaseCount).toBe(expectedPhaseCount);
  });

  it('skips non-auto provider sources while still writing auto routing decisions', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-non-auto-source', false);
    const step = {
      name: 'implement',
      tags: ['implementation'],
      persona: 'coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      modelSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    emitter.onRoutingDecision(
      step,
      {
        persona: 'coder',
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-02-18T10:00:05.000Z'),
      },
      'Implement API',
      providerInfo,
      'normal',
      900,
      4,
      'auto-workflow',
    );

    expect(existsSync(join(routingEventsDir, '2026-02-18.jsonl'))).toBe(false);

    emitter.onRoutingDecision(
      step,
      {
        persona: 'coder',
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-02-18T10:00:06.000Z'),
      },
      'Implement API',
      {
        ...providerInfo,
        providerSource: 'auto.rules',
      },
      'normal',
      901,
      4,
      'auto-workflow',
    );

    const parsed = JSON.parse(readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim()) as RoutingDecisionEvent;
    expect(parsed).toMatchObject({
      type: 'routing_decision',
      stepName: 'implement',
      resolutionSource: 'auto.rules',
      selectedCategory: 'coding',
    });
  });

  it('writes routing decisions when auto routing selects the provider and a higher-priority layer selects the model', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter(
      'task-derived-slug',
      false,
      'routing-run-id',
    );
    const step = {
      name: 'implement',
      tags: ['implementation'],
      persona: 'coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5-step-override',
      providerSource: 'auto.rules',
      modelSource: 'step',
      autoRoutingDecision: {
        candidateName: 'coding',
        routingTier: 'medium',
        strategy: 'balanced',
        candidateCount: 2,
      },
    };

    emitter.onRoutingDecision(
      step,
      {
        persona: 'coder',
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-02-18T10:00:05.000Z'),
      },
      'Implement API',
      providerInfo,
      'normal',
      900,
      4,
      'auto-workflow',
    );

    const parsed = JSON.parse(readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim()) as RoutingDecisionEvent;
    expect(parsed).toMatchObject({
      type: 'routing_decision',
      stepName: 'implement',
      provider: 'codex',
      model: 'gpt-5-step-override',
      selectedCategory: 'coding',
      resolutionSource: 'auto.rules',
      runId: 'routing-run-id',
    });
    expect(parsed.runId).not.toBe('task-derived-slug');
  });
});

describe('review_finding event writing', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-review-finding-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should write review_finding events to JSONL', () => {
    initAnalyticsWriter(true, testDir);

    const event: ReviewFindingEvent = {
      type: 'review_finding',
      findingId: 'AA-001',
      status: 'new',
      ruleId: 'AA-001',
      severity: 'warning',
      decision: 'reject',
      file: 'src/foo.ts',
      line: 42,
      iteration: 2,
      workflowName: 'peer-review',
      scopeIdentity: 'peer-review-scope',
      runId: 'test-run',
      timestamp: '2026-02-18T10:00:00.000Z',
    };

    writeAnalyticsEvent(event);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as ReviewFindingEvent;

    expect(parsed.type).toBe('review_finding');
    expect(parsed.findingId).toBe('AA-001');
    expect(parsed.status).toBe('new');
    expect(parsed.decision).toBe('reject');
  });
});

describe('fix_action event writing', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-fix-action-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should write fix_action events with fixed action to JSONL', () => {
    initAnalyticsWriter(true, testDir);

    const event: FixActionEvent = {
      type: 'fix_action',
      findingId: 'AA-001',
      action: 'fixed',
      iteration: 3,
      workflowName: 'peer-review',
      scopeIdentity: 'peer-review-scope',
      runId: 'test-run',
      timestamp: '2026-02-18T11:00:00.000Z',
    };

    writeAnalyticsEvent(event);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as FixActionEvent;

    expect(parsed.type).toBe('fix_action');
    expect(parsed.findingId).toBe('AA-001');
    expect(parsed.action).toBe('fixed');
  });

  it('should write fix_action events with rebutted action to JSONL', () => {
    initAnalyticsWriter(true, testDir);

    const event: FixActionEvent = {
      type: 'fix_action',
      findingId: 'AA-002',
      action: 'rebutted',
      iteration: 4,
      workflowName: 'peer-review',
      scopeIdentity: 'peer-review-scope',
      runId: 'test-run',
      timestamp: '2026-02-18T12:00:00.000Z',
    };

    writeAnalyticsEvent(event);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as FixActionEvent;

    expect(parsed.type).toBe('fix_action');
    expect(parsed.findingId).toBe('AA-002');
    expect(parsed.action).toBe('rebutted');
  });
});
