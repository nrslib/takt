import type {
  FindingProvisionalKind,
  FindingSeverity,
  FindingTarget,
  FindingProvisionalClaimBindingAuthorization,
  FindingProvisionalClaimBindingAuthorizationReference,
} from './types.js';

export type PreAdmissionEntityBinding =
  | {
      kind: 'bind_existing';
      targetFindingId: string;
      expectedTargetIdentityHash: string;
      fallbackCreationRequestKey: string;
      capturedLocusHeadDigest: string;
      reason: string;
    }
  | {
      kind: 'entity_group';
      decision: 'new_entity' | 'ambiguous';
      creationRequestKey: string;
      commitOrderKey: string;
      capturedLocusHeadDigest: string;
      groupRawFindingIds: readonly string[];
      reason: string;
    };

interface EntityProvisionalMutationClaim {
  sourceRawFindingIds: string[];
  reason: string;
  title: string | null;
  severity: FindingSeverity | null;
  description?: string;
  suggestion?: string;
  reviewers: string[];
  target: FindingTarget;
  targetIdentityHash: string;
  claimIdentityHash: string;
      semanticClaimIdentityHash: string;
      claimBindingAuthorization: FindingProvisionalClaimBindingAuthorization<Extract<
        FindingProvisionalClaimBindingAuthorizationReference,
        { kind: 'new_provisional_bundle' }
      >>;
}

export type PreAdmissionEntityProvisionalMutation =
  | (EntityProvisionalMutationClaim & {
      operation: 'create_new';
      creationRequestKey: string;
      provisionalKind: Extract<
        FindingProvisionalKind,
        'raw-adjudication-unresolved' | 'raw-meaning-ambiguous' | 'stale-precondition'
      >;
    })
  | {
      operation: 'attach_existing';
      findingId: string;
      expectedKind: 'raw-meaning-ambiguous';
      expectedStableKey: string;
      expectedLineageKey: string;
      sourceRawFindingIds: string[];
      reviewers: string[];
      reason: string;
      claimBindingAuthorizations: Array<FindingProvisionalClaimBindingAuthorization<Extract<
        FindingProvisionalClaimBindingAuthorizationReference,
        { kind: 'pre_admission_attach_existing' }
      >>>;
    };

export type PreAdmissionEntityMutationResult =
  | {
      outcome: 'applied_provisional';
      findingId: string;
      mutation: PreAdmissionEntityProvisionalMutation;
    }
  | {
      outcome: 'terminal_audit';
      targetFindingId: string;
      sourceRawFindingIds: string[];
      reason: string;
    };
