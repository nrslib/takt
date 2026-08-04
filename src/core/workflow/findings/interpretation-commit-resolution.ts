import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeInterpretationObservationDigest,
  computeRawPayloadDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  InterpretationAttemptApplication,
  InterpretationRecoveryOriginBinding,
} from '../../models/finding-contract-types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import {
  isInterpretationOriginBindingFresh,
  reconstructInterpretationCaseMembers,
} from './interpretation-origin-binding.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import type { FindingLedger, FindingLifecycleEntityHead } from './types.js';

export type InterpretationStaleCause =
  | {
      kind: 'origin_head_changed';
      bindingId: string;
      rawFindingId: string;
      expectedHead: FindingLifecycleEntityHead;
      actualHead: FindingLifecycleEntityHead | null;
    }
  | {
      kind: 'semantic_target_head_changed';
      rawFindingId: string;
      targetFindingId: string;
      expectedHead: FindingLifecycleEntityHead;
      actualHead: FindingLifecycleEntityHead | null;
    };

export interface InterpretationCommitResolution {
  application: InterpretationAttemptApplication;
  staleCauses: InterpretationStaleCause[];
  staleRawFindingIds: Set<string>;
  freshOriginBindings: InterpretationRecoveryOriginBinding[];
  staleOriginBindings: InterpretationRecoveryOriginBinding[];
}

function assertSnapshotIntegrity(input: {
  ledger: FindingLedger;
  caseSnapshotId: string;
  itemsByRawFindingId: ReadonlyMap<string, CanonicalIntakeItem>;
}): void {
  const members = reconstructInterpretationCaseMembers(input.ledger, input.caseSnapshotId);
  for (const member of members) {
    const item = input.itemsByRawFindingId.get(member.raw.rawFindingId);
    if (item === undefined) {
      throw new Error(
        `Interpretation commit is missing canonical replay for "${member.raw.rawFindingId}"`,
      );
    }
    if (
      computeRawPayloadDigest(member.raw) !== member.canonicalSnapshot.rawPayloadDigest
      || canonicalJson(member.raw) !== canonicalJson(item.wire)
    ) {
      throw new Error(
        `Interpretation raw payload integrity failed for "${member.raw.rawFindingId}"`,
      );
    }
    if (
      member.canonicalSnapshot.canonicalIntegrityDigest
        !== canonicalRawIntegrityDigestOf(item.canonical)
    ) {
      throw new Error(
        `Interpretation canonical replay failed for "${member.raw.rawFindingId}"`,
      );
    }
    const observationWithoutDigest = {
      rawFindingId: member.observation.rawFindingId,
      rawCanonicalSnapshotId: member.observation.rawCanonicalSnapshotId,
      caseId: member.observation.caseId,
      cohortId: member.observation.cohortId,
      caseSnapshotId: member.observation.caseSnapshotId,
      lineageKey: member.observation.lineageKey,
      semanticProjectionDigest: member.observation.semanticProjectionDigest,
      originSnapshotDigests: member.observation.originSnapshotDigests,
      recoveryOriginBindingIds: member.observation.recoveryOriginBindingIds,
    };
    if (
      member.observation.observationDigest
        !== computeInterpretationObservationDigest(observationWithoutDigest)
      || member.observation.rawCanonicalSnapshotId
        !== member.canonicalSnapshot.rawCanonicalSnapshotId
    ) {
      throw new Error(
        `Interpretation observation integrity failed for "${member.raw.rawFindingId}"`,
      );
    }
  }
}

function staleCauseDigest(cause: InterpretationStaleCause): string {
  return findingContentAddress('interpretation-stale-cause', cause);
}

