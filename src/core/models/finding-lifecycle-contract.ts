import type {
  FindingLifecycleAuthority,
  FindingLifecycleOperation,
} from './finding-types.js';

export type FindingLifecycleAuthorityContract =
  | 'verified_evidence'
  | 'engine_policy:waive'
  | 'engine_policy:dispute'
  | 'engine_policy:semantic_duplicate'
  | 'engine_policy:anchor_relevance'
  | 'verified_conflict_adjudication'
  | 'verified_terminal_adjudication'
  | 'interpretation_unreserved_landing'
  | 'interpretation_case_rejection'
  | 'rejected_observation'
  | 'provisional_conflict_normalization'
  | 'verified_raw_provisional_identity'
  | 'conflict_reactivation'
  | 'system:record_recovery_attempt'
  | 'system:settle_action_recovery';

export interface LifecycleOperationContract {
  readonly targetShape:
    | 'one_finding'
    | 'multiple_findings'
    | 'one_conflict'
    | 'conflict_and_its_findings'
    | 'one_finding_and_one_conflict'
    | 'one_or_more_conflicts_and_findings';
  readonly allowsCreate: boolean;
  readonly authorities: readonly FindingLifecycleAuthorityContract[];
  readonly findingDelta: readonly string[];
  readonly conflictDelta: readonly string[];
}

export const FINDING_LIFECYCLE_OPERATION_CONTRACTS: Readonly<
  Record<FindingLifecycleOperation, LifecycleOperationContract>
