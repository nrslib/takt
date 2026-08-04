import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeIndependentProvisionalClaimKey,
  computeIndependentProvisionalLineageKey,
  computeIndependentProvisionalStableKey,
} from '../../models/finding-contract-identity.js';
import type {
  FindingLedger,
  FindingLifecycleEntityHead,
  ProvisionalFindingEntry,
  RawCanonicalSnapshot,
  VerifiedRawProvisionalIdentityAuthority,
} from './types.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { hasUnsettledActiveConflictOwnership } from './conflict-ownership.js';

export interface IndependentProvisionalIdentity {
  independentClaimKey: string;
  independentLineageKey: string;
  independentStableKey: string;
}

export type IndependentProvisionalDestination =
  | {
      kind: 'create';
      findingId: string;
      expectedHead: null;
      provisionalFinding: ProvisionalFindingSpec;
    }
  | {
      kind: 'attach_existing';
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      authority: VerifiedRawProvisionalIdentityAuthority;
    };

export type ProvisionalTargetLandingPlan =
  | {
      kind: 'attach_exact';
      rawFindingId: string;
      rawCanonicalSnapshotId: string;
      targetFindingId: string;
      authority: VerifiedRawProvisionalIdentityAuthority;
    }
  | {
      kind: 'land_independent';
      rawFindingId: string;
      rawCanonicalSnapshotId: string;
      rejectedTargetFindingId: string;
      independentClaimKey: string;
      independentLineageKey: string;
      independentStableKey: string;
      reason: 'identity_unproven';
      destination: IndependentProvisionalDestination;
    };

export function independentProvisionalIdentity(
  snapshot: Pick<
    RawCanonicalSnapshot,
    'targetIdentityHash' | 'claimIdentityHash' | 'semanticClaimIdentityHash'
  >,
): IndependentProvisionalIdentity {
  const independentClaimKey = computeIndependentProvisionalClaimKey(snapshot);
  return {
    independentClaimKey,
    independentLineageKey: computeIndependentProvisionalLineageKey(independentClaimKey),
    independentStableKey: computeIndependentProvisionalStableKey(independentClaimKey),
  };
}

export function findIndependentProvisionalDestination(input: {
  ledger: FindingLedger;
  stableKey: string;
}): { finding: ProvisionalFindingEntry; expectedHead: FindingLifecycleEntityHead } | null {
  const matches = input.ledger.findings.filter((finding): finding is ProvisionalFindingEntry => (
    finding.status === 'open'
    && finding.provisional?.kind === 'raw-adjudication-unresolved'
    && finding.provisional.stableKey === input.stableKey
    && !hasUnsettledActiveConflictOwnership(input.ledger, finding.id)
  )).sort((left, right) => compareBinaryStrings(left.id, right.id));
  if (matches.length > 1) {
    throw new Error(
      `Independent provisional stable key "${input.stableKey}" has multiple open owners`,
    );
  }
  const finding = matches[0];
  if (finding === undefined) {
    return null;
  }
  const expectedHead = captureFindingLifecycleHead(input.ledger, 'finding', finding.id);
  if (expectedHead === undefined) {
    throw new Error(`Independent provisional "${finding.id}" has no lifecycle head`);
  }
  return { finding, expectedHead };
}
