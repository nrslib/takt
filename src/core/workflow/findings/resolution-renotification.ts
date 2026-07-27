import { formatConflictId } from '../../models/finding-conflict-identity.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingMutationPrecondition,
  FindingObservation,
  FindingRecord,
  RawFinding,
} from './types.js';
import {
  findingMatchesMutationPrecondition,
  sameFindingMutationPrecondition,
} from './finding-preconditions.js';
import { foldFindingObservation } from './finding-evidence-fold.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export interface ResolutionRenotificationTransition {
  readonly findingId: string;
  readonly observed: FindingMutationPrecondition;
  readonly expectedTarget: FindingMutationPrecondition;
  readonly resolutionRawFindingIds: readonly string[];
  readonly renotificationRawFindingIds: readonly string[];
}

function mergeIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort(compareBinaryStrings);
}

export function mergeResolutionRenotificationTransitions(
  transitions: readonly ResolutionRenotificationTransition[],
): ResolutionRenotificationTransition[] {
  const byFindingId = new Map<string, ResolutionRenotificationTransition>();
  for (const transition of transitions) {
    const existing = byFindingId.get(transition.findingId);
    if (existing === undefined) {
      byFindingId.set(transition.findingId, {
        ...transition,
        resolutionRawFindingIds: mergeIds([], transition.resolutionRawFindingIds),
        renotificationRawFindingIds: mergeIds([], transition.renotificationRawFindingIds),
      });
      continue;
    }
    if (
      !sameFindingMutationPrecondition(existing.observed, transition.observed)
      || !sameFindingMutationPrecondition(
        existing.expectedTarget,
        transition.expectedTarget,
      )
    ) {
      throw new Error(
        `Resolution/renotification transition for "${transition.findingId}" has inconsistent observed revisions`,
      );
    }
    byFindingId.set(transition.findingId, {
      ...existing,
      resolutionRawFindingIds: mergeIds(
        existing.resolutionRawFindingIds,
        transition.resolutionRawFindingIds,
      ),
      renotificationRawFindingIds: mergeIds(
        existing.renotificationRawFindingIds,
        transition.renotificationRawFindingIds,
      ),
    });
  }
  return [...byFindingId.values()].sort((left, right) => (
    compareBinaryStrings(left.findingId, right.findingId)
  ));
}

function requireRawFindings(
  ledger: FindingLedger,
  rawFindingIds: readonly string[],
  relation: RawFinding['relation'],
  findingId: string,
  observed: FindingMutationPrecondition,
): RawFinding[] {
  const rawById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  return rawFindingIds.map((rawFindingId) => {
    const raw = rawById.get(rawFindingId);
    if (
      raw === undefined
      || raw.relation !== relation
      || raw.targetFindingId !== findingId
      || raw.targetPrecondition === undefined
      || !sameFindingMutationPrecondition(raw.targetPrecondition, observed)
    ) {
      throw new Error(
        `Resolution/renotification transition for "${findingId}" has invalid raw finding "${rawFindingId}"`,
      );
    }
    return raw;
  });
}

function withoutResolutionFields(
  finding: FindingRecord,
): Omit<FindingRecord, 'resolvedAt' | 'resolvedEvidence'> {
  const remaining = { ...finding };
  delete remaining.resolvedAt;
  delete remaining.resolvedEvidence;
  return remaining;
}

function withoutConflictResolutionFields(
  conflict: FindingLedgerConflict,
): Omit<FindingLedgerConflict, 'resolvedAt' | 'resolvedEvidence'> {
  const remaining = { ...conflict };
  delete remaining.resolvedAt;
  delete remaining.resolvedEvidence;
  return remaining;
}

function transitionDescription(findingId: string, revision: number): string {
  return `Resolution confirmation conflicts with verified renotification of finding "${findingId}" observed at revision ${revision}`;
}

