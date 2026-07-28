import type {
  CanonicalRawReconcileProvenance,
  ProvisionalFindingSpec,
} from './reconciler.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import { resolveReviewIntegrityLimits } from './review-integrity.js';
import { captureFindingPreconditions } from './finding-preconditions.js';
import type {
  FindingLedgerMutation,
  ProvisionalLandingReport,
  ReviewerAnomalyLandingReport,
} from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  InterpretationRecoveryOriginSettlement,
  RawFindingDisposition,
} from './types.js';
import { evaluateRawAdmission, type RawAdmissionEvaluation, type ReviewerIntakeResult } from './manager-admission.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';

import { mergeOutputs, revalidateManagerPlan } from './manager-commit-revalidation.js';
import { buildLadderCommitPlan, selectCommittableLadder } from './manager-ladder-commit-plan.js';
import { applyCommitLedgerStates, reconcileCommitPlan } from './manager-commit-finalization.js';
import {
  applyManagerActionRecovery,
  collectManagerActionRecoveryCandidates,
} from './manager-action-recovery.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { applyRawAdjudicationRecovery } from './raw-adjudication-commit.js';
import {
  applyInterpretationRecoveryFailures,
  resolveInterpretationRecoveryFailuresForCommit,
  type InterpretationRecoveryCommitFailure,
  retainInterpretationRecoveryForLadder,
  type InterpretationRecoveryFailure,
} from './interpretation-recovery.js';
import {
  collectStaleRecoveryRawFindingIds,
  matchesProvisionalRecoveryOrigin,
} from './provisional-recovery-origin.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { compareCanonicalJsonValues } from '../../../shared/utils/canonical-json.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
export interface CommitMutationResult {
  applied: boolean;
  staleRejections: string[];
  admissionRejections: RawAdmissionEvaluation['admissionRejections'];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rawFindingDispositions: RawFindingDisposition[];
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
}

export interface FindingManagerCommitPlanInput {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  interpretationRecoveryFailures: InterpretationRecoveryFailure[];
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  reviewScopeSnapshotId: string;
}

function interpretationRecoveryDispositions(
  failures: readonly InterpretationRecoveryCommitFailure[],
): RawFindingDisposition[] {
  const failuresByRawFindingId = new Map<string, InterpretationRecoveryCommitFailure[]>();
  for (const failure of failures) {
    failuresByRawFindingId.set(
      failure.sourceRawFindingId,
      [...(failuresByRawFindingId.get(failure.sourceRawFindingId) ?? []), failure],
    );
  }
  return [...failuresByRawFindingId]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([rawFindingId, rawFailures]) => {
      const ordered = [...rawFailures].sort((left, right) => (
        compareBinaryStrings(
          left.recoveryOrigin.provisionalFindingId,
          right.recoveryOrigin.provisionalFindingId,
        )
      ));
      return {
        rawFindingId,
        outcome: ordered.every((failure) => failure.outcome === 'stale')
          ? 'stale' as const
          : 'audit_only' as const,
        reason: ordered.map((failure) => (
          `[${failure.recoveryOrigin.provisionalFindingId}] ${failure.reason}`
        )).join('; '),
      };
    });
}

