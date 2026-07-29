import type {
  FindingLifecycleAuthority,
  FindingLifecycleOperation,
} from './finding-types.js';

export type FindingLifecycleAuthorityContract =
  | 'verified_evidence'
  | 'engine_policy:waive'
  | 'engine_policy:dispute'
  | 'engine_policy:dismiss'
  | 'engine_policy:resolve_conflict'
  | 'engine_policy:semantic_duplicate'
  | 'engine_policy:anchor_relevance'
  | 'conflict_adjudication'
  | 'rejected_observation'
  | 'system:record_recovery_attempt'
  | 'system:settle_action_recovery'
  | 'system:sync_interpretation_epoch';

export interface LifecycleOperationContract {
  readonly targetShape:
    | 'one_finding'
    | 'multiple_findings'
    | 'one_conflict'
    | 'conflict_and_its_findings'
    | 'one_finding_and_one_conflict';
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
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance', 'system:settle_action_recovery'],
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
    authorities: ['verified_evidence'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'evidenceIds', 'invalidatedAt',
      'invalidatedEvidence',
    ],
    conflictDelta: [],
  },
  supersede_findings: {
    targetShape: 'multiple_findings',
    allowsCreate: false,
    authorities: ['verified_evidence', 'engine_policy:semantic_duplicate'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'supersededByFindingId',
      'rawFindingIds', 'reviewers', 'evidenceIds', 'disputes', 'lastSeen',
    ],
    conflictDelta: [],
  },
  dismiss_finding: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['engine_policy:dismiss'],
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
    authorities: ['verified_evidence'],
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
    authorities: ['verified_evidence', 'engine_policy:anchor_relevance'],
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
  sync_interpretation_epoch: {
    targetShape: 'one_finding',
    allowsCreate: false,
    authorities: ['system:sync_interpretation_epoch'],
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
    authorities: ['engine_policy:resolve_conflict'],
    findingDelta: [],
    conflictDelta: [
      'status', 'revision', 'resolvedAt', 'resolvedEvidence',
    ],
  },
  apply_conflict_adjudication: {
    targetShape: 'conflict_and_its_findings',
    allowsCreate: false,
    authorities: ['conflict_adjudication'],
    findingDelta: [
      'status', 'lifecycle', 'revision', 'suggestion', 'lastSeen',
      'resolvedAt', 'resolvedEvidence', 'invalidatedAt', 'invalidatedEvidence',
    ],
    conflictDelta: [
      'status', 'revision', 'adjudications', 'resolvedAt', 'resolvedEvidence',
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
};

export function findingLifecycleAuthorityContract(
  authority: FindingLifecycleAuthority,
): FindingLifecycleAuthorityContract {
  switch (authority.kind) {
    case 'verified_evidence':
    case 'conflict_adjudication':
    case 'rejected_observation':
      return authority.kind;
    case 'engine_policy':
      return `engine_policy:${authority.decisionKind}`;
    case 'system':
      return `system:${authority.action}`;
  }
}
