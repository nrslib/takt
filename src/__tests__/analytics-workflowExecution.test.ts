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
import type { AgentResponse, FindingLedger, WorkflowStep } from '../core/models/index.js';
import type {
  StepResultEvent,
  ReviewFindingEvent,
  FixActionEvent,
  RoutingDecisionEvent,
} from '../features/analytics/index.js';
import type { StepProviderInfo } from '../core/workflow/types.js';

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
    const analytics = undefined;
    const analyticsEnabled = analytics?.enabled === true;
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
    const emitter = new AnalyticsEmitter('run-routing', 'mock', 'test-model', 'auto-workflow');
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
        costTier: 'medium',
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
      'resolutionSource',
      'runId',
      'selectedCategory',
      'selectedCostTier',
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
    const emitter = new AnalyticsEmitter('run-routing-single', 'mock', 'test-model', 'auto-workflow');
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
        costTier: 'medium',
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

    emitter.updateProviderInfo(3, 'codex', 'gpt-5', 'auto-workflow');
    emitter.onRoutingDecision(step, response, 'Implement API', providerInfo, 'normal', 4200, 3, 'auto-workflow');
    emitter.onStepComplete(step, response);

    const lines = readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8').trim().split('\n');
    const routingEvents = lines
      .map((line) => JSON.parse(line) as StepResultEvent | RoutingDecisionEvent)
      .filter((event) => event.type === 'routing_decision');
    expect(routingEvents).toHaveLength(1);
  });

  it('writes team leader worker routing decisions from explicit routing event data', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-worker-routing', 'mock', 'test-model', 'team-workflow');
    const partStep = {
      name: 'implement.part-1',
      tags: ['implementation'],
      providerRoutingPersonaKey: 'coder',
      instruction: 'Implement API',
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.ai',
      modelSource: 'auto.ai',
      autoRoutingDecision: {
        candidateName: 'coding',
        costTier: 'medium',
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
      resolutionSource: 'auto.ai',
      iteration: 4,
    });
  });

  it('writes phaseCount including report and status judgment phases', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-phase-count', 'mock', 'test-model', 'auto-workflow');
    const step = {
      name: 'review',
      tags: ['review'],
      persona: 'reviewer',
      instruction: 'Review API',
      outputContracts: [{ name: 'review.md', useJudge: true }],
      rules: [{ condition: 'approved', next: 'COMPLETE' }],
    } as WorkflowStep;
    const providerInfo: StepProviderInfo = {
      provider: 'claude-sdk',
      model: 'claude-sonnet-4-20250514',
      providerSource: 'auto.rules',
      modelSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'review',
        costTier: 'medium',
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
    expect(parsed.phaseCount).toBe(3);
  });

  it('skips non-auto provider sources while still writing auto routing decisions', () => {
    initAnalyticsWriter(true, testDir, { routingEventsDir });
    const emitter = new AnalyticsEmitter('run-non-auto-source', 'mock', 'test-model', 'auto-workflow');
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
        costTier: 'medium',
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
    const emitter = new AnalyticsEmitter('task-derived-slug', 'mock', 'test-model', 'auto-workflow', 'routing-run-id');
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
        costTier: 'medium',
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

describe('AnalyticsEmitter findings ledger integration', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-finding-ledger-emitter-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes review_finding events from findings ledger updates to JSONL', () => {
    initAnalyticsWriter(true, testDir);
    const emitter = new AnalyticsEmitter('run-ledger', 'mock', 'test-model', 'peer-review');
    const ledger: FindingLedger = {
      version: 1,
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-06-13T02:30:00.000Z',
      findings: [
        {
          id: 'F-0001',
          status: 'open',
          lifecycle: 'new',
          severity: 'high',
          title: 'Secret token should not become ruleId',
          location: 'src/core/workflow/evaluation/RuleEvaluator.ts:48',
          description: 'The workflow cannot route on open findings.',
          suggestion: 'Read the consolidated finding ledger in deterministic rules.',
          reviewers: ['architecture-reviewer'],
          rawFindingIds: ['run:reviewers:1:architecture-review:raw-1'],
          firstSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
          lastSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
        },
      ],
      rawFindings: [],
      conflicts: [],
    };

    emitter.updateProviderInfo(7, 'mock', 'test-model', 'peer-review');
    emitter.onFindingLedgerUpdated(ledger);

    const filePath = join(testDir, '2026-06-13.jsonl');
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content) as ReviewFindingEvent;
    expect(parsed).toMatchObject({
      type: 'review_finding',
      findingId: 'F-0001',
      status: 'new',
      ruleId: 'finding-contract',
      severity: 'error',
      decision: 'reject',
      file: 'src/core/workflow/evaluation/RuleEvaluator.ts',
      line: 48,
      iteration: 7,
      runId: 'run-ledger',
      timestamp: '2026-06-13T02:30:00.000Z',
    });
  });

  it('does not throw when finding ledger analytics writing fails', () => {
    const fileInsteadOfDirectory = join(testDir, 'events-file');
    writeFileSync(fileInsteadOfDirectory, 'not a directory', 'utf-8');
    initAnalyticsWriter(true, fileInsteadOfDirectory);
    const emitter = new AnalyticsEmitter('run-ledger', 'mock', 'test-model', 'peer-review');
    const ledger: FindingLedger = {
      version: 1,
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-06-13T02:30:00.000Z',
      findings: [
        {
          id: 'F-0001',
          status: 'open',
          lifecycle: 'new',
          severity: 'high',
          title: 'Analytics write should not abort workflow',
          reviewers: ['architecture-reviewer'],
          rawFindingIds: ['run:reviewers:1:architecture-review:raw-1'],
          firstSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
          lastSeen: { runId: 'run', stepName: 'reviewers', timestamp: '2026-06-13T02:00:00.000Z' },
        },
      ],
      rawFindings: [],
      conflicts: [],
    };

    expect(() => emitter.onFindingLedgerUpdated(ledger)).not.toThrow();
  });

  it('writes fix_action for seeded finding ids before a ledger update event', () => {
    initAnalyticsWriter(true, testDir);
    const emitter = new AnalyticsEmitter('run-ledger', 'mock', 'test-model', 'peer-review');
    emitter.updateProviderInfo(8, 'mock', 'test-model', 'peer-review');
    emitter.seedFindingContractFindingIds(['F-0001']);

    emitter.onStepComplete(
      { name: 'fix', edit: true } as WorkflowStep,
      {
        persona: 'coder',
        status: 'done',
        content: 'Fixed F-0001 and F-9999.',
        timestamp: new Date('2026-06-13T03:00:00.000Z'),
      } as AgentResponse,
    );

    const filePath = join(testDir, '2026-06-13.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const fixEvent = JSON.parse(lines[1]) as FixActionEvent;
    expect(fixEvent).toMatchObject({
      type: 'fix_action',
      findingId: 'F-0001',
      action: 'fixed',
      iteration: 8,
      runId: 'run-ledger',
      timestamp: '2026-06-13T03:00:00.000Z',
    });
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
