import type { ProviderType } from '../../shared/types/provider.js';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_STATUSES = ['open', 'resolved', 'waived'] as const;
export const FINDING_LIFECYCLES = ['new', 'persists', 'resolved', 'reopened', 'waived'] as const;
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
  /** Ledger finding id this entry confirms as resolved (resolution_confirmation only). */
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
}

// FindingManagerOutput（上記）は台帳の内部表現として残すが、LLM に直接組み立てさせる
// のはやめる。8配列すべてを一貫した不変条件を守りながら自力で組み立てさせると、
// gpt-5.5 のような十分に強いモデルでも検証に落ちる（takt-bench v2 で実測: 7 走行全滅、
// "not open" / "familyTag mismatch" / "conflict is not active" 等）。LLM には
// raw finding 1件・disputed finding 1件・conflict 1件ごとの「判断」だけを返させ、
// 8配列への組み立てと不変条件の強制はコード（decision-assembly.ts）が担う。
export const RAW_DECISION_KINDS = ['same', 'new', 'resolved', 'reopened', 'conflict'] as const;
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

/** LLM が返す「判断だけ」の出力。組み立て・不変条件の強制は decision-assembly.ts が行う。 */
export interface FindingManagerDecisions {
  rawDecisions: FindingManagerRawDecision[];
  disputeDecisions: FindingManagerDisputeDecision[];
  conflictDecisions: FindingManagerConflictDecision[];
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
