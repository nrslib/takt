/**
 * Analytics event type definitions for metrics collection.
 *
 * Three event types capture review findings, fix actions, and movement results
 * for local-only analysis when analytics.enabled = true.
 */

/** Status of a review finding across iterations */
export type FindingStatus = 'new' | 'persists' | 'resolved';

/** Severity level of a review finding */
export type FindingSeverity = 'error' | 'warning';

/** Decision taken on a finding */
export type FindingDecision = 'reject' | 'approve';

/** Action taken to address a finding */
export type FixActionType = 'fixed' | 'rebutted' | 'not_applicable';

/** Review finding event — emitted per finding during review movements */
export interface ReviewFindingEvent {
  type: 'review_finding';
  findingId: string;
  status: FindingStatus;
  ruleId: string;
  severity: FindingSeverity;
  decision: FindingDecision;
  file: string;
  line: number;
  iteration: number;
  runId: string;
  timestamp: string;
}

/** Fix action event — emitted per finding addressed during fix movements */
export interface FixActionEvent {
  type: 'fix_action';
  findingId: string;
  action: FixActionType;
  changedFiles?: string[];
  testCommand?: string;
  testResult?: string;
  iteration: number;
  runId: string;
  timestamp: string;
}

/** Movement result event — emitted after each movement completes */
export interface MovementResultEvent {
  type: 'movement_result';
  movement: string;
  provider: string;
  model: string;
  decisionTag: string;
  iteration: number;
  runId: string;
  timestamp: string;
}

/** Union of all analytics event types */
export type AnalyticsEvent =
  | ReviewFindingEvent
  | FixActionEvent
  | MovementResultEvent;
