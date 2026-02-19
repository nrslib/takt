/**
 * Tests for analytics integration in pieceExecution.
 *
 * Validates the analytics initialization logic (analytics.enabled gate)
 * and event firing for review_finding and fix_action events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import {
  initAnalyticsWriter,
  isAnalyticsEnabled,
  writeAnalyticsEvent,
} from '../features/analytics/index.js';
import type {
  MovementResultEvent,
  ReviewFindingEvent,
  FixActionEvent,
} from '../features/analytics/index.js';

describe('pieceExecution analytics initialization', () => {
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

describe('movement_result event assembly', () => {
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

  it('should write movement_result event with correct fields', () => {
    initAnalyticsWriter(true, testDir);

    const event: MovementResultEvent = {
      type: 'movement_result',
      movement: 'ai_review',
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
    const parsed = JSON.parse(content) as MovementResultEvent;

    expect(parsed.type).toBe('movement_result');
    expect(parsed.movement).toBe('ai_review');
    expect(parsed.decisionTag).toBe('REJECT');
    expect(parsed.iteration).toBe(3);
    expect(parsed.runId).toBe('test-run');
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
