import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  computeRawEvidenceHash,
  toLedgerRawFinding,
} from './raw-canonicalization.js';
import { classifyProvisionalRecovery, isOpenProvisional } from './provisional-recovery.js';
import type {
  CanonicalIntakeItem,
  ProvisionalRecoveryOrigins,
  RawAdmissionEvaluation,
  ReviewerIntakeResult,
} from './manager-admission.js';
import type {
  FindingLedger,
  FindingObservation,
  FindingProvisionalMetadata,
  RawFinding,
} from './types.js';
import {
  matchesProvisionalRecoveryOrigin,
  snapshotProvisionalRecoveryOrigin,
  type ProvisionalRecoveryOrigin,
} from './provisional-recovery-origin.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

interface InterpretationRecoveryFailureBase {
  recoveryOrigin: ProvisionalRecoveryOrigin;
  attempt: number;
  sourceRawFindingId: string;
  reason: string;
}

export type InterpretationRecoveryFailure =
  | InterpretationRecoveryFailureBase & {
      kind: 'source_missing';
      outcome: 'audit_only';
    }
  | InterpretationRecoveryFailureBase & {
      kind: 'reviewer_provenance_missing';
      outcome: 'audit_only';
    }
  | InterpretationRecoveryFailureBase & {
      kind: 'recovery_contract_mismatch';
      outcome: 'audit_only';
    };

export type InterpretationRecoveryCommitFailure =
  | InterpretationRecoveryFailure
  | InterpretationRecoveryFailureBase & {
      kind: 'recovery_origin_stale';
      outcome: 'stale';
    };

function sourceRawForRecovery(
  ledger: FindingLedger,
  provisional: FindingProvisionalMetadata,
): RawFinding | undefined {
  const sourceRawFindingId = provisional.sourceRawFindingIds.at(-1);
  if (sourceRawFindingId === undefined) {
    return undefined;
  }
  return ledger.rawFindings.find((raw) => raw.rawFindingId === sourceRawFindingId);
}

function interpretationProcesses(
  ledger: FindingLedger,
  roundsCompleted: number,
): Array<FindingLedger['findings'][number] & { provisional: FindingProvisionalMetadata }> {
  return ledger.findings.filter((finding): finding is FindingLedger['findings'][number] & {
    provisional: FindingProvisionalMetadata;
  } => isOpenProvisional(finding)
    && classifyProvisionalRecovery(finding.provisional, roundsCompleted) === 'interpretation');
}

export function attachInterpretationRecoveryOrigins(input: {
  ledger: FindingLedger;
  currentItems: readonly CanonicalIntakeItem[];
  roundsCompleted: number;
}): CanonicalIntakeItem[] {
  const processesByLineage = new Map<string, ReturnType<typeof interpretationProcesses>>();
  for (const process of interpretationProcesses(input.ledger, input.roundsCompleted)) {
    const candidates = processesByLineage.get(process.provisional.lineageKey) ?? [];
    processesByLineage.set(process.provisional.lineageKey, [...candidates, process]);
  }
  const attachedProcessIds = new Set<string>();
  return input.currentItems.map((item) => {
    const processes = (processesByLineage.get(item.canonical.lineageKey) ?? [])
      .filter((process) => !attachedProcessIds.has(process.id));
    const provenanceMatches = processes.filter((process) => (
      process.provisional.recoveryReviewerStableKey === item.canonical.reviewerStableKey
    ));
    if (provenanceMatches.length === 0) {
      return item;
    }
    const recoveryOrigins = provenanceMatches
      .sort((left, right) => compareBinaryStrings(left.id, right.id))
      .map((process) => {
        attachedProcessIds.add(process.id);
        return snapshotProvisionalRecoveryOrigin(process);
      });
    const firstOrigin = recoveryOrigins[0];
    if (firstOrigin === undefined) {
      throw new Error(`Interpretation recovery origins disappeared for "${item.wire.rawFindingId}"`);
    }
    return {
      ...item,
      recoveryOrigins: [firstOrigin, ...recoveryOrigins.slice(1)],
      interpretationRecoveryAttempt: true,
    };
  });
}

export function collectInterpretationRecoveryItems(input: {
  ledger: FindingLedger;
  currentItems: readonly CanonicalIntakeItem[];
  roundsCompleted: number;
}): CanonicalIntakeItem[] {
  return collectInterpretationRecoveryPlan(input).items;
}

function appendRecoveryOrigin(
  origins: ProvisionalRecoveryOrigins,
  origin: ProvisionalRecoveryOrigin,
): ProvisionalRecoveryOrigins {
  const sorted = [...origins, origin]
    .sort((left, right) => compareBinaryStrings(
      left.provisionalFindingId,
      right.provisionalFindingId,
    ));
  const first = sorted[0];
  if (first === undefined) {
    throw new Error('Interpretation recovery origin append produced an empty result');
  }
  return [first, ...sorted.slice(1)];
}

