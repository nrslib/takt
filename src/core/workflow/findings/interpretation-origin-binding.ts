import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  computeInterpretationOriginBindingId,
  computeInterpretationOriginSettlementId,
  computeInterpretationOriginSnapshotDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  InterpretationCaseSnapshot,
  InterpretationRawObservation,
  InterpretationRecoveryOriginBinding,
  InterpretationRecoveryOriginSettlement,
  RawCanonicalSnapshot,
} from '../../models/finding-contract-types.js';
import type {
  FindingLedger,
  FindingObservation,
  RawFinding,
} from './types.js';
import type {
  InterpretationOriginAttachmentPlan,
  InterpretationOriginCandidate,
} from './interpretation-origin-attachment.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';

export interface ReconstructedInterpretationMember {
  raw: RawFinding;
  canonicalSnapshot: RawCanonicalSnapshot;
  observation: InterpretationRawObservation;
  originBindings: InterpretationRecoveryOriginBinding[];
}

function sourceRawFindingIdsDigest(sourceRawFindingIds: readonly string[]): string {
  return findingContentAddress('interpretation-origin-source-raw-set', {
    sourceRawFindingIds: binarySortedUnique(sourceRawFindingIds),
  });
}

export function interpretationOriginSnapshotDigest(
  candidate: InterpretationOriginCandidate,
): string {
  return computeInterpretationOriginSnapshotDigest({
    originFindingId: candidate.originFindingId,
    expectedHead: candidate.expectedHead,
    originProvisionalKind: candidate.originProvisionalKind,
    originStableKey: candidate.originStableKey,
    originLineageKey: candidate.originLineageKey,
    recoveryReviewerStableKey: candidate.recoveryReviewerStableKey,
    sourceRawFindingIdsDigest: sourceRawFindingIdsDigest(candidate.sourceRawFindingIds),
  });
}

export function originSnapshotDigestsByRawFindingId(
  plans: readonly InterpretationOriginAttachmentPlan[],
): ReadonlyMap<string, string[]> {
  return new Map(plans.map((plan) => [
    plan.rawFindingId,
    binarySortedUnique(plan.origins.map(interpretationOriginSnapshotDigest)),
  ]));
}

export function createInterpretationOriginBindings(input: {
  caseSnapshot: InterpretationCaseSnapshot;
  plans: readonly InterpretationOriginAttachmentPlan[];
  boundAt: FindingObservation;
}): InterpretationRecoveryOriginBinding[] {
  const caseRawIds = new Set(input.caseSnapshot.memberRawFindingIds);
  return input.plans.flatMap((plan) => {
    if (!caseRawIds.has(plan.rawFindingId)) {
      return [];
    }
    return plan.origins.map((origin) => {
      const sourceDigest = sourceRawFindingIdsDigest(origin.sourceRawFindingIds);
      const originSnapshotDigest = interpretationOriginSnapshotDigest(origin);
      const identity = {
        caseSnapshotId: input.caseSnapshot.caseSnapshotId,
        observationRawFindingId: plan.rawFindingId,
        originFindingId: origin.originFindingId,
        originSnapshotDigest,
      };
      return {
        bindingId: computeInterpretationOriginBindingId(identity),
        ...identity,
        caseId: input.caseSnapshot.caseId,
        cohortId: input.caseSnapshot.cohortId,
        expectedHead: structuredClone(origin.expectedHead),
        originProvisionalKind: origin.originProvisionalKind,
        originStableKey: origin.originStableKey,
        originLineageKey: origin.originLineageKey,
        recoveryReviewerStableKey: origin.recoveryReviewerStableKey,
        sourceRawFindingIdsDigest: sourceDigest,
        boundAt: structuredClone(input.boundAt),
      };
    });
  }).sort((left, right) => compareBinaryStrings(left.bindingId, right.bindingId));
}

export function activeInterpretationOriginBindings(
  ledger: FindingLedger,
): InterpretationRecoveryOriginBinding[] {
  const settled = new Set(
    ledger.interpretationRecoveryOriginSettlements.map(({ bindingId }) => bindingId),
  );
  return ledger.interpretationRecoveryOriginBindings.filter(
    (binding) => !settled.has(binding.bindingId),
  );
}

export function isInterpretationOriginBindingFresh(
  ledger: FindingLedger,
  binding: InterpretationRecoveryOriginBinding,
): boolean {
  const currentHead = captureFindingLifecycleHead(
    ledger,
    'finding',
    binding.originFindingId,
  );
  return currentHead !== undefined
    && canonicalJson(currentHead) === canonicalJson(binding.expectedHead);
}

export function createInterpretationOriginSettlement(input: {
  binding: InterpretationRecoveryOriginBinding;
  recordedAt: FindingObservation;
  result:
    | { outcome: 'stale'; reason: string }
    | {
        outcome: 'retained';
        reason:
          | 'case_decision_provisional'
          | 'case_decision_rejected_stale'
          | 'case_decision_rejected_raw_invalid'
          | 'origin_not_targeted';
      }
    | { outcome: 'settled'; targetFindingId: string; lifecycleEventId: string };
}): InterpretationRecoveryOriginSettlement {
  return {
    settlementId: computeInterpretationOriginSettlementId(input.binding.bindingId),
    bindingId: input.binding.bindingId,
    caseSnapshotId: input.binding.caseSnapshotId,
    caseId: input.binding.caseId,
    observationRawFindingId: input.binding.observationRawFindingId,
    originFindingId: input.binding.originFindingId,
    originSnapshotDigest: input.binding.originSnapshotDigest,
    recordedAt: structuredClone(input.recordedAt),
    ...input.result,
  };
}

export function reconstructInterpretationCaseMembers(
  ledger: FindingLedger,
  caseSnapshotId: string,
): ReconstructedInterpretationMember[] {
  const caseSnapshots = ledger.interpretationCaseSnapshots.filter(
    (snapshot) => snapshot.caseSnapshotId === caseSnapshotId,
  );
  if (caseSnapshots.length !== 1) {
    throw new Error(`Interpretation case snapshot "${caseSnapshotId}" is not exact-one`);
  }
  const caseSnapshot = caseSnapshots[0]!;
  return caseSnapshot.memberRawFindingIds.map((rawFindingId) => {
    const raws = ledger.rawFindings.filter((raw) => raw.rawFindingId === rawFindingId);
    const snapshots = ledger.rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === rawFindingId,
    );
    const observations = ledger.interpretationRawObservations.filter(
      (observation) => observation.rawFindingId === rawFindingId
        && observation.caseSnapshotId === caseSnapshotId,
    );
    if (raws.length !== 1 || snapshots.length !== 1 || observations.length !== 1) {
      throw new Error(`Interpretation case "${caseSnapshotId}" member "${rawFindingId}" is incomplete`);
    }
    const observation = observations[0]!;
    const originBindings = observation.recoveryOriginBindingIds.map((bindingId) => {
      const bindings = ledger.interpretationRecoveryOriginBindings.filter(
        (binding) => binding.bindingId === bindingId,
      );
      if (bindings.length !== 1) {
        throw new Error(`Interpretation origin binding "${bindingId}" is not exact-one`);
      }
      return bindings[0]!;
    });
    return {
      raw: structuredClone(raws[0]!),
      canonicalSnapshot: structuredClone(snapshots[0]!),
      observation: structuredClone(observation),
      originBindings: structuredClone(originBindings),
    };
  });
}
