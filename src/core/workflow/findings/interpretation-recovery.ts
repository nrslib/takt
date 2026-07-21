import {
  candidateFromStoredRawFinding,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from './raw-canonicalization.js';
import { classifyProvisionalRecovery, isOpenProvisional } from './provisional-recovery.js';
import type {
  CanonicalIntakeItem,
  RawAdmissionEvaluation,
  ReviewerIntakeResult,
} from './manager-admission.js';
import type {
  FindingLedger,
  FindingObservation,
  FindingProvisionalMetadata,
  RawFinding,
} from './types.js';

export interface InterpretationRecoveryFailure {
  provisionalFindingId: string;
  expectedProvisionalRevision: number;
  attempt: number;
  sourceRawFindingId: string;
  reason: string;
}

function recoveryReviewerStableKey(provisional: FindingProvisionalMetadata): string {
  if (provisional.recoveryReviewerStableKey !== undefined) {
    return provisional.recoveryReviewerStableKey;
  }
  // 既存台帳には reviewer provenance が無いため、stableKey を attempt 名前空間にして同じ lineage の再試行を決定的に保つ。
  return provisional.stableKey;
}

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
    const process = provenanceMatches.length === 1
      ? provenanceMatches[0]
      : processes.length === 1
        ? processes[0]
        : undefined;
    if (process === undefined) {
      return item;
    }
    attachedProcessIds.add(process.id);
    return {
      ...item,
      recoveryOrigin: {
        provisionalFindingId: process.id,
        expectedProvisionalRevision: process.revision ?? 1,
      },
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

export function collectInterpretationRecoveryPlan(input: {
  ledger: FindingLedger;
  currentItems: readonly CanonicalIntakeItem[];
  roundsCompleted: number;
}): { items: CanonicalIntakeItem[]; failures: InterpretationRecoveryFailure[] } {
  const attachedProcessIds = new Set(input.currentItems.flatMap((item) => (
    item.recoveryOrigin === undefined ? [] : [item.recoveryOrigin.provisionalFindingId]
  )));
  return interpretationProcesses(input.ledger, input.roundsCompleted).reduce<{
    items: CanonicalIntakeItem[];
    failures: InterpretationRecoveryFailure[];
  }>((plan, finding) => {
    if (attachedProcessIds.has(finding.id)) {
      return plan;
    }
    const source = sourceRawForRecovery(input.ledger, finding.provisional);
    if (source === undefined) {
      const attempt = (finding.provisional.adjudicationAttempts ?? []).length + 1;
      const sourceRawFindingId = finding.provisional.sourceRawFindingIds.at(-1)
        ?? `interpretation-recovery:${finding.id}:${attempt}`;
      const reason = finding.provisional.sourceRawFindingIds.length === 0
        ? `Interpretation recovery "${finding.provisional.stableKey}" has no source raw finding id`
        : `Interpretation recovery "${finding.provisional.stableKey}" references missing raw finding "${sourceRawFindingId}"`;
      return {
        ...plan,
        failures: [...plan.failures, {
          provisionalFindingId: finding.id,
          expectedProvisionalRevision: finding.revision ?? 1,
          attempt,
          sourceRawFindingId,
          reason,
        }],
      };
    }
    const candidate = candidateFromStoredRawFinding(
      source,
      recoveryReviewerStableKey(finding.provisional),
    );
    const canonical = canonicalizeReviewerRawFinding(candidate, {
      ledger: input.ledger,
      preserveAmbiguityOrigin: true,
    }).canonical;
    return {
      ...plan,
      items: [...plan.items, {
        canonical,
        wire: toLedgerRawFinding(canonical),
        recoveryOrigin: {
          provisionalFindingId: finding.id,
          expectedProvisionalRevision: finding.revision ?? 1,
        },
        interpretationRecoveryAttempt: true,
      }],
    };
  }, { items: [], failures: [] });
}

export function applyInterpretationRecoveryFailures(input: {
  ledger: FindingLedger;
  failures: readonly InterpretationRecoveryFailure[];
  observation: FindingObservation;
}): FindingLedger {
  const failuresByFindingId = new Map(
    input.failures.map((failure) => [failure.provisionalFindingId, failure]),
  );
  return {
    ...input.ledger,
    findings: input.ledger.findings.map((finding) => {
      const failure = failuresByFindingId.get(finding.id);
      if (failure === undefined
        || finding.status !== 'open'
        || finding.provisional === undefined
        || (finding.revision ?? 1) !== failure.expectedProvisionalRevision) {
        return finding;
      }
      return {
        ...finding,
        revision: (finding.revision ?? 1) + 1,
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
  const recoveryItems = intake.items.filter((item) => item.recoveryOrigin !== undefined);
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
    admissionRejectedItems: admission.admissionRejectedItems.filter(
      (item) => !recoveryRawIds.has(item.wire.rawFindingId),
    ),
    locationlessProvisionalItems: admission.locationlessProvisionalItems.filter(
      ({ item }) => !recoveryRawIds.has(item.wire.rawFindingId),
    ),
    pendingRejectedObservations: admission.pendingRejectedObservations.filter(
      ({ item }) => !recoveryRawIds.has(item.wire.rawFindingId),
    ),
    taintedAdmitted: [...admission.taintedAdmitted, ...restrictedItems],
    ladderAnomalySpecs: admission.ladderAnomalySpecs.filter(
      (spec) => spec.sourceRawFindingIds.every((rawFindingId) => !recoveryRawIds.has(rawFindingId)),
    ),
    provisionalOnlyLadderRawIds: new Set([
      ...admission.provisionalOnlyLadderRawIds,
      ...restrictedRawIds,
    ]),
  };
}
