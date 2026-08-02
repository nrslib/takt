import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFindingRelation,
  RawFinding,
} from './types.js';
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
