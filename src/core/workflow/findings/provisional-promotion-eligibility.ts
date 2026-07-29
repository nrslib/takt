import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
} from './types.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';

export function isProvisionalPromotionSource(input: {
  ledger: FindingLedger;
  provisional: FindingLedgerEntry;
  wire: RawFinding;
}): boolean {
  return input.provisional.status === 'open'
    && input.provisional.provisional !== undefined
    && input.provisional.targetIdentityHash !== null
    && input.wire.relation === 'persists'
    && input.wire.targetFindingId === input.provisional.id
    && input.wire.targetIdentityHash === input.provisional.targetIdentityHash
    && input.wire.targetPrecondition !== undefined
    && findingMatchesMutationPrecondition(input.ledger, input.wire.targetPrecondition);
}
