import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFindingRelation,
  RawFinding,
} from './types.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import { matchesProvisionalRecoveryOrigin } from './provisional-recovery-origin.js';
import type { VerifiedReplayOriginAuthority } from './provisional-recovery-origin.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';

function isProvisionalProductTransitionSource(input: {
  ledger: FindingLedger;
  provisional: FindingLedgerEntry;
  wire: RawFinding;
  expectedStatus: 'open' | 'dismissed';
  expectedRelation: Extract<RawFindingRelation, 'persists' | 'reopened'>;
}): boolean {
  const current = input.ledger.findings.find(
    (finding) => finding.id === input.provisional.id,
  );
  return current !== undefined
    && current.revision === input.provisional.revision
    && current.status === input.provisional.status
    && current.targetIdentityHash === input.provisional.targetIdentityHash
    && current.provisional?.stableKey === input.provisional.provisional?.stableKey
    && input.provisional.status === input.expectedStatus
    && input.provisional.provisional !== undefined
    && input.provisional.targetIdentityHash !== null
    && input.wire.relation === input.expectedRelation
    && input.wire.targetFindingId === input.provisional.id
    && input.wire.targetIdentityHash === input.provisional.targetIdentityHash
    && input.wire.targetPrecondition !== undefined
    && findingMatchesMutationPrecondition(input.ledger, input.wire.targetPrecondition);
}

export function isProvisionalPromotionSource(input: {
  ledger: FindingLedger;
  provisional: FindingLedgerEntry;
  wire: RawFinding;
}): boolean {
  return isProvisionalProductTransitionSource({
    ...input,
    expectedStatus: 'open',
    expectedRelation: 'persists',
  });
}

export function isReplayOriginPromotionSource(input: {
  ledger: FindingLedger;
  provisional: FindingLedgerEntry;
  wire: RawFinding;
  authority: VerifiedReplayOriginAuthority;
}): boolean {
  const current = input.ledger.findings.find(
    (finding) => finding.id === input.provisional.id,
  );
  const source = input.ledger.rawFindings.find(
    (rawFinding) => (
      rawFinding.rawFindingId === input.authority.sourceRawFindingId
    ),
  );
  if (
    current === undefined
    || source === undefined
    || input.authority.replayRawFindingId !== input.wire.rawFindingId
    || input.authority.recoveryOrigin.provisionalFindingId
      !== input.provisional.id
    || !matchesProvisionalRecoveryOrigin(
      current,
      input.authority.recoveryOrigin,
    )
    || source.relation !== 'new'
    || !current.provisional.sourceRawFindingIds.includes(
      input.authority.sourceRawFindingId,
    )
    || computeRawFindingIntegrityDigest(source)
      !== input.authority.sourceRawIntegrityDigest
    || input.wire.relation !== 'new'
  ) {
    return false;
  }
  return computeRawFindingIntegrityDigest({
    ...source,
    rawFindingId: input.wire.rawFindingId,
  }) === computeRawFindingIntegrityDigest(input.wire);
}

export function isProvisionalReopenSource(input: {
  ledger: FindingLedger;
  provisional: FindingLedgerEntry;
  wire: RawFinding;
}): boolean {
  return isProvisionalProductTransitionSource({
    ...input,
    expectedStatus: 'dismissed',
    expectedRelation: 'reopened',
  });
}
