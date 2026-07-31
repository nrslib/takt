import type {
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
} from './types.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import { hasLifecycleTransitionIntent } from './raw-relation-capabilities.js';

export function resolveCurrentLifecycleObservationTarget(
  ledger: Pick<FindingLedger, 'findings' | 'rawFindings'>,
  rawFinding: Pick<
    RawFinding,
    'relation' | 'targetFindingId' | 'targetPrecondition'
  >,
): FindingLedgerEntry | undefined {
  if (
    !hasLifecycleTransitionIntent(rawFinding)
    || rawFinding.targetFindingId === null
    || rawFinding.targetPrecondition === undefined
    || rawFinding.targetPrecondition.targetFindingId !== rawFinding.targetFindingId
    || !findingMatchesMutationPrecondition(ledger, rawFinding.targetPrecondition)
  ) {
    return undefined;
  }
  return ledger.findings.find(
    (finding) => finding.id === rawFinding.targetFindingId,
  );
}
