/**
 * Tests for analytics metrics computation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeReviewMetrics,
  formatReviewMetrics,
  parseSinceDuration,
} from '../features/analytics/index.js';
import type {
  ReviewFindingEvent,
  FixActionEvent,
  MovementResultEvent,
} from '../features/analytics/index.js';

describe('analytics metrics', () => {
  let eventsDir: string;

  beforeEach(() => {
    eventsDir = join(tmpdir(), `takt-test-analytics-metrics-${Date.now()}`);
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(eventsDir, { recursive: true, force: true });
  });

  function writeEvents(date: string, events: Array<ReviewFindingEvent | FixActionEvent | MovementResultEvent>): void {
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(eventsDir, `${date}.jsonl`), lines, 'utf-8');
  }

  describe('computeReviewMetrics', () => {
    it('should return empty metrics when no events exist', () => {
      const sinceMs = new Date('2026-01-01T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      expect(metrics.reReportCounts.size).toBe(0);
      expect(metrics.roundTripRatio).toBe(0);
      expect(metrics.averageResolutionIterations).toBe(0);
      expect(metrics.rejectCountsByRule.size).toBe(0);
      expect(metrics.rebuttalResolvedRatio).toBe(0);
    });

    it('should return empty metrics when directory does not exist', () => {
      const nonExistent = join(eventsDir, 'does-not-exist');
      const sinceMs = new Date('2026-01-01T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(nonExistent, sinceMs);

      expect(metrics.reReportCounts.size).toBe(0);
    });

    it('should compute re-report counts for findings appearing 2+ times', () => {
      const events: ReviewFindingEvent[] = [
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
          runId: 'run-1',
          timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding',
          findingId: 'f-001',
          status: 'persists',
          ruleId: 'r-1',
          severity: 'error',
          decision: 'reject',
          file: 'a.ts',
          line: 1,
          iteration: 3,
          runId: 'run-1',
          timestamp: '2026-02-18T11:00:00.000Z',
        },
        {
          type: 'review_finding',
          findingId: 'f-002',
          status: 'new',
          ruleId: 'r-2',
          severity: 'warning',
          decision: 'approve',
          file: 'b.ts',
          line: 5,
          iteration: 1,
          runId: 'run-1',
          timestamp: '2026-02-18T10:01:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      expect(metrics.reReportCounts.size).toBe(1);
      expect(metrics.reReportCounts.get('f-001')).toBe(2);
    });

    it('should compute round-trip ratio correctly', () => {
      const events: ReviewFindingEvent[] = [
        // f-001: appears in iterations 1 and 3 → multi-iteration
        {
          type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'r-1', severity: 'error',
          decision: 'reject', file: 'a.ts', line: 1, iteration: 1, runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-001', status: 'persists', ruleId: 'r-1', severity: 'error',
          decision: 'reject', file: 'a.ts', line: 1, iteration: 3, runId: 'r', timestamp: '2026-02-18T11:00:00.000Z',
        },
        // f-002: appears only in iteration 1 → single-iteration
        {
          type: 'review_finding', findingId: 'f-002', status: 'new', ruleId: 'r-2', severity: 'warning',
          decision: 'approve', file: 'b.ts', line: 5, iteration: 1, runId: 'r', timestamp: '2026-02-18T10:01:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      // 1 out of 2 unique findings had multi-iteration → 50%
      expect(metrics.roundTripRatio).toBe(0.5);
    });

    it('should compute average resolution iterations', () => {
      const events: ReviewFindingEvent[] = [
        // f-001: first in iteration 1, resolved in iteration 3 → 3 iterations
        {
          type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'r-1', severity: 'error',
          decision: 'reject', file: 'a.ts', line: 1, iteration: 1, runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-001', status: 'resolved', ruleId: 'r-1', severity: 'error',
          decision: 'approve', file: 'a.ts', line: 1, iteration: 3, runId: 'r', timestamp: '2026-02-18T12:00:00.000Z',
        },
        // f-002: first in iteration 2, resolved in iteration 2 → 1 iteration
        {
          type: 'review_finding', findingId: 'f-002', status: 'new', ruleId: 'r-2', severity: 'warning',
          decision: 'reject', file: 'b.ts', line: 5, iteration: 2, runId: 'r', timestamp: '2026-02-18T11:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-002', status: 'resolved', ruleId: 'r-2', severity: 'warning',
          decision: 'approve', file: 'b.ts', line: 5, iteration: 2, runId: 'r', timestamp: '2026-02-18T11:30:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      // (3 + 1) / 2 = 2.0
      expect(metrics.averageResolutionIterations).toBe(2);
    });

    it('should compute reject counts by rule', () => {
      const events: ReviewFindingEvent[] = [
        {
          type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'no-any',
          severity: 'error', decision: 'reject', file: 'a.ts', line: 1, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-002', status: 'new', ruleId: 'no-any',
          severity: 'error', decision: 'reject', file: 'b.ts', line: 2, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:01:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-003', status: 'new', ruleId: 'no-console',
          severity: 'warning', decision: 'reject', file: 'c.ts', line: 3, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:02:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-004', status: 'new', ruleId: 'no-any',
          severity: 'error', decision: 'approve', file: 'd.ts', line: 4, iteration: 2,
          runId: 'r', timestamp: '2026-02-18T10:03:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      expect(metrics.rejectCountsByRule.get('no-any')).toBe(2);
      expect(metrics.rejectCountsByRule.get('no-console')).toBe(1);
    });

    it('should compute rebuttal resolved ratio', () => {
      const events: Array<ReviewFindingEvent | FixActionEvent> = [
        // f-001: rebutted, then resolved → counts toward resolved
        {
          type: 'fix_action', findingId: 'AA-NEW-f001', action: 'rebutted',
          iteration: 2, runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'AA-NEW-f001', status: 'resolved', ruleId: 'r-1',
          severity: 'warning', decision: 'approve', file: 'a.ts', line: 1,
          iteration: 3, runId: 'r', timestamp: '2026-02-18T11:00:00.000Z',
        },
        // f-002: rebutted, never resolved → not counted
        {
          type: 'fix_action', findingId: 'AA-NEW-f002', action: 'rebutted',
          iteration: 2, runId: 'r', timestamp: '2026-02-18T10:01:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'AA-NEW-f002', status: 'persists', ruleId: 'r-2',
          severity: 'error', decision: 'reject', file: 'b.ts', line: 5,
          iteration: 3, runId: 'r', timestamp: '2026-02-18T11:01:00.000Z',
        },
        // f-003: fixed (not rebutted), resolved → does not affect rebuttal metric
        {
          type: 'fix_action', findingId: 'AA-NEW-f003', action: 'fixed',
          iteration: 2, runId: 'r', timestamp: '2026-02-18T10:02:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'AA-NEW-f003', status: 'resolved', ruleId: 'r-3',
          severity: 'warning', decision: 'approve', file: 'c.ts', line: 10,
          iteration: 3, runId: 'r', timestamp: '2026-02-18T11:02:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      // 1 out of 2 rebutted findings was resolved → 50%
      expect(metrics.rebuttalResolvedRatio).toBe(0.5);
    });

    it('should return 0 rebuttal resolved ratio when no rebutted events exist', () => {
      const events: ReviewFindingEvent[] = [
        {
          type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'r-1',
          severity: 'error', decision: 'reject', file: 'a.ts', line: 1, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
      ];

      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      expect(metrics.rebuttalResolvedRatio).toBe(0);
    });

    it('should only include events after the since timestamp', () => {
      const events: ReviewFindingEvent[] = [
        {
          type: 'review_finding', findingId: 'f-old', status: 'new', ruleId: 'r-1',
          severity: 'error', decision: 'reject', file: 'old.ts', line: 1, iteration: 1,
          runId: 'r', timestamp: '2026-02-10T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-new', status: 'new', ruleId: 'r-1',
          severity: 'error', decision: 'reject', file: 'new.ts', line: 1, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
      ];

      // Write both events to the same date file for simplicity (old event in same file)
      writeEvents('2026-02-10', [events[0]]);
      writeEvents('2026-02-18', [events[1]]);

      // Since Feb 15 — should only include f-new
      const sinceMs = new Date('2026-02-15T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);

      expect(metrics.rejectCountsByRule.get('r-1')).toBe(1);
    });
  });

  describe('formatReviewMetrics', () => {
    it('should format empty metrics', () => {
      const metrics = computeReviewMetrics(eventsDir, 0);
      const output = formatReviewMetrics(metrics);

      expect(output).toContain('=== Review Metrics ===');
      expect(output).toContain('(none)');
      expect(output).toContain('Round-trip ratio');
      expect(output).toContain('Average resolution iterations');
      expect(output).toContain('Rebuttal');
    });

    it('should format metrics with data', () => {
      const events: ReviewFindingEvent[] = [
        {
          type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'r-1',
          severity: 'error', decision: 'reject', file: 'a.ts', line: 1, iteration: 1,
          runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
        },
        {
          type: 'review_finding', findingId: 'f-001', status: 'persists', ruleId: 'r-1',
          severity: 'error', decision: 'reject', file: 'a.ts', line: 1, iteration: 3,
          runId: 'r', timestamp: '2026-02-18T11:00:00.000Z',
        },
      ];
      writeEvents('2026-02-18', events);

      const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
      const metrics = computeReviewMetrics(eventsDir, sinceMs);
      const output = formatReviewMetrics(metrics);

      expect(output).toContain('f-001: 2');
      expect(output).toContain('r-1: 2');
    });
  });

  describe('parseSinceDuration', () => {
    it('should parse "7d" to 7 days in milliseconds', () => {
      const ms = parseSinceDuration('7d');
      expect(ms).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse "30d" to 30 days in milliseconds', () => {
      const ms = parseSinceDuration('30d');
      expect(ms).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('should parse "1d" to 1 day in milliseconds', () => {
      const ms = parseSinceDuration('1d');
      expect(ms).toBe(24 * 60 * 60 * 1000);
    });

    it('should throw on invalid format', () => {
      expect(() => parseSinceDuration('7h')).toThrow('Invalid duration format');
      expect(() => parseSinceDuration('abc')).toThrow('Invalid duration format');
      expect(() => parseSinceDuration('')).toThrow('Invalid duration format');
    });
  });
});