export function collectInterpretationRecoveryPlan(input: {
  ledger: FindingLedger;
  currentItems: readonly CanonicalIntakeItem[];
  roundsCompleted: number;
}): { items: CanonicalIntakeItem[]; failures: InterpretationRecoveryFailure[] } {
  const attachedProcessIds = new Set(input.currentItems.flatMap((item) => (
    item.recoveryOrigins?.map((origin) => origin.provisionalFindingId) ?? []
  )));
  const candidatesByRawFindingId = new Map<string, Array<{
    readonly canonical: CanonicalIntakeItem['canonical'];
    readonly source: RawFinding;
    readonly origin: ProvisionalRecoveryOrigin;
    readonly finding: ReturnType<typeof interpretationProcesses>[number];
  }>>();
  const failures: InterpretationRecoveryFailure[] = [];
  const processes = interpretationProcesses(input.ledger, input.roundsCompleted)
    .sort((left, right) => compareBinaryStrings(left.id, right.id));
  for (const finding of processes) {
    if (attachedProcessIds.has(finding.id)) {
      continue;
    }
    const source = sourceRawForRecovery(input.ledger, finding.provisional);
    if (source === undefined) {
      const attempt = (finding.provisional.adjudicationAttempts ?? []).length + 1;
      const sourceRawFindingId = finding.provisional.sourceRawFindingIds.at(-1)
        ?? `interpretation-recovery:${finding.id}:${attempt}`;
      const reason = finding.provisional.sourceRawFindingIds.length === 0
        ? `Interpretation recovery "${finding.provisional.stableKey}" has no source raw finding id`
        : `Interpretation recovery "${finding.provisional.stableKey}" references missing raw finding "${sourceRawFindingId}"`;
      failures.push({
        kind: 'source_missing',
        outcome: 'audit_only',
        recoveryOrigin: snapshotProvisionalRecoveryOrigin(finding),
        attempt,
        sourceRawFindingId,
        reason,
      });
      continue;
    }
    const reviewerStableKey = finding.provisional.recoveryReviewerStableKey;
    if (reviewerStableKey === undefined) {
      const attempt = (finding.provisional.adjudicationAttempts ?? []).length + 1;
      failures.push({
        kind: 'reviewer_provenance_missing',
        outcome: 'audit_only',
        recoveryOrigin: snapshotProvisionalRecoveryOrigin(finding),
        attempt,
        sourceRawFindingId: source.rawFindingId,
        reason: `Interpretation recovery "${finding.provisional.stableKey}" has no reviewer provenance`,
      });
      continue;
    }
    const candidate = candidateFromStoredRawFinding(
      source,
      reviewerStableKey,
    );
    const canonical = canonicalizeReviewerRawFinding(candidate, {
      ledger: input.ledger,
      preserveAmbiguityOrigin: true,
    }).canonical;
    const origin = snapshotProvisionalRecoveryOrigin(finding);
    if (
      canonical.rawFindingId !== source.rawFindingId
      || canonical.lineageKey !== origin.expectedProvisionalLineageKey
      || canonical.reviewerStableKey !== origin.expectedRecoveryReviewerStableKey
      || canonical.evidenceSetHash !== computeRawEvidenceHash(source)
    ) {
      failures.push({
        kind: 'recovery_contract_mismatch',
        outcome: 'audit_only',
        recoveryOrigin: origin,
        attempt: (finding.provisional.adjudicationAttempts ?? []).length + 1,
        sourceRawFindingId: source.rawFindingId,
        reason: `Interpretation recovery "${finding.provisional.stableKey}" does not match the reconstructed stored raw contract`,
      });
      continue;
    }
    const existing = candidatesByRawFindingId.get(source.rawFindingId) ?? [];
    candidatesByRawFindingId.set(source.rawFindingId, [
      ...existing,
      { canonical, source, origin, finding },
    ]);
  }
  const items: CanonicalIntakeItem[] = [];
  for (const candidates of candidatesByRawFindingId.values()) {
    const contractKeys = new Set(candidates.map(({ canonical }) => (
      `${canonical.lineageKey}\0${canonical.reviewerStableKey}\0${canonical.evidenceSetHash}`
    )));
    if (contractKeys.size !== 1) {
      for (const candidate of candidates) {
        failures.push({
          kind: 'recovery_contract_mismatch',
          outcome: 'audit_only',
          recoveryOrigin: candidate.origin,
          attempt: (candidate.finding.provisional.adjudicationAttempts ?? []).length + 1,
          sourceRawFindingId: candidate.source.rawFindingId,
          reason: `Interpretation recovery "${candidate.finding.provisional.stableKey}" shares a raw payload with a different recovery contract`,
        });
      }
      continue;
    }
    const first = candidates[0];
    if (first === undefined) {
      continue;
    }
    const origins = candidates.slice(1).reduce<ProvisionalRecoveryOrigins>(
      (collected, candidate) => appendRecoveryOrigin(collected, candidate.origin),
      [first.origin],
    );
    items.push({
      canonical: first.canonical,
      wire: toLedgerRawFinding(first.canonical),
      recoveryOrigins: origins,
      interpretationRecoveryAttempt: true,
    });
  }
  return {
    items,
    failures,
  };
}