function buildInterpretationRecoverySettlements(input: {
  failures: readonly InterpretationRecoveryCommitFailure[];
  intake: ReviewerIntakeResult;
  recoveryLedger: FindingLedger;
  finalizedLedger: FindingLedger;
  ladderCommit: ReturnType<typeof buildLadderCommitPlan>;
}): InterpretationRecoveryOriginSettlement[] {
  const settlements = new Map<string, InterpretationRecoveryOriginSettlement>();
  for (const failure of input.failures) {
    const settlement: InterpretationRecoveryOriginSettlement = failure.outcome === 'stale'
      ? {
          provisionalFindingId: failure.recoveryOrigin.provisionalFindingId,
          sourceRawFindingId: failure.sourceRawFindingId,
          outcome: 'stale',
          reason: failure.reason,
        }
      : {
          provisionalFindingId: failure.recoveryOrigin.provisionalFindingId,
          sourceRawFindingId: failure.sourceRawFindingId,
          outcome: 'audit_only',
          failureKind: failure.kind,
          reason: failure.reason,
        };
    settlements.set(settlement.provisionalFindingId, settlement);
  }
  for (const item of input.intake.items) {
    for (const origin of item.recoveryOrigins ?? []) {
      if (settlements.has(origin.provisionalFindingId)) {
        continue;
      }
      const sourceRawFindingId = item.wire.rawFindingId;
      const originFinding = input.recoveryLedger.findings.find(
        (finding) => finding.id === origin.provisionalFindingId,
      );
      if (originFinding === undefined
        || !matchesProvisionalRecoveryOrigin(originFinding, origin)) {
        settlements.set(origin.provisionalFindingId, {
          provisionalFindingId: origin.provisionalFindingId,
          sourceRawFindingId,
          outcome: 'stale',
          reason: 'The recovery origin changed before the shared raw payload was committed',
        });
        continue;
      }
      const targetFindingId = input.ladderCommit.recoverySettlements.get(
        origin.provisionalFindingId,
      ) ?? (input.ladderCommit.recoveryPromotions.has(origin.provisionalFindingId)
        ? origin.provisionalFindingId
        : undefined);
      if (targetFindingId !== undefined) {
        settlements.set(origin.provisionalFindingId, {
          provisionalFindingId: origin.provisionalFindingId,
          sourceRawFindingId,
          outcome: 'settled',
          targetFindingId,
        });
        continue;
      }
      const finalizedFinding = input.finalizedLedger.findings.find(
        (finding) => finding.id === origin.provisionalFindingId,
      );
      settlements.set(origin.provisionalFindingId, finalizedFinding?.provisional === undefined
        ? {
            provisionalFindingId: origin.provisionalFindingId,
            sourceRawFindingId,
            outcome: 'settled',
            targetFindingId: origin.provisionalFindingId,
          }
        : {
            provisionalFindingId: origin.provisionalFindingId,
            sourceRawFindingId,
            outcome: 'retained',
          });
    }
  }
  return [...settlements.values()].sort((left, right) => (
    compareBinaryStrings(left.provisionalFindingId, right.provisionalFindingId)
  ));
}

function containsIsolatedRawFinding(
  sourceRawFindingIds: readonly string[],
  isolatedRawFindingIds: ReadonlySet<string>,
): boolean {
  return sourceRawFindingIds.some((rawFindingId) => isolatedRawFindingIds.has(rawFindingId));
}

function isolateManagerOutput(
  output: FindingManagerOutput,
  isolatedRawFindingIds: ReadonlySet<string>,
): FindingManagerOutput {
  const retain = <T extends { rawFindingIds: string[] }>(entries: readonly T[]): T[] => (
    entries.filter((entry) => !containsIsolatedRawFinding(entry.rawFindingIds, isolatedRawFindingIds))
  );
  return {
    ...output,
    matches: retain(output.matches),
    newFindings: retain(output.newFindings),
    resolvedFindings: retain(output.resolvedFindings),
    reopenedFindings: retain(output.reopenedFindings),
    conflicts: retain(output.conflicts),
  };
}

interface ManagerEntryIsolationPlan {
  droppedRawFindingIds: Set<string>;
  provisionalSpecs: ProvisionalFindingSpec[];
}