> = {
  create_finding: {
    targetShape: 'one_finding',
    allowsCreate: true,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
    findingDelta: [],
    conflictDelta: [],
  },
  persist_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
    findingDelta: [
      'lifecycle', 'revision', 'severity', 'title', 'description', 'suggestion',
      'rawFindingIds', 'reviewers', 'evidenceIds', 'lastSeen',
    ],
    conflictDelta: [],
  },
  resolve_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance', 'system:settle_action_recovery', 'verified_conflict_adjudication'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'rawFindingIds', 'reviewers',
      'evidenceIds', 'lastSeen', 'resolvedAt', 'resolvedEvidence',
    ],
    conflictDelta: [],
  },
  reopen_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'rawFindingIds', 'reviewers',
      'evidenceIds', 'lastSeen', 'description', 'suggestion',
      'target', 'targetIdentityHash', 'claimIdentityHash',
      'semanticClaimIdentityHash', 'severity', 'title', 'provisional',
      'resolvedAt', 'resolvedEvidence', 'reopenedEvidence',
      'invalidatedAt', 'invalidatedEvidence', 'dismissal',
    ],
    conflictDelta: [],
  },
  waive_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['engine_policy:waive'],
    findingDelta: ['status', 'lifecycle', 'revision', 'waivers', 'lastSeen'],
    conflictDelta: [],
  },
  invalidate_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_evidence', 'verified_conflict_adjudication'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'evidenceIds', 'invalidatedAt',
      'invalidatedEvidence',
    ],
    conflictDelta: [],
  },
  supersede_findings: {
    targetShape: 'multiple_findings',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:semantic_duplicate', 'verified_conflict_adjudication', 'verified_terminal_adjudication'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'supersededByFindingId',
      'rawFindingIds', 'reviewers', 'evidenceIds', 'disputes', 'lastSeen',
    ],
    conflictDelta: [],
  },
  dismiss_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_terminal_adjudication'],
    findingDelta: ['status', 'lifecycle', 'revision', 'dismissal'],
    conflictDelta: [],
  },
  record_dispute: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['engine_policy:dispute'],
    findingDelta: ['revision', 'disputes'],
    conflictDelta: [],
  },
  update_provisional: {
    targetShape: 'one_finding',
    allowsCreate: true,
    authorities: ['verified_evidence', 'interpretation_unreserved_landing', 'interpretation_case_rejection'],
    findingDelta: [
      'revision', 'lifecycle', 'severity', 'title', 'description', 'suggestion',
      'target', 'targetIdentityHash', 'claimIdentityHash',
      'semanticClaimIdentityHash',
      'evidenceIds', 'rawFindingIds', 'reviewers', 'lastSeen', 'provisional',
    ],
    conflictDelta: [],
  },
  promote_provisional: {
    targetShape: 'one_finding',
    allowsCreate: true,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance', 'verified_conflict_adjudication', 'verified_terminal_adjudication'],
    findingDelta: [
      'revision', 'status', 'lifecycle', 'severity', 'title', 'description',
      'target', 'targetIdentityHash', 'claimIdentityHash',
      'semanticClaimIdentityHash',
      'suggestion', 'evidenceIds', 'rawFindingIds', 'reviewers', 'lastSeen',
      'provisional',
    ],
    conflictDelta: [],
  },
  record_rejected_observation: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['rejected_observation'],
    findingDelta: ['revision', 'rejectedObservations'],
    conflictDelta: [],
  },
  record_recovery_attempt: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['system:record_recovery_attempt'],
    findingDelta: ['revision', 'provisional'],
    conflictDelta: [],
  },
  create_conflict: {
    targetShape: 'one_conflict',
    allowsCreate: true,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
    findingDelta: [],
    conflictDelta: [],
  },
  observe_conflict: {
    targetShape: 'one_conflict',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
    findingDelta: [],
    conflictDelta: ['revision', 'rawFindingIds', 'description', 'lastSeen'],
  },
  resolve_conflict: {
    targetShape: 'one_conflict',
    allowsCreate: false,
    authorities: ['verified_conflict_adjudication'],
    findingDelta: [],
    conflictDelta: [
      'status', 'revision', 'resolvedAt', 'resolvedEvidence',
    ],
  },
  apply_conflict_adjudication: {
    targetShape: 'conflict_and_its_findings',
    allowsCreate: false,
    authorities: ['verified_conflict_adjudication'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'suggestion', 'lastSeen', 'provisional',
      'target', 'targetIdentityHash', 'claimIdentityHash',
      'semanticClaimIdentityHash', 'severity', 'title', 'description',
      'rawFindingIds', 'reviewers', 'evidenceIds', 'supersededByFindingId',
      'resolvedAt', 'resolvedEvidence', 'invalidatedAt', 'invalidatedEvidence',
    ],
    conflictDelta: [
      'status', 'revision', 'resolvedAt', 'resolvedEvidence',
    ],
  },
  apply_resolution_renotification: {
    targetShape: 'one_finding_and_one_conflict',
    allowsCreate: true,
    authorities: ['verified_evidence'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'description', 'suggestion',
      'rawFindingIds', 'reviewers', 'evidenceIds', 'lastSeen',
      'resolvedAt', 'resolvedEvidence', 'reopenedEvidence',
    ],
    conflictDelta: [
      'status', 'revision', 'rawFindingIds', 'description', 'lastSeen',
      'resolvedAt', 'resolvedEvidence',
    ],
  },
  normalize_provisional_conflicts: {
    targetShape: 'one_or_more_conflicts_and_findings',
    allowsCreate: false,
    authorities: ['provisional_conflict_normalization'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'rawFindingIds', 'reviewers',
      'evidenceIds', 'lastSeen', 'provisional', 'supersededByFindingId',
    ],
    conflictDelta: ['status', 'revision', 'resolvedAt', 'resolvedEvidence'],
  },
  attach_raw_to_provisional: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['verified_raw_provisional_identity'],
    findingDelta: [
      'lifecycle', 'revision', 'rawFindingIds', 'reviewers', 'evidenceIds',
      'lastSeen', 'provisional',
    ],
    conflictDelta: [],
  },
  reactivate_conflict: {
    targetShape: 'one_conflict',
    allowsCreate: false,
    authorities: ['conflict_reactivation'],
    findingDelta: [],
    conflictDelta: [
      'status', 'revision', 'rawFindingIds', 'lastSeen', 'resolvedAt',
      'resolvedEvidence',
    ],
  },
};

export function findingLifecycleAuthorityContract(
  authority: FindingLifecycleAuthority,
): FindingLifecycleAuthorityContract {
  switch (authority.kind) {
    case 'verified_evidence':
    case 'verified_conflict_adjudication':
    case 'verified_terminal_adjudication':
    case 'interpretation_unreserved_landing':
    case 'interpretation_case_rejection':
    case 'rejected_observation':
    case 'provisional_conflict_normalization':
    case 'verified_raw_provisional_identity':
    case 'conflict_reactivation':
      return authority.kind;
    case 'engine_policy':
      return `engine_policy:${authority.decisionKind}`;
    case 'system':
      return `system:${authority.action}`;
  }
}