export function resolveInterpretationRecoveryFailuresForCommit(
  ledger: FindingLedger,
  failures: readonly InterpretationRecoveryFailure[],
): InterpretationRecoveryCommitFailure[] {
  return failures.map((failure) => {
    const finding = ledger.findings.find(
      (candidate) => candidate.id === failure.recoveryOrigin.provisionalFindingId,
    );
    if (finding !== undefined && matchesProvisionalRecoveryOrigin(finding, failure.recoveryOrigin)) {
      return failure;
    }
    return {
      ...failure,
      kind: 'recovery_origin_stale',
      outcome: 'stale',
      reason: `Interpretation recovery origin changed before commit: ${failure.reason}`,
    };
  });
}

export function applyInterpretationRecoveryFailures(input: {
  ledger: FindingLedger;
  failures: readonly InterpretationRecoveryCommitFailure[];
  observation: FindingObservation;
}): FindingLedger {
  const failuresByFindingId = new Map(
    input.failures.flatMap((failure) => {
      switch (failure.kind) {
        case 'source_missing':
        case 'reviewer_provenance_missing':
        case 'recovery_contract_mismatch':
          return [[failure.recoveryOrigin.provisionalFindingId, failure] as const];
        case 'recovery_origin_stale':
          return [];
      }
    }),
  );
  return {
    ...input.ledger,
    findings: input.ledger.findings.map((finding) => {
      const failure = failuresByFindingId.get(finding.id);
      if (failure === undefined
        || !matchesProvisionalRecoveryOrigin(finding, failure.recoveryOrigin)) {
        return finding;
      }
      return {
        ...finding,
        revision: finding.revision + 1,
        provisional: {
          ...finding.provisional,
          adjudicationAttempts: [
            ...(finding.provisional.adjudicationAttempts ?? []),
            {
              attempt: failure.attempt,
              replayRawFindingId: failure.sourceRawFindingId,
              reason: failure.reason,
              at: input.observation,
            },
          ],
        },
      };
    }),
  };
}

export function retainInterpretationRecoveryForLadder(
  admission: RawAdmissionEvaluation,
  intake: ReviewerIntakeResult,
): RawAdmissionEvaluation {
  const recoveryItems = intake.items.filter((item) => item.recoveryOrigins !== undefined);
  if (recoveryItems.length === 0) {
    return admission;
  }
  const recoveryRawIds = new Set(recoveryItems.map((item) => item.wire.rawFindingId));
  const admittedRawIds = new Set([
    ...admission.cleanAdmitted,
    ...admission.taintedAdmitted,
  ].map((item) => item.wire.rawFindingId));
  const restrictedItems = recoveryItems.filter((item) => !admittedRawIds.has(item.wire.rawFindingId));
  const restrictedRawIds = new Set(restrictedItems.map((item) => item.wire.rawFindingId));
  return {
    ...admission,
    admissionRejections: admission.admissionRejections.filter(
      (rejection) => !recoveryRawIds.has(rejection.rawFindingId),
    ),
    admissionAnomalySpecs: admission.admissionAnomalySpecs.filter(
      (spec) => spec.sourceRawFindingIds.every((rawFindingId) => !recoveryRawIds.has(rawFindingId)),
    ),
    admissionProvisionalSpecs: admission.admissionProvisionalSpecs.filter(
      (spec) => spec.sourceRawFindingIds.every((rawFindingId) => !recoveryRawIds.has(rawFindingId)),
    ),
    admissionRejectedItems: admission.admissionRejectedItems.filter(
      (item) => !recoveryRawIds.has(item.wire.rawFindingId),
    ),
    pendingRejectedObservations: admission.pendingRejectedObservations.filter(
      ({ item }) => !recoveryRawIds.has(item.wire.rawFindingId),
    ),
    taintedAdmitted: [...admission.taintedAdmitted, ...restrictedItems],
    ladderAnomalySpecs: admission.ladderAnomalySpecs.filter(
      (spec) => spec.sourceRawFindingIds.every((rawFindingId) => !recoveryRawIds.has(rawFindingId)),
    ),
    verifiedEvidenceRecordsByRawFindingId: new Map(
      [...admission.verifiedEvidenceRecordsByRawFindingId].filter(
        ([rawFindingId]) => !restrictedRawIds.has(rawFindingId),
      ),
    ),
    provisionalOnlyLadderRawIds: new Set([
      ...admission.provisionalOnlyLadderRawIds,
      ...restrictedRawIds,
    ]),
  };
}