function planManagerEntryIsolation(
  output: FindingManagerOutput,
  staleRecoveryRawFindingIds: ReadonlySet<string>,
  intake: ReviewerIntakeResult,
): ManagerEntryIsolationPlan {
  const entries = [
    ...output.matches,
    ...output.newFindings,
    ...output.resolvedFindings,
    ...output.reopenedFindings,
    ...output.conflicts,
  ];
  const droppedRawFindingIds = new Set(entries
    .filter((entry) => containsIsolatedRawFinding(
      entry.rawFindingIds,
      staleRecoveryRawFindingIds,
    ))
    .flatMap((entry) => entry.rawFindingIds));
  const intakeByRawFindingId = new Map(
    intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const provisionalSpecs = [...droppedRawFindingIds].flatMap((rawFindingId) => {
    if (staleRecoveryRawFindingIds.has(rawFindingId)) {
      return [];
    }
    const item = intakeByRawFindingId.get(rawFindingId);
    if (item === undefined) {
      throw new Error(
        `Raw finding "${rawFindingId}" from a dropped mixed manager entry is missing from manager intake`,
      );
    }
    return [provisionalSpecForRawKind({
      wire: item.wire,
      canonical: item.canonical,
      reason: 'The mixed manager entry also referenced a stale recovery raw, so the complete entry was discarded atomically and this fresh observation was isolated for adjudication',
    }, 'raw-adjudication-unresolved')];
  });
  return { droppedRawFindingIds, provisionalSpecs };
}

function prepareCommitReconciliation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
  ladder: ManagerDecisionStageResult['ladder'],
  isolatedRawFindingIds: ReadonlySet<string>,
) {
  const evaluatedAdmission = retainInterpretationRecoveryForLadder(evaluateRawAdmission({
    cwd: params.input.cwd,
    reviewScopeSnapshotId: params.reviewScopeSnapshotId,
    runId: params.input.ledgerStore.runId,
    scopeIdentity: params.input.ledgerStore.ledgerIdentity,
    previousLedger: freshLedger,
    intake: params.intake,
  }), params.intake);
  const retainItem = (item: { wire: { rawFindingId: string } }): boolean => (
    !isolatedRawFindingIds.has(item.wire.rawFindingId)
  );
  const retainSpec = (spec: { sourceRawFindingIds: readonly string[] }): boolean => (
    !containsIsolatedRawFinding(spec.sourceRawFindingIds, isolatedRawFindingIds)
  );
  const admission: RawAdmissionEvaluation = {
    admissionRejections: evaluatedAdmission.admissionRejections.filter(
      (rejection) => !isolatedRawFindingIds.has(rejection.rawFindingId),
    ),
    admissionAnomalySpecs: evaluatedAdmission.admissionAnomalySpecs.filter(retainSpec),
    admissionProvisionalSpecs: evaluatedAdmission.admissionProvisionalSpecs.filter(retainSpec),
    admissionRejectedItems: evaluatedAdmission.admissionRejectedItems.filter(retainItem),
    pendingRejectedObservations: evaluatedAdmission.pendingRejectedObservations.filter(
      ({ item }) => retainItem(item),
    ),
    cleanAdmitted: evaluatedAdmission.cleanAdmitted.filter(retainItem),
    tainted: evaluatedAdmission.tainted.filter(retainItem),
    taintedAdmitted: evaluatedAdmission.taintedAdmitted.filter(retainItem),
    ladderAnomalySpecs: evaluatedAdmission.ladderAnomalySpecs.filter(retainSpec),
    verifiedEvidenceCandidates: evaluatedAdmission.verifiedEvidenceCandidates.filter(
      (candidate) => !isolatedRawFindingIds.has(candidate.rawFindingId),
    ),
    provisionalOnlyLadderRawIds: new Set(
      [...evaluatedAdmission.provisionalOnlyLadderRawIds].filter(
        (rawFindingId) => !isolatedRawFindingIds.has(rawFindingId),
      ),
    ),
    cleanWire: evaluatedAdmission.cleanWire.filter(
      (wire) => !isolatedRawFindingIds.has(wire.rawFindingId),
    ),
    verifiedEvidenceRecordsByRawFindingId: new Map(
      [...evaluatedAdmission.verifiedEvidenceRecordsByRawFindingId].filter(
        ([rawFindingId]) => !isolatedRawFindingIds.has(rawFindingId),
      ),
    ),
  };
  const freshAdmittedItems = [...admission.cleanAdmitted, ...admission.taintedAdmitted];
  const freshAdmittedRawIds = new Set(freshAdmittedItems.map((item) => item.wire.rawFindingId));
  const reconcileRawFindings = [
    ...admission.cleanWire,
    ...admission.admissionRejectedItems.map((item) => item.wire),
    ...admission.taintedAdmitted
      .map((item) => item.wire),
    ...params.intake.items
      .filter((item) => (
        params.intake.overflowRawFindingIds.has(item.canonical.rawFindingId)
        && !isolatedRawFindingIds.has(item.canonical.rawFindingId)
      ))
      .map((item) => item.wire),
  ];
  const rawProvenanceByRawFindingId = new Map<string, CanonicalRawReconcileProvenance>(
    params.intake.items.flatMap((item) => (
      isolatedRawFindingIds.has(item.canonical.rawFindingId)
        ? []
        : [[item.canonical.rawFindingId, {
            reviewerStableKey: item.canonical.reviewerStableKey,
            lineageKey: item.canonical.lineageKey,
            claimIdentityHash: item.canonical.claimIdentityHash,
            canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
            canonicalProvenance: item.canonical.provenance,
          }] as const]
    )),
  );
  const baseSpecs: ProvisionalFindingSpec[] = [
    ...params.intake.overflowSpecs.filter(retainSpec),
    ...admission.admissionProvisionalSpecs.filter(retainSpec),
    ...params.managerDecision.cleanProvisionalSpecs.filter((spec) => (
      retainSpec(spec)
      && spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
    ...ladder.provisionalSpecs.filter((spec) => (
      retainSpec(spec)
      && spec.sourceRawFindingIds.every((rawFindingId) => freshAdmittedRawIds.has(rawFindingId))
    )),
  ];
  return {
    admission,
    reconcileRawFindings,
    rawProvenanceByRawFindingId,
    baseSpecs,
    cleanWireById: new Map(
      admission.cleanAdmitted.map((item) => [item.wire.rawFindingId, item.wire]),
    ),
    cleanCanonicalById: new Map(
      admission.cleanAdmitted.map((item) => [item.canonical.rawFindingId, item.canonical]),
    ),
    capturedPreconditions: captureFindingPreconditions(params.previousLedger),
    anomalySpecs: [...admission.admissionAnomalySpecs, ...admission.ladderAnomalySpecs],
  };
}

export function buildFindingManagerCommitMutation(
  params: FindingManagerCommitPlanInput,
  freshLedger: FindingLedger,
): FindingLedgerMutation<CommitMutationResult> {
  if (freshLedger.stopBudget?.roundMarkers.includes(params.stopBudgetRoundMarker) === true) {
    return {
      ledger: freshLedger,
      result: {
        applied: false,
        staleRejections: [],
        admissionRejections: [],
        provisionalLandings: [],
        reviewerAnomalyLandings: [],
        rawFindingDispositions: [],
        interpretationRecoverySettlements: [],
      },
    };
  }
  const interpretationRecoveryFailures = resolveInterpretationRecoveryFailuresForCommit(
    freshLedger,
    params.interpretationRecoveryFailures,
  );
  const interpretationRecoveryLedger = applyInterpretationRecoveryFailures({
    ledger: freshLedger,
    failures: interpretationRecoveryFailures,
    observation: params.observation,
  });
  const rawAdjudicationRecovery = applyRawAdjudicationRecovery({
    freshLedger: interpretationRecoveryLedger,
    recovery: params.managerDecision.rawRecovery,
    runInput: params.input,
    observation: params.observation,
    reviewScopeSnapshotId: params.reviewScopeSnapshotId,
  });
  const recoveryLedger = rawAdjudicationRecovery.ledger;
  const ladder = selectCommittableLadder(params.managerDecision.ladder, recoveryLedger);
  const staleRecoveryRawFindingIds = collectStaleRecoveryRawFindingIds(
    params.intake.items,
    recoveryLedger,
  );
  const ladderCommit = buildLadderCommitPlan(
    ladder,
    recoveryLedger,
    staleRecoveryRawFindingIds,
  );
  const managerEntryIsolation = planManagerEntryIsolation(
    params.managerDecision.managerOutput,
    ladderCommit.staleRecoveryRawFindingIds,
    params.intake,
  );
  const prepared = prepareCommitReconciliation(
    params,
    recoveryLedger,
    ladder,
    ladderCommit.staleRecoveryRawFindingIds,
  );
  const roundsCompleted = stopBudgetRoundsCompleted(freshLedger);
  const actionRecoveryCandidates = collectManagerActionRecoveryCandidates(
    recoveryLedger,
    roundsCompleted,
  );
  const { input, managerDecision } = params;
  const { managerOutput } = managerDecision;
  const { admission } = prepared;

  const revalidated = revalidateManagerPlan({
    managerOutput: isolateManagerOutput(
      managerOutput,
      managerEntryIsolation.droppedRawFindingIds,
    ),
    freshLedger: recoveryLedger,
    cleanWire: admission.cleanWire,
    cleanWireById: prepared.cleanWireById,
    cleanCanonicalById: prepared.cleanCanonicalById,
    capturedPreconditions: prepared.capturedPreconditions,
    runInput: input,
  });
  const staleRejections = revalidated.staleRejections;
  const output = revalidated.output;

  const specs = [
    ...prepared.baseSpecs,
    ...revalidated.provisionalSpecs,
    ...ladderCommit.provisionalSpecs,
    ...managerEntryIsolation.provisionalSpecs,
  ].filter((spec) => !containsIsolatedRawFinding(
    spec.sourceRawFindingIds,
    ladderCommit.staleRecoveryRawFindingIds,
  ));
  const interpretationResults = ladderCommit.interpretationResults;
  const merged = isolateManagerOutput(
    mergeOutputs(output, ladderCommit.output),
    managerEntryIsolation.droppedRawFindingIds,
  );
  const rawProvenanceByRawFindingId = new Map(
    [...prepared.rawProvenanceByRawFindingId].map(([rawFindingId, provenance]) => {
      const authority = ladderCommit.openConflictOutcomeAuthorities.get(rawFindingId);
      return [
        rawFindingId,
        authority === undefined
          ? provenance
          : { ...provenance, openConflictOutcomeAuthority: authority },
      ] as const;
    }),
  );
  const reconcilePlan = reconcileCommitPlan({
    runInput: input,
    freshLedger: recoveryLedger,
    rawFindings: prepared.reconcileRawFindings,
    managerOutput: merged,
    provisionalSpecs: specs,
    anomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    rawProvenanceByRawFindingId,
    cleanWire: admission.cleanWire,
    explicitResolvedByMapping: ladderCommit.recoverySettlements,
    explicitPromotedFindingIds: ladderCommit.recoveryPromotions,
    recoveryProvisionalRawFindingIds: new Set(
      [...ladderCommit.recoveryProvisionalRawFindingIds].filter(
        (rawFindingId) => !ladderCommit.staleRecoveryRawFindingIds.has(rawFindingId),
      ),
    ),
    staleRawFindingIds: ladderCommit.staleRecoveryRawFindingIds,
    deferredRawFindingIds: ladder.deferredRawFindingIds,
    resolutionRenotifications: revalidated.resolutionRenotifications,
    unsupportedRawFindingReports: managerDecision.unsupportedRawFindingReports,
    healthyReviewerStableKeys: params.intake.healthyReviewerStableKeys,
    verifiedEvidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
  });
  const settled = applyManagerActionRecovery({
    ledger: reconcilePlan.ledger,
    candidates: actionRecoveryCandidates,
    cwd: input.cwd,
    context: {
      workflowName: input.workflowName,
      stepName: input.parentStep.name,
      runId: input.runId,
      timestamp: input.timestamp,
    },
    observation: params.observation,
  });
  // 監査レポートには実際に着地した spec だけを載せる（dismiss と同一ラウンドで
  // 抑止された同一 claim の spec は着地していない — reconcileCommitPlan 参照）。
  const provisionalLandings = reconcilePlan.landedSpecs.map((spec): ProvisionalLandingReport => ({
    kind: spec.kind,
    stableKey: spec.stableKey,
    reason: spec.reason,
    sourceRawFindingIds: spec.sourceRawFindingIds,
  }));

  const finalized = applyCommitLedgerStates({
    runInput: input,
    freshLedger,
    settledLedger: settled,
    baseAnomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    interpretationResults,
    interpretationReservations: ladder.interpretationReservations,
    interpretationIntegrityDigests: ladder.interpretationIntegrityDigests,
    observation: params.observation,
    verifiedEvidenceCandidates: admission.verifiedEvidenceCandidates,
    stopBudgetLimits: params.stopBudgetLimits,
    stopBudgetRoundMarker: params.stopBudgetRoundMarker,
    reviewIntegrityLimits: params.reviewIntegrityLimits,
  });
  const rawFindingDispositions = [
    ...interpretationRecoveryDispositions(interpretationRecoveryFailures).filter(
      (disposition) => !params.intake.items.some(
        (item) => item.wire.rawFindingId === disposition.rawFindingId,
      ),
    ),
    ...rawAdjudicationRecovery.rawFindingDispositions,
    ...reconcilePlan.rawFindingDispositions,
  ].sort((left, right) => (
    compareBinaryStrings(left.rawFindingId, right.rawFindingId)
    || compareCanonicalJsonValues(left, right)
  ));
  if (new Set(rawFindingDispositions.map(
    (disposition) => disposition.rawFindingId,
  )).size !== rawFindingDispositions.length) {
    throw new Error('A raw finding received multiple finite dispositions across recovery and commit');
  }
  const interpretationRecoverySettlements = buildInterpretationRecoverySettlements({
    failures: interpretationRecoveryFailures,
    intake: params.intake,
    recoveryLedger,
    finalizedLedger: finalized.ledger,
    ladderCommit,
  });
  return {
    ledger: finalized.ledger,
    result: {
      applied: true,
      staleRejections: [...staleRejections, ...reconcilePlan.normalizationRejections],
      admissionRejections: admission.admissionRejections,
      provisionalLandings,
      reviewerAnomalyLandings: finalized.reviewerAnomalyLandings,
      rawFindingDispositions,
      interpretationRecoverySettlements,
    },
  };
}
