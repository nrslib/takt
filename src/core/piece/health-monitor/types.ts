/**
 * Type definitions for Loop Health Monitor.
 *
 * The health monitor observes improvement loops during piece execution
 * and reports on convergence, stagnation, or loop patterns.
 * It is a pure observer — it never interferes with execution flow.
 */

/** Status of a finding across iterations */
export type FindingStatus = 'new' | 'persists' | 'resolved';

/** Trend indicator for a finding */
export type FindingTrend = 'improving' | 'stagnating' | 'looping' | 'new';

/** Tracked state of a single finding across iterations */
export interface FindingRecord {
  readonly findingId: string;
  readonly status: FindingStatus;
  /** Number of consecutive iterations this finding has persisted */
  readonly consecutivePersists: number;
  /** Number of resolved→new transitions (recurrence) */
  readonly recurrenceCount: number;
  readonly trend: FindingTrend;
}

/** Overall health verdict for the improvement loop */
export type HealthVerdict =
  | 'converging'
  | 'improving'
  | 'stagnating'
  | 'looping'
  | 'needs_attention'
  | 'misaligned';

/** Reason for the health verdict */
export interface VerdictReason {
  readonly verdict: HealthVerdict;
  readonly summary: string;
  /** Finding IDs that contributed to this verdict */
  readonly relatedFindings: readonly string[];
}

/** Snapshot of health state at a given iteration */
export interface HealthSnapshot {
  readonly movementName: string;
  readonly iteration: number;
  readonly maxMovements: number;
  readonly findings: readonly FindingRecord[];
  readonly verdict: VerdictReason;
}

/** Raw finding extracted from a report file (before tracking) */
export interface RawFinding {
  readonly id: string;
  readonly status: FindingStatus;
  readonly category: string;
  readonly location: string;
}

/** Thresholds for health evaluation */
export interface HealthThresholds {
  /** Consecutive persists before "stagnating" (default: 3) */
  readonly stagnationThreshold: number;
  /** Consecutive persists before "looping" (default: 5) */
  readonly loopThreshold: number;
  /** resolved→new transitions before "looping" (default: 2) */
  readonly recurrenceThreshold: number;
}

/** A single movement exchange from the NDJSON conversation log */
export interface ConversationEntry {
  readonly step: string;
  readonly instruction: string;
  readonly content: string;
  readonly error?: string;
}
