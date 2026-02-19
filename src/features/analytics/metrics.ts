/**
 * Analytics metrics computation from JSONL event files.
 *
 * Reads events from ~/.takt/analytics/events/*.jsonl and computes
 * five key indicators for review quality assessment.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyticsEvent, ReviewFindingEvent, FixActionEvent } from './events.js';

/** Aggregated metrics output */
export interface ReviewMetrics {
  /** Re-report count per finding_id (same finding raised more than once) */
  reReportCounts: Map<string, number>;
  /** Ratio of findings that required 2+ round-trips before resolution */
  roundTripRatio: number;
  /** Average number of iterations to resolve a finding */
  averageResolutionIterations: number;
  /** Number of REJECT decisions per rule_id */
  rejectCountsByRule: Map<string, number>;
  /** Ratio of rebutted findings that were subsequently resolved */
  rebuttalResolvedRatio: number;
}

/**
 * Compute review metrics from events within a time window.
 *
 * @param eventsDir Absolute path to the analytics events directory
 * @param sinceMs Epoch ms — only events after this time are included
 */
export function computeReviewMetrics(eventsDir: string, sinceMs: number): ReviewMetrics {
  const events = loadEventsAfter(eventsDir, sinceMs);
  const reviewFindings = events.filter(
    (e): e is ReviewFindingEvent => e.type === 'review_finding',
  );
  const fixActions = events.filter(
    (e): e is FixActionEvent => e.type === 'fix_action',
  );

  return {
    reReportCounts: computeReReportCounts(reviewFindings),
    roundTripRatio: computeRoundTripRatio(reviewFindings),
    averageResolutionIterations: computeAverageResolutionIterations(reviewFindings),
    rejectCountsByRule: computeRejectCountsByRule(reviewFindings),
    rebuttalResolvedRatio: computeRebuttalResolvedRatio(fixActions, reviewFindings),
  };
}

/**
 * Format review metrics for CLI display.
 */
export function formatReviewMetrics(metrics: ReviewMetrics): string {
  const lines: string[] = [];
  lines.push('=== Review Metrics ===');
  lines.push('');

  lines.push('Re-report counts (finding_id → count):');
  if (metrics.reReportCounts.size === 0) {
    lines.push('  (none)');
  } else {
    for (const [findingId, count] of metrics.reReportCounts) {
      lines.push(`  ${findingId}: ${count}`);
    }
  }
  lines.push('');

  lines.push(`Round-trip ratio (2+ iterations): ${(metrics.roundTripRatio * 100).toFixed(1)}%`);
  lines.push(`Average resolution iterations: ${metrics.averageResolutionIterations.toFixed(2)}`);
  lines.push('');

  lines.push('REJECT counts by rule:');
  if (metrics.rejectCountsByRule.size === 0) {
    lines.push('  (none)');
  } else {
    for (const [ruleId, count] of metrics.rejectCountsByRule) {
      lines.push(`  ${ruleId}: ${count}`);
    }
  }
  lines.push('');

  lines.push(`Rebuttal → resolved ratio: ${(metrics.rebuttalResolvedRatio * 100).toFixed(1)}%`);

  return lines.join('\n');
}

// ---- Internal helpers ----

/** Load all events from JSONL files whose date >= since */
function loadEventsAfter(eventsDir: string, sinceMs: number): AnalyticsEvent[] {
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);

  let files: string[];
  try {
    files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  const relevantFiles = files.filter((f) => {
    const dateStr = f.replace('.jsonl', '');
    return dateStr >= sinceDate;
  });

  const events: AnalyticsEvent[] = [];
  for (const file of relevantFiles) {
    const content = readFileSync(join(eventsDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AnalyticsEvent;
      if (new Date(event.timestamp).getTime() >= sinceMs) {
        events.push(event);
      }
    }
  }

  return events;
}

/** Count how many times each finding_id appears (only those appearing 2+) */
function computeReReportCounts(findings: ReviewFindingEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.findingId, (counts.get(f.findingId) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const [id, count] of counts) {
    if (count >= 2) {
      result.set(id, count);
    }
  }
  return result;
}

/** Ratio of findings that appear in 2+ iterations before resolution */
function computeRoundTripRatio(findings: ReviewFindingEvent[]): number {
  const findingIds = new Set(findings.map((f) => f.findingId));
  if (findingIds.size === 0) return 0;

  let multiIterationCount = 0;
  for (const id of findingIds) {
    const iterations = new Set(
      findings.filter((f) => f.findingId === id).map((f) => f.iteration),
    );
    if (iterations.size >= 2) {
      multiIterationCount++;
    }
  }

  return multiIterationCount / findingIds.size;
}

/** Average number of iterations from first appearance to resolution */
function computeAverageResolutionIterations(findings: ReviewFindingEvent[]): number {
  const findingIds = new Set(findings.map((f) => f.findingId));
  if (findingIds.size === 0) return 0;

  let totalIterations = 0;
  let resolvedCount = 0;

  for (const id of findingIds) {
    const related = findings.filter((f) => f.findingId === id);
    const minIteration = Math.min(...related.map((f) => f.iteration));
    const resolved = related.find((f) => f.status === 'resolved');
    if (resolved) {
      totalIterations += resolved.iteration - minIteration + 1;
      resolvedCount++;
    }
  }

  if (resolvedCount === 0) return 0;
  return totalIterations / resolvedCount;
}

/** Ratio of rebutted findings that were subsequently resolved in a review */
function computeRebuttalResolvedRatio(
  fixActions: FixActionEvent[],
  findings: ReviewFindingEvent[],
): number {
  const rebuttedIds = new Set(
    fixActions.filter((a) => a.action === 'rebutted').map((a) => a.findingId),
  );
  if (rebuttedIds.size === 0) return 0;

  let resolvedCount = 0;
  for (const id of rebuttedIds) {
    const wasResolved = findings.some(
      (f) => f.findingId === id && f.status === 'resolved',
    );
    if (wasResolved) {
      resolvedCount++;
    }
  }

  return resolvedCount / rebuttedIds.size;
}

/** Count of REJECT decisions per rule_id */
function computeRejectCountsByRule(findings: ReviewFindingEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.decision === 'reject') {
      counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Parse a duration string like "7d", "30d", "14d" into milliseconds.
 */
export function parseSinceDuration(since: string): number {
  const match = since.match(/^(\d+)d$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${since}". Use format like "7d", "30d".`);
  }
  const daysStr = match[1];
  if (!daysStr) {
    throw new Error(`Invalid duration format: "${since}". Use format like "7d", "30d".`);
  }
  const days = parseInt(daysStr, 10);
  return days * 24 * 60 * 60 * 1000;
}
