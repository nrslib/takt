/**
 * Unit tests for FindingTracker
 *
 * Tests finding lifecycle tracking: new → persists → resolved,
 * stagnation detection, and recurrence detection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FindingTracker } from '../core/piece/health-monitor/finding-tracker.js';
import type { RawFinding } from '../core/piece/health-monitor/types.js';

function makeFinding(id: string, status: 'new' | 'persists' | 'resolved'): RawFinding {
  return { id, status, category: 'test', location: 'test.ts:1' };
}

describe('FindingTracker', () => {
  const thresholds = {
    stagnationThreshold: 3,
    loopThreshold: 5,
    recurrenceThreshold: 2,
  };

  let tracker: FindingTracker;

  beforeEach(() => {
    tracker = new FindingTracker(thresholds);
  });

  describe('initial state', () => {
    it('should start with zero tracked findings', () => {
      expect(tracker.getTrackedCount()).toBe(0);
      expect(tracker.getRecords()).toEqual([]);
    });
  });

  describe('new findings', () => {
    it('should track a new finding with status "new" and trend "new"', () => {
      tracker.update([makeFinding('auth-null-check', 'new')]);

      const records = tracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].findingId).toBe('auth-null-check');
      expect(records[0].status).toBe('new');
      expect(records[0].consecutivePersists).toBe(0);
      expect(records[0].recurrenceCount).toBe(0);
      expect(records[0].trend).toBe('new');
    });

    it('should track multiple new findings', () => {
      tracker.update([
        makeFinding('issue-a', 'new'),
        makeFinding('issue-b', 'new'),
      ]);

      expect(tracker.getTrackedCount()).toBe(2);
    });
  });

  describe('persisting findings', () => {
    it('should mark findings as persists when they appear in consecutive updates', () => {
      tracker.update([makeFinding('issue-a', 'new')]);
      tracker.update([makeFinding('issue-a', 'persists')]);

      const records = tracker.getRecords();
      expect(records[0].status).toBe('persists');
      expect(records[0].consecutivePersists).toBe(1);
    });

    it('should increment consecutive persists on each update', () => {
      tracker.update([makeFinding('issue-a', 'new')]);
      tracker.update([makeFinding('issue-a', 'persists')]);
      tracker.update([makeFinding('issue-a', 'persists')]);
      tracker.update([makeFinding('issue-a', 'persists')]);

      const records = tracker.getRecords();
      expect(records[0].consecutivePersists).toBe(3);
      expect(records[0].trend).toBe('stagnating');
    });
  });

  describe('resolved findings', () => {
    it('should mark findings as resolved when they disappear from updates', () => {
      tracker.update([makeFinding('issue-a', 'new')]);
      tracker.update([]);  // issue-a is not present → resolved

      const records = tracker.getRecords();
      expect(records[0].status).toBe('resolved');
      expect(records[0].consecutivePersists).toBe(0);
      expect(records[0].trend).toBe('improving');
    });
  });

  describe('recurrence detection', () => {
    it('should detect recurrence when a resolved finding reappears', () => {
      // Iteration 1: new
      tracker.update([makeFinding('issue-a', 'new')]);
      // Iteration 2: resolved (not present)
      tracker.update([]);
      // Iteration 3: reappears
      tracker.update([makeFinding('issue-a', 'new')]);

      const records = tracker.getRecords();
      expect(records[0].recurrenceCount).toBe(1);
      expect(records[0].status).toBe('new');
    });

    it('should count multiple recurrences and trigger looping trend', () => {
      // First appearance
      tracker.update([makeFinding('issue-a', 'new')]);
      // Resolved
      tracker.update([]);
      // Recurrence 1
      tracker.update([makeFinding('issue-a', 'new')]);
      // Resolved again
      tracker.update([]);
      // Recurrence 2 — hits threshold of 2
      tracker.update([makeFinding('issue-a', 'new')]);

      const records = tracker.getRecords();
      expect(records[0].recurrenceCount).toBe(2);
      expect(records[0].trend).toBe('looping');
    });
  });

  describe('stagnation detection', () => {
    it('should mark trend as stagnating at stagnation threshold', () => {
      tracker.update([makeFinding('issue-a', 'new')]);
      // 3 consecutive persists = stagnation threshold
      for (let i = 0; i < 3; i++) {
        tracker.update([makeFinding('issue-a', 'persists')]);
      }

      const records = tracker.getRecords();
      expect(records[0].trend).toBe('stagnating');
      expect(records[0].consecutivePersists).toBe(3);
    });
  });

  describe('loop detection via consecutive persists', () => {
    it('should mark trend as looping at loop threshold', () => {
      tracker.update([makeFinding('issue-a', 'new')]);
      // 5 consecutive persists = loop threshold
      for (let i = 0; i < 5; i++) {
        tracker.update([makeFinding('issue-a', 'persists')]);
      }

      const records = tracker.getRecords();
      expect(records[0].trend).toBe('looping');
      expect(records[0].consecutivePersists).toBe(5);
    });
  });

  describe('mixed scenarios', () => {
    it('should handle mix of new, persisting, and resolved findings', () => {
      // Iteration 1: two findings
      tracker.update([
        makeFinding('issue-a', 'new'),
        makeFinding('issue-b', 'new'),
      ]);

      // Iteration 2: issue-a persists, issue-b resolved, issue-c new
      tracker.update([
        makeFinding('issue-a', 'persists'),
        makeFinding('issue-c', 'new'),
      ]);

      const records = tracker.getRecords();
      expect(records).toHaveLength(3);

      const a = records.find((r) => r.findingId === 'issue-a');
      const b = records.find((r) => r.findingId === 'issue-b');
      const c = records.find((r) => r.findingId === 'issue-c');

      expect(a?.status).toBe('persists');
      expect(a?.consecutivePersists).toBe(1);
      expect(b?.status).toBe('resolved');
      expect(c?.status).toBe('new');
    });
  });
});
