import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingProvisionalKind,
} from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';

const FRESH_SETTLEMENT_KINDS = new Set<FindingProvisionalKind>([
  'raw-meaning-ambiguous',
  'raw-adjudication-unresolved',
  'recovery-origin-stale',
]);

export interface InterpretationOriginCandidate {
  originFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  originProvisionalKind: FindingProvisionalKind;
  originStableKey: string;
  originLineageKey: string;
  recoveryReviewerStableKey: string;
  sourceRawFindingIds: string[];
}

export interface InterpretationOriginAttachmentPlan {
  rawFindingId: string;
  origins: InterpretationOriginCandidate[];
}

function compareItems(left: CanonicalIntakeItem, right: CanonicalIntakeItem): number {
  return compareBinaryStrings(left.canonical.lineageKey, right.canonical.lineageKey)
    || compareBinaryStrings(
      left.canonical.reviewerStableKey,
      right.canonical.reviewerStableKey,
    )
    || compareBinaryStrings(left.canonical.rawFindingId, right.canonical.rawFindingId);
}

function compareOrigins(
  left: InterpretationOriginCandidate,
  right: InterpretationOriginCandidate,
): number {
  return compareBinaryStrings(left.originLineageKey, right.originLineageKey)
    || compareBinaryStrings(
      left.recoveryReviewerStableKey,
      right.recoveryReviewerStableKey,
    )
    || compareBinaryStrings(left.originFindingId, right.originFindingId);
}

function activeBoundOriginIds(ledger: FindingLedger): Set<string> {
  const settledBindingIds = new Set(
    ledger.interpretationRecoveryOriginSettlements.map(({ bindingId }) => bindingId),
  );
  return new Set(ledger.interpretationRecoveryOriginBindings.flatMap((binding) => (
    settledBindingIds.has(binding.bindingId) ? [] : [binding.originFindingId]
  )));
}

function originCandidate(
  ledger: FindingLedger,
  findingId: string,
  currentRound: number,
): InterpretationOriginCandidate | null {
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  const provisional = finding?.provisional;
  if (
    finding === undefined
    || finding.status !== 'open'
    || provisional === undefined
    || !FRESH_SETTLEMENT_KINDS.has(provisional.kind)
    || provisional.recoveryReviewerStableKey === undefined
    || provisional.firstObservedRound >= currentRound
  ) {
    return null;
  }
  const expectedHead = captureFindingLifecycleHead(ledger, 'finding', finding.id);
  if (expectedHead === undefined) {
    throw new Error(`Interpretation recovery origin "${finding.id}" has no lifecycle head`);
  }
  return {
    originFindingId: finding.id,
    expectedHead,
    originProvisionalKind: provisional.kind,
    originStableKey: provisional.stableKey,
    originLineageKey: provisional.lineageKey,
    recoveryReviewerStableKey: provisional.recoveryReviewerStableKey,
    sourceRawFindingIds: [...provisional.sourceRawFindingIds].sort(compareBinaryStrings),
  };
}

export function planInterpretationOriginAttachments(input: {
  ledger: FindingLedger;
  freshItems: readonly CanonicalIntakeItem[];
  currentRound: number;
}): InterpretationOriginAttachmentPlan[] {
  if (!Number.isSafeInteger(input.currentRound) || input.currentRound < 1) {
    throw new Error('Interpretation origin attachment round must be a positive safe integer');
  }
  const activeOrigins = activeBoundOriginIds(input.ledger);
  const conflictHoldingIds = new Set(
    input.ledger.conflictRawClaimLandings.map(({ holdingFindingId }) => holdingFindingId),
  );
  const candidates = input.ledger.findings.flatMap((finding) => {
    if (activeOrigins.has(finding.id) || conflictHoldingIds.has(finding.id)) {
      return [];
    }
    const candidate = originCandidate(input.ledger, finding.id, input.currentRound);
    return candidate === null ? [] : [candidate];
  }).sort(compareOrigins);
  const orderedItems = [...input.freshItems].sort(compareItems);
  const ownerByGroup = new Map<string, CanonicalIntakeItem>();
  for (const item of orderedItems) {
    const groupKey = `${item.canonical.lineageKey}\0${item.canonical.reviewerStableKey}`;
    if (!ownerByGroup.has(groupKey)) {
      ownerByGroup.set(groupKey, item);
    }
  }
  return orderedItems.map((item) => {
    const groupKey = `${item.canonical.lineageKey}\0${item.canonical.reviewerStableKey}`;
    const ownsGroup = ownerByGroup.get(groupKey)?.canonical.rawFindingId
      === item.canonical.rawFindingId;
    return {
      rawFindingId: item.canonical.rawFindingId,
      origins: ownsGroup
        ? candidates.filter((candidate) => (
            candidate.originLineageKey === item.canonical.lineageKey
            && candidate.recoveryReviewerStableKey === item.canonical.reviewerStableKey
          ))
        : [],
    };
  });
}
