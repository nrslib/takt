import type { ProviderType } from '../../shared/types/provider.js';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
// 'invalidated': the finding's premise does not hold (deterministically verified:
// its location does not exist / is out of range). Distinct from 'waived' (the
// finding is valid but won't be fixed) — critical findings can never be waived,
// but CAN be invalidated, because invalidation says the finding was never real.
// 'superseded': the finding was merged into a canonical duplicate (duplicateDecisions).
// Both are terminal, additive statuses: existing v1 ledgers need no migration
// because a ledger that never produces these values is unaffected.
export const FINDING_STATUSES = ['open', 'resolved', 'waived', 'invalidated', 'superseded'] as const;
export const FINDING_LIFECYCLES = ['new', 'persists', 'resolved', 'reopened', 'waived', 'invalidated', 'superseded'] as const;
export const FINDING_CONFLICT_STATUSES = ['active', 'resolved'] as const;

export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type FindingStatus = typeof FINDING_STATUSES[number];
export type FindingLifecycle = typeof FINDING_LIFECYCLES[number];
export type FindingConflictStatus = typeof FINDING_CONFLICT_STATUSES[number];

export interface FindingContractManagerConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  providerRoutingPersonaKey?: string;
  instruction: string;
  outputContract: string;
  provider?: ProviderType;
  model?: string;
}

export interface FindingContractConfig {
  ledgerPath: string;
  rawFindingsPath: string;
  manager: FindingContractManagerConfig;
}

export interface FindingObservation {
  runId: string;
  stepName: string;
  timestamp: string;
}

/** A manager-adjudicated exemption: the finding is valid but cannot be fixed. */
export interface FindingWaiverRecord {
  reason: string;
  evidence: string;
  decidedAt: FindingObservation;
}

/** A recorded objection that the manager did NOT accept; the finding stays open. */
export interface FindingDisputeRecord {
  reason: string;
  evidence: string;
  recordedAt: FindingObservation;
}

export interface FindingLedgerEntry {
  id: string;
  status: FindingStatus;
  lifecycle: FindingLifecycle;
  severity: FindingSeverity;
  title: string;
  location?: string;
  description?: string;
  suggestion?: string;
  reviewers: string[];
  rawFindingIds: string[];
  firstSeen: FindingObservation;
  lastSeen: FindingObservation;
  resolvedAt?: string;
  resolvedEvidence?: string;
  reopenedEvidence?: string;
  /** Waiver history, newest last. Kept across reopens for audit. */
  waivers?: FindingWaiverRecord[];
  /** Rejected or pending objections, newest last. Kept for audit. */
  disputes?: FindingDisputeRecord[];
  /** Set when status/lifecycle becomes 'invalidated' (engine-verified: location does not exist / out of range). */
  invalidatedAt?: string;
  invalidatedEvidence?: string;
  /** Set when status/lifecycle becomes 'superseded' by a duplicateDecisions merge. */
  supersededByFindingId?: string;
}

export type FindingRecord = FindingLedgerEntry;

export interface FindingLedger {
  version: 1;
  workflowName: string;
  nextId: number;
  updatedAt: string;
  findings: FindingLedgerEntry[];
  rawFindings: RawFinding[];
  conflicts: FindingLedgerConflict[];
}

export const RAW_FINDING_KINDS = ['issue', 'resolution_confirmation'] as const;
export type RawFindingKind = typeof RAW_FINDING_KINDS[number];

// relation is the successor of `kind`: it states the raw finding's relationship
// to the ledger, not just whether it's an issue observation. 'new' replaces
// kind=issue with no target; 'persists' and 'reopened' are issue-kind raws that
// explicitly reference an existing finding (previously indistinguishable from a
// fresh 'new' issue except by mechanical familyTag+location matching, which the
// convergence design removes as an identity signal). 'resolution_confirmation'
// mirrors kind=resolution_confirmation. `kind` is retained for backward
// compatibility (see parseRawFindingRelation in finding-schemas.ts) but
// `relation` is authoritative wherever both are present.
export const RAW_FINDING_RELATIONS = ['new', 'persists', 'resolution_confirmation', 'reopened'] as const;
export type RawFindingRelation = typeof RAW_FINDING_RELATIONS[number];

export interface RawFinding {
  rawFindingId: string;
  stepName: string;
  reviewer: string;
  familyTag: string;
  severity: FindingSeverity;
  title: string;
  location?: string;
  description: string;
  suggestion?: string;
  /** Omitted means 'issue' (backward compatible with pre-existing ledgers). */
  kind?: RawFindingKind;
  /**
   * This raw finding's relationship to the ledger. Always present after schema
   * parsing (parseRawFindingRelation derives it from `kind` for pre-existing
   * data); optional on the wire type only because reviewers producing the v1
   * raw findings JSON schema predate this field.
   */
  relation?: RawFindingRelation;
  /** Ledger finding id this entry references (required for persists/reopened/resolution_confirmation; forbidden for new). */
  targetFindingId?: string;
}

export interface FindingManagerMatch {
  findingId: string;
  rawFindingIds: string[];
  evidence?: string;
}

export interface FindingManagerNewFinding {
  rawFindingIds: string[];
  title: string;
  severity: FindingSeverity;
}

export interface FindingManagerResolvedFinding {
  findingId: string;
  rawFindingIds: string[];
  evidence: string;
}

export interface FindingManagerReopenedFinding {
  findingId: string;
  rawFindingIds: string[];
  evidence: string;
}

export interface FindingManagerConflict {
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
}

export interface FindingManagerResolvedConflict {
  conflictId: string;
  evidence: string;
}

