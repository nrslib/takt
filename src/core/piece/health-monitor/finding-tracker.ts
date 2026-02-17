/**
 * Finding tracker — tracks the lifecycle of findings across iterations.
 *
 * Maintains an immutable history of finding states and computes
 * transitions (new → persists → resolved) and recurrence patterns.
 */

import type { FindingRecord, FindingStatus, FindingTrend, RawFinding } from './types.js';

/** Internal mutable state for a tracked finding */
interface TrackedFinding {
  findingId: string;
  currentStatus: FindingStatus;
  consecutivePersists: number;
  recurrenceCount: number;
  wasResolved: boolean;
}

/**
 * Compute the trend for a finding based on its tracking state.
 */
function computeTrend(tracked: TrackedFinding, stagnationThreshold: number, loopThreshold: number, recurrenceThreshold: number): FindingTrend {
  if (tracked.recurrenceCount >= recurrenceThreshold) {
    return 'looping';
  }
  if (tracked.consecutivePersists >= loopThreshold) {
    return 'looping';
  }
  if (tracked.consecutivePersists >= stagnationThreshold) {
    return 'stagnating';
  }
  if (tracked.currentStatus === 'resolved') {
    return 'improving';
  }
  if (tracked.currentStatus === 'new' && !tracked.wasResolved) {
    return 'new';
  }
  return 'new';
}

/**
 * Tracks finding state transitions across multiple iterations.
 *
 * Usage:
 *   const tracker = new FindingTracker(thresholds);
 *   tracker.update(rawFindings);  // call after each movement
 *   const records = tracker.getRecords();
 */
export class FindingTracker {
  private readonly tracked = new Map<string, TrackedFinding>();
  private readonly stagnationThreshold: number;
  private readonly loopThreshold: number;
  private readonly recurrenceThreshold: number;

  constructor(thresholds: {
    stagnationThreshold: number;
    loopThreshold: number;
    recurrenceThreshold: number;
  }) {
    this.stagnationThreshold = thresholds.stagnationThreshold;
    this.loopThreshold = thresholds.loopThreshold;
    this.recurrenceThreshold = thresholds.recurrenceThreshold;
  }

  /**
   * Update tracker with findings from the current iteration.
   * Computes status transitions for each finding.
   */
  update(rawFindings: readonly RawFinding[]): void {
    const currentIds = new Set(rawFindings.map((f) => f.id));

    for (const [id, tracked] of this.tracked) {
      if (!currentIds.has(id) && tracked.currentStatus !== 'resolved') {
        tracked.currentStatus = 'resolved';
        tracked.consecutivePersists = 0;
        tracked.wasResolved = true;
      }
    }

    for (const raw of rawFindings) {
      const existing = this.tracked.get(raw.id);

      if (!existing) {
        this.tracked.set(raw.id, {
          findingId: raw.id,
          currentStatus: 'new',
          consecutivePersists: 0,
          recurrenceCount: 0,
          wasResolved: false,
        });
        continue;
      }

      if (existing.currentStatus === 'resolved') {
        // Was resolved but reappeared — recurrence
        existing.currentStatus = 'new';
        existing.consecutivePersists = 0;
        existing.recurrenceCount++;
        continue;
      }

      existing.currentStatus = 'persists';
      existing.consecutivePersists++;
    }
  }

  /**
   * Get immutable finding records with computed trends.
   */
  getRecords(): readonly FindingRecord[] {
    const records: FindingRecord[] = [];

    for (const tracked of this.tracked.values()) {
      const trend = computeTrend(
        tracked,
        this.stagnationThreshold,
        this.loopThreshold,
        this.recurrenceThreshold,
      );

      records.push({
        findingId: tracked.findingId,
        status: tracked.currentStatus,
        consecutivePersists: tracked.consecutivePersists,
        recurrenceCount: tracked.recurrenceCount,
        trend,
      });
    }

    return records;
  }

  /**
   * Get the number of tracked findings.
   */
  getTrackedCount(): number {
    return this.tracked.size;
  }
}
