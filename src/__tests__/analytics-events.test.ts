/**
 * Tests for analytics event type definitions.
 *
 * Validates that event objects conform to the expected shape.
 */

import { describe, it, expect } from 'vitest';
import type {
  ReviewFindingEvent,
  FixActionEvent,
  MovementResultEvent,
  AnalyticsEvent,
} from '../features/analytics/index.js';

describe('analytics event types', () => {
  it('should create a valid ReviewFindingEvent', () => {
    const event: ReviewFindingEvent = {
      type: 'review_finding',
      findingId: 'f-001',
      status: 'new',
      ruleId: 'no-console-log',
      severity: 'warning',
      decision: 'reject',
      file: 'src/main.ts',
      line: 42,
      iteration: 1,
      runId: 'run-abc',
      timestamp: '2026-02-18T10:00:00.000Z',
    };

    expect(event.type).toBe('review_finding');
    expect(event.findingId).toBe('f-001');
    expect(event.status).toBe('new');
    expect(event.severity).toBe('warning');
    expect(event.decision).toBe('reject');
    expect(event.file).toBe('src/main.ts');
    expect(event.line).toBe(42);
  });

  it('should create a valid FixActionEvent with fixed action', () => {
    const event: FixActionEvent = {
      type: 'fix_action',
      findingId: 'f-001',
      action: 'fixed',
      iteration: 2,
      runId: 'run-abc',
      timestamp: '2026-02-18T10:01:00.000Z',
    };

    expect(event.type).toBe('fix_action');
    expect(event.action).toBe('fixed');
    expect(event.findingId).toBe('f-001');
  });

  it('should create a valid FixActionEvent with rebutted action', () => {
    const event: FixActionEvent = {
      type: 'fix_action',
      findingId: 'f-002',
      action: 'rebutted',
      iteration: 3,
      runId: 'run-abc',
      timestamp: '2026-02-18T10:02:00.000Z',
    };

    expect(event.type).toBe('fix_action');
    expect(event.action).toBe('rebutted');
    expect(event.findingId).toBe('f-002');
  });

  it('should create a valid MovementResultEvent', () => {
    const event: MovementResultEvent = {
      type: 'movement_result',
      movement: 'implement',
      provider: 'claude',
      model: 'sonnet',
      decisionTag: 'approved',
      iteration: 3,
      runId: 'run-abc',
      timestamp: '2026-02-18T10:02:00.000Z',
    };

    expect(event.type).toBe('movement_result');
    expect(event.movement).toBe('implement');
    expect(event.provider).toBe('claude');
    expect(event.decisionTag).toBe('approved');
  });

  it('should discriminate event types via the type field', () => {
    const events: AnalyticsEvent[] = [
      {
        type: 'review_finding',
        findingId: 'f-001',
        status: 'new',
        ruleId: 'r-1',
        severity: 'error',
        decision: 'reject',
        file: 'a.ts',
        line: 1,
        iteration: 1,
        runId: 'r',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'fix_action',
        findingId: 'f-001',
        action: 'fixed',
        iteration: 2,
        runId: 'r',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        type: 'movement_result',
        movement: 'plan',
        provider: 'claude',
        model: 'opus',
        decisionTag: 'done',
        iteration: 1,
        runId: 'r',
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ];

    const reviewEvents = events.filter((e) => e.type === 'review_finding');
    expect(reviewEvents).toHaveLength(1);

    const fixEvents = events.filter((e) => e.type === 'fix_action');
    expect(fixEvents).toHaveLength(1);

    const movementEvents = events.filter((e) => e.type === 'movement_result');
    expect(movementEvents).toHaveLength(1);
  });
});