export interface FindingManagerWaivedFinding {
  findingId: string;
  reason: string;
  evidence: string;
}

export interface FindingManagerDisputeNote {
  findingId: string;
  reason: string;
  evidence: string;
}

/** Applied only after the engine deterministically re-verifies the finding's own location (see admission-validation.ts). The LLM's evidence alone never invalidates. */
export interface FindingManagerInvalidatedFinding {
  findingId: string;
  evidence: string;
}

/** Merges duplicateFindingIds into canonicalFindingId (rawFindingIds/reviewers/disputes) and marks the duplicates 'superseded'. Never used to resolve or waive — "superseded" and "fixed" are different claims. */
export interface FindingManagerDuplicateDecision {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  evidence: string;
}

export interface FindingLedgerConflict {
  id: string;
  status: FindingConflictStatus;
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
  firstSeen: FindingObservation;
  lastSeen: FindingObservation;
  resolvedAt?: string;
  resolvedEvidence?: string;
}

export interface FindingManagerOutput {
  matches: FindingManagerMatch[];
  newFindings: FindingManagerNewFinding[];
  resolvedFindings: FindingManagerResolvedFinding[];
  reopenedFindings: FindingManagerReopenedFinding[];
  conflicts: FindingManagerConflict[];
  resolvedConflicts: FindingManagerResolvedConflict[];
  waivedFindings: FindingManagerWaivedFinding[];
  disputeNotes: FindingManagerDisputeNote[];
  invalidatedFindings: FindingManagerInvalidatedFinding[];
  duplicateFindings: FindingManagerDuplicateDecision[];
}

// FindingManagerOutput（上記）は台帳の内部表現として残すが、LLM に直接組み立てさせる
// のはやめる。8配列すべてを一貫した不変条件を守りながら自力で組み立てさせると、
// gpt-5.5 のような十分に強いモデルでも検証に落ちる（takt-bench v2 で実測: 7 走行全滅、
// "not open" / "familyTag mismatch" / "conflict is not active" 等）。LLM には
// raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを返させ、
// 8配列への組み立てと不変条件の強制はコード（decision-assembly.ts）が担う。
// 'unsupported': the raw finding explicitly referenced an existing finding
// (targetFindingId set, relation persists/reopened) but its own claim doesn't
// hold up (e.g. self-contradicting evidence). Distinct from 'new' — an
// unsupported re-report must NOT fall back to creating a fresh finding (that
// would launder a false re-report into a real one), and distinct from 'same' —
// nothing about the target changes. Recorded for audit only.
export const RAW_DECISION_KINDS = ['same', 'new', 'resolved', 'reopened', 'conflict', 'unsupported'] as const;
export type RawDecisionKind = typeof RAW_DECISION_KINDS[number];

export const DISPUTE_DECISION_KINDS = ['waive', 'note'] as const;
export type DisputeDecisionKind = typeof DISPUTE_DECISION_KINDS[number];

export const CONFLICT_DECISION_KINDS = ['resolve', 'keep'] as const;
export type ConflictDecisionKind = typeof CONFLICT_DECISION_KINDS[number];

export interface FindingManagerRawDecision {
  rawFindingId: string;
  decision: RawDecisionKind;
  /** Ledger finding id. Required for same/resolved/reopened/conflict; absent for new. */
  findingId?: string;
  evidence: string;
}

export interface FindingManagerDisputeDecision {
  findingId: string;
  decision: DisputeDecisionKind;
  reason: string;
  evidence: string;
}

export interface FindingManagerConflictDecision {
  conflictId: string;
  decision: ConflictDecisionKind;
  evidence: string;
}

/**
 * Proposal to invalidate an existing open finding. The manager may only choose
 * from the candidate finding ids the engine already flagged (their location
 * failed a deterministic check against the reviewed code before the manager was
 * even invoked — see manager-runner.ts's invalidLocationCandidateFindingIds).
 * The manager's evidence explains why it agrees; it does not grant new
 * authority to invalidate findings outside that candidate set.
 */
export interface FindingManagerInvalidateDecision {
  findingId: string;
  evidence: string;
}

/** LLM が返す「判断だけ」の出力。組み立て・不変条件の強制は decision-assembly.ts が行う。 */
export interface FindingManagerDecisions {
  rawDecisions: FindingManagerRawDecision[];
  disputeDecisions: FindingManagerDisputeDecision[];
  conflictDecisions: FindingManagerConflictDecision[];
  invalidateDecisions: FindingManagerInvalidateDecision[];
  duplicateDecisions: FindingManagerDuplicateDecision[];
}

export interface FindingReconcileContext {
  workflowName: string;
  stepName: string;
  runId: string;
  timestamp: string;
}

export interface FindingsRuleContext {
  open: {
    count: number;
    bySeverity: Record<FindingSeverity, number>;
    items: Array<{
      id: string;
      severity: FindingSeverity;
      title: string;
      location?: string;
      description?: string;
      suggestion?: string;
      reviewers: string[];
    }>;
  };
  resolved: {
    count: number;
  };
  waived: {
    count: number;
  };
  /** Audit-only visibility: engine-verified "premise does not hold" findings. Not part of the blocking set; gate conditions stay on open/conflicts. */
  invalidated: {
    count: number;
  };
  /** Audit-only visibility: findings merged into a canonical duplicate. Not part of the blocking set. */
  superseded: {
    count: number;
  };
  conflicts: {
    count: number;
      items: Array<{
      id: string;
      status: FindingConflictStatus;
      findingIds: string[];
      rawFindingIds: string[];
      description: string;
    }>;
  };
}