export function applyResolutionRenotificationTransitions(input: {
  readonly ledger: FindingLedger;
  readonly transitions: readonly ResolutionRenotificationTransition[];
  readonly observation: FindingObservation;
}): FindingLedger {
  if (input.transitions.length === 0) {
    return input.ledger;
  }
  const findingsById = new Map(
    input.ledger.findings.map((finding) => [finding.id, finding]),
  );
  const conflictsById = new Map(
    input.ledger.conflicts.map((conflict) => [conflict.id, conflict]),
  );

  for (const transition of mergeResolutionRenotificationTransitions(input.transitions)) {
    if (
      transition.observed.targetFindingId !== transition.findingId
      || transition.observed.targetStatus !== 'open'
      || transition.expectedTarget.targetFindingId !== transition.findingId
      || transition.expectedTarget.targetRevision !== transition.observed.targetRevision + 1
      || (
        transition.expectedTarget.targetStatus !== 'open'
        && transition.expectedTarget.targetStatus !== 'resolved'
      )
    ) {
      throw new Error(
        `Resolution/renotification transition for "${transition.findingId}" has an invalid revision transition`,
      );
    }
    const finding = findingsById.get(transition.findingId);
    if (
      finding === undefined
      || !findingMatchesMutationPrecondition(input.ledger, transition.expectedTarget)
    ) {
      throw new Error(
        `Resolution/renotification transition CAS failed for "${transition.findingId}"`,
      );
    }
    const resolutionRawFindings = requireRawFindings(
      input.ledger,
      transition.resolutionRawFindingIds,
      'resolution_confirmation',
      transition.findingId,
      transition.observed,
    );
    const renotificationRawFindings = transition.renotificationRawFindingIds.flatMap(
      (rawFindingId) => {
        const persists = input.ledger.rawFindings.find(
          (raw) => raw.rawFindingId === rawFindingId,
        );
        if (
          persists === undefined
          || (persists.relation !== 'persists' && persists.relation !== 'reopened')
          || persists.targetFindingId !== transition.findingId
          || persists.targetPrecondition === undefined
          || !sameFindingMutationPrecondition(
            persists.targetPrecondition,
            transition.observed,
          )
        ) {
          throw new Error(
            `Resolution/renotification transition for "${transition.findingId}" has invalid raw finding "${rawFindingId}"`,
          );
        }
        return [persists];
      },
    );
    if (resolutionRawFindings.length === 0 || renotificationRawFindings.length === 0) {
      throw new Error(
        `Resolution/renotification transition for "${transition.findingId}" requires both observations`,
      );
    }
    const description = transitionDescription(
      transition.findingId,
      transition.observed.targetRevision,
    );
    const foldedObservation = foldFindingObservation({
      finding,
      rawFindings: renotificationRawFindings,
      observation: input.observation,
    });
    findingsById.set(transition.findingId, {
      ...withoutResolutionFields(finding),
      status: 'open',
      lifecycle: 'reopened',
      revision: finding.revision + 1,
      ...foldedObservation,
      rawFindingIds: mergeIds(
        foldedObservation.rawFindingIds,
        transition.resolutionRawFindingIds,
      ),
      reopenedEvidence: description,
    });

    const conflictShape = {
      findingIds: [transition.findingId],
      rawFindingIds: mergeIds(
        transition.resolutionRawFindingIds,
        transition.renotificationRawFindingIds,
      ),
    };
    const conflictId = formatConflictId(conflictShape);
    const existingConflict = conflictsById.get(conflictId);
    const conflictBase = existingConflict === undefined
      ? {
          id: conflictId,
          status: 'active' as const,
          findingIds: conflictShape.findingIds,
          rawFindingIds: [],
          description,
          firstSeen: input.observation,
          lastSeen: input.observation,
        }
      : withoutConflictResolutionFields(existingConflict);
    conflictsById.set(conflictId, {
      ...conflictBase,
      status: 'active',
      rawFindingIds: mergeIds(
        conflictBase.rawFindingIds,
        conflictShape.rawFindingIds,
      ),
      description,
      lastSeen: input.observation,
    });
  }

  return {
    ...input.ledger,
    findings: [...findingsById.values()]
      .sort((left, right) => compareBinaryStrings(left.id, right.id)),
    conflicts: [...conflictsById.values()]
      .sort((left, right) => compareBinaryStrings(left.id, right.id)),
  };
}
