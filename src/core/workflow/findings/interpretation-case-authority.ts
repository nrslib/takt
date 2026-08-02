import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type { PreparedInterpretationCase } from './interpretation-case-finalizer.js';
import type { CanonicalRawReconcileProvenance, ProvisionalFindingSpec } from './reconciler.js';
import type { FindingLedger, FindingManagerOutput, RawFinding } from './types.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';

interface CanonicalAuthoritySnapshot {
  wire: string;
  provenance: string;
  canonicalIntegrityDigest: string;
}

interface AuthoritySnapshot {
  caseId: string;
  attemptId: string;
  targetFindingId: string;
  rawFindingIds: string[];
  conflict: string;
  provisionalFinding: string;
  canonicalByRawFindingId: Map<string, CanonicalAuthoritySnapshot>;
}

const AUTHORITY_REGISTRY = new WeakMap<object, AuthoritySnapshot>();

declare const interpretationCaseConflictAuthorityBrand: unique symbol;

export interface InterpretationCaseConflictAuthority {
  readonly [interpretationCaseConflictAuthorityBrand]: true;
  readonly caseId: string;
  readonly attemptId: string;
  readonly targetFindingId: string;
  readonly rawFindingIds: string[];
}

export function issueInterpretationCaseConflictAuthority(input: {
  ledger: FindingLedger;
  preparedCase: PreparedInterpretationCase;
  items: readonly CanonicalIntakeItem[];
}): InterpretationCaseConflictAuthority {
  if (input.preparedCase.action.kind !== 'open_conflict') {
    throw new Error('Interpretation case conflict authority requires an open_conflict action');
  }
  if (input.preparedCase.attemptId === null) {
    throw new Error('Interpretation case conflict authority requires a completed attempt');
  }
  const attempt = input.ledger.interpretationAttempts.find(
    (candidate) => candidate.attemptId === input.preparedCase.attemptId,
  );
  if (
    attempt?.stage !== 'completed'
    || attempt.caseId !== input.preparedCase.caseId
    || attempt.decision.kind !== 'open_conflict'
  ) {
    throw new Error('Interpretation case conflict authority requires its completed decision');
  }
  const targetFindingId = input.preparedCase.action.conflict.findingIds[0];
  if (
    targetFindingId === undefined
    || input.preparedCase.action.conflict.findingIds.length !== 1
    || attempt.decision.targetFindingId !== targetFindingId
  ) {
    throw new Error('Interpretation case conflict authority target does not match its decision');
  }
  const itemsByRawFindingId = new Map(input.items.map((item) => [
    item.canonical.rawFindingId,
    item,
  ]));
  const canonicalByRawFindingId = new Map<string, CanonicalAuthoritySnapshot>();
  for (const rawFindingId of input.preparedCase.rawFindingIds) {
    const item = itemsByRawFindingId.get(rawFindingId);
    const observation = input.ledger.interpretationRawObservations.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    );
    const canonicalSnapshot = observation === undefined
      ? undefined
      : input.ledger.rawCanonicalSnapshots.find(
          (candidate) => candidate.rawCanonicalSnapshotId === observation.rawCanonicalSnapshotId,
        );
    if (
      item === undefined
      || observation?.caseId !== input.preparedCase.caseId
      || canonicalSnapshot === undefined
      || canonicalSnapshot.canonicalIntegrityDigest !== canonicalRawIntegrityDigestOf(item.canonical)
    ) {
      throw new Error(`Interpretation case conflict authority member "${rawFindingId}" is not canonical`);
    }
    canonicalByRawFindingId.set(rawFindingId, {
      wire: canonicalJson(item.wire),
      provenance: canonicalJson(item.canonical.provenance),
      canonicalIntegrityDigest: canonicalSnapshot.canonicalIntegrityDigest,
    });
  }
  const authority = Object.freeze({
    caseId: input.preparedCase.caseId,
    attemptId: input.preparedCase.attemptId,
    targetFindingId,
    rawFindingIds: [...input.preparedCase.rawFindingIds],
  }) as InterpretationCaseConflictAuthority;
  AUTHORITY_REGISTRY.set(authority, {
    caseId: authority.caseId,
    attemptId: authority.attemptId,
    targetFindingId,
    rawFindingIds: [...authority.rawFindingIds],
    conflict: canonicalJson(input.preparedCase.action.conflict),
    provisionalFinding: canonicalJson(input.preparedCase.action.provisionalFinding),
    canonicalByRawFindingId,
  });
  return authority;
}

export function verifyInterpretationCaseConflictAuthority(input: {
  authority: InterpretationCaseConflictAuthority;
  ledger: FindingLedger;
  rawFinding: RawFinding;
  conflicts: readonly FindingManagerOutput['conflicts'][number][];
  provisionalFindings: readonly ProvisionalFindingSpec[];
  provenance: CanonicalRawReconcileProvenance;
}): { ok: true } | { ok: false; reason: string } {
  const snapshot = AUTHORITY_REGISTRY.get(input.authority);
  const canonical = snapshot?.canonicalByRawFindingId.get(input.rawFinding.rawFindingId);
  if (snapshot === undefined || canonical === undefined) {
    return { ok: false, reason: 'authority was not issued for this interpretation case raw' };
  }
  if (
    input.authority.caseId !== snapshot.caseId
    || input.authority.attemptId !== snapshot.attemptId
    || input.authority.targetFindingId !== snapshot.targetFindingId
    || canonicalJson(input.authority.rawFindingIds) !== canonicalJson(snapshot.rawFindingIds)
  ) {
    return { ok: false, reason: 'authority identity changed after issuance' };
  }
  if (
    input.conflicts.length !== 1
    || input.provisionalFindings.length !== 1
    || canonicalJson(input.conflicts[0]) !== snapshot.conflict
    || canonicalJson(input.provisionalFindings[0]) !== snapshot.provisionalFinding
  ) {
    return { ok: false, reason: 'conflict or holding provisional does not match the prepared case' };
  }
  if (
    canonicalJson(input.rawFinding) !== canonical.wire
    || canonicalJson(input.provenance.canonicalProvenance) !== canonical.provenance
    || input.provenance.canonicalIntegrityDigest !== canonical.canonicalIntegrityDigest
  ) {
    return { ok: false, reason: 'canonical raw or provenance changed after authority issuance' };
  }
  const attempt = input.ledger.interpretationAttempts.find(
    (candidate) => candidate.attemptId === snapshot.attemptId,
  );
  const observation = input.ledger.interpretationRawObservations.find(
    (candidate) => candidate.rawFindingId === input.rawFinding.rawFindingId,
  );
  const canonicalSnapshot = observation === undefined
    ? undefined
    : input.ledger.rawCanonicalSnapshots.find(
        (candidate) => candidate.rawCanonicalSnapshotId === observation.rawCanonicalSnapshotId,
      );
  if (
    attempt?.stage !== 'completed'
    || attempt.caseId !== snapshot.caseId
    || attempt.decision.kind !== 'open_conflict'
    || attempt.decision.targetFindingId !== snapshot.targetFindingId
    || observation?.caseId !== snapshot.caseId
    || canonicalSnapshot?.canonicalIntegrityDigest !== canonical.canonicalIntegrityDigest
  ) {
    return { ok: false, reason: 'completed attempt or observation no longer authorizes the compound outcome' };
  }
  return { ok: true };
}