function expectedHeadForTarget(input: {
  ledger: FindingLedger;
  targetFindingId: string;
  targetRevision: number;
}): FindingLifecycleEntityHead {
  const heads = input.ledger.lifecycleEvents.flatMap((event) => (
    event.transitions
      .map((transition) => transition.after)
      .filter((head) => (
        head.entityKind === 'finding'
        && head.entityId === input.targetFindingId
        && head.revision === input.targetRevision
      ))
  ));
  if (heads.length !== 1) {
    throw new Error(
      `Interpretation target head for "${input.targetFindingId}" revision ${input.targetRevision} is not exact-one`,
    );
  }
  return heads[0]!;
}

export function resolveInterpretationCommit(input: {
  ledger: FindingLedger;
  caseSnapshotId: string;
  items: readonly CanonicalIntakeItem[];
  invalidRawFindingIds?: ReadonlySet<string>;
}): InterpretationCommitResolution {
  const itemsByRawFindingId = new Map(
    input.items.map((item) => [item.canonical.rawFindingId, item]),
  );
  assertSnapshotIntegrity({
    ledger: input.ledger,
    caseSnapshotId: input.caseSnapshotId,
    itemsByRawFindingId,
  });
  const members = reconstructInterpretationCaseMembers(input.ledger, input.caseSnapshotId);
  const staleCauses: InterpretationStaleCause[] = [];
  const freshOriginBindings: InterpretationRecoveryOriginBinding[] = [];
  const staleOriginBindings: InterpretationRecoveryOriginBinding[] = [];
  for (const member of members) {
    for (const binding of member.originBindings) {
      if (isInterpretationOriginBindingFresh(input.ledger, binding)) {
        freshOriginBindings.push(binding);
        continue;
      }
      staleOriginBindings.push(binding);
      staleCauses.push({
        kind: 'origin_head_changed',
        bindingId: binding.bindingId,
        rawFindingId: member.raw.rawFindingId,
        expectedHead: structuredClone(binding.expectedHead),
        actualHead: captureFindingLifecycleHead(
          input.ledger,
          'finding',
          binding.originFindingId,
        ) ?? null,
      });
    }
    const item = itemsByRawFindingId.get(member.raw.rawFindingId)!;
    const precondition = item.canonical.targetPrecondition;
    if (
      precondition !== undefined
      && !findingMatchesMutationPrecondition(input.ledger, precondition)
    ) {
      const expectedHead = expectedHeadForTarget({
        ledger: input.ledger,
        targetFindingId: precondition.targetFindingId,
        targetRevision: precondition.targetRevision,
      });
      staleCauses.push({
        kind: 'semantic_target_head_changed',
        rawFindingId: member.raw.rawFindingId,
        targetFindingId: precondition.targetFindingId,
        expectedHead: structuredClone(expectedHead),
        actualHead: captureFindingLifecycleHead(
          input.ledger,
          'finding',
          precondition.targetFindingId,
        ) ?? null,
      });
    }
  }
  staleCauses.sort((left, right) => (
    compareBinaryStrings(staleCauseDigest(left), staleCauseDigest(right))
  ));
  const staleRawFindingIds = new Set(staleCauses.map((cause) => cause.rawFindingId));
  const invalidRawFindingIds = [...(input.invalidRawFindingIds ?? new Set<string>())]
    .sort(compareBinaryStrings);
  const staleCauseDigests = staleCauses.map(staleCauseDigest);
  const originSettlementIds: string[] = [];
  const application: InterpretationAttemptApplication = invalidRawFindingIds.length > 0
    ? {
        classification: 'decision_rejected_raw_invalid',
        invalidRawFindingIds,
        originSettlementIds,
      }
    : staleCauseDigests.length > 0
      ? {
          classification: 'decision_rejected_stale',
          staleCauseDigests,
          originSettlementIds,
        }
      : { classification: 'decision_applied', originSettlementIds };
  return {
    application,
    staleCauses,
    staleRawFindingIds,
    freshOriginBindings: freshOriginBindings.sort((left, right) => (
      compareBinaryStrings(left.bindingId, right.bindingId)
    )),
    staleOriginBindings: staleOriginBindings.sort((left, right) => (
      compareBinaryStrings(left.bindingId, right.bindingId)
    )),
  };
}
