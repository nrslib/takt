export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_STATUSES = ['open', 'resolved'] as const;
export const FINDING_LIFECYCLES = ['new', 'persists', 'resolved', 'reopened'] as const;
export const FINDING_CONFLICT_STATUSES = ['active', 'resolved'] as const;

export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type FindingStatus = typeof FINDING_STATUSES[number];
export type FindingLifecycle = typeof FINDING_LIFECYCLES[number];
export type FindingConflictStatus = typeof FINDING_CONFLICT_STATUSES[number];

export interface FindingContractManagerConfig {
  persona: string;
  personaPath?: string;
  personaDisplayName?: string;
  instruction: string;
  outputContract: string;
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
