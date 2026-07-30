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
  UnsupportedRawFindingReport,
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
import {
  applyCommitLedgerStates,
  reconcileCommitPlan,
  type RejectedObservationAttachment,
} from './manager-commit-finalization.js';
import {
  collectManagerActionRecoveryCandidates,
  planManagerActionRecovery,
  type ManagerActionRecoveryLifecyclePlan,
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
import type { ResolutionRenotificationTransition } from './resolution-renotification.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import {
  captureReviewScopeSnapshot,
  type ReviewScopeProofSnapshot,
} from './snapshot.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';

export function attachCapturedConflictHeads(input: {
  commands: readonly FindingLifecycleCommand[];
  resolvedConflictIds: ReadonlySet<string>;
  capturedConflictHeads: ManagerDecisionStageResult['conflictTargetHeads'];
  cwd: string;
}): FindingLifecycleCommand[] {
  return input.commands.map((command) => {
    const expectedHeadsByTarget = new Map(command.expectedHeadsByTarget);
    let conflictEvidencePrecondition = command.conflictEvidencePrecondition;
    for (const conflict of command.changes.conflicts) {
      if (
        input.resolvedConflictIds.has(conflict.id)
        && input.capturedConflictHeads.has(conflict.id)
      ) {
        const captured = input.capturedConflictHeads.get(conflict.id)!;
        expectedHeadsByTarget.set(
          `conflict\0${conflict.id}`,
          captured.lifecycleHead,
        );
        conflictEvidencePrecondition = {
          conflictId: conflict.id,
          evidenceSetHash: captured.evidenceSetHash,
          cwd: input.cwd,
        };
      }
    }
    return expectedHeadsByTarget.size === 0
      && conflictEvidencePrecondition === undefined
      ? command
      : {
          ...command,
          expectedHeadsByTarget,
          ...(conflictEvidencePrecondition === undefined
            ? {}
            : { conflictEvidencePrecondition }),
        };
  });
}

export interface CommitMutationResult {
  applied: boolean;
  rawRecoveryManagerDecisionLedger: FindingLedger;
  rawRecoveryManagerDecisionCommands: FindingLifecycleCommand[];
  rawRecoveryLedger: FindingLedger;
  rawRecoverySettlementCommands: FindingLifecycleCommand[];
  managerDecisionLedger: FindingLedger;
  managerDecisionCommands: FindingLifecycleCommand[];
  lifecycleManagerOutput: FindingManagerOutput;
  staleRejections: string[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  admissionRejections: RawAdmissionEvaluation['admissionRejections'];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rawFindingDispositions: RawFindingDisposition[];
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
  resolutionRenotifications: ResolutionRenotificationTransition[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  settlementCommands: FindingLifecycleCommand[];
  actionRecoveryPlan: ManagerActionRecoveryLifecyclePlan | null;
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
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
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

function prospectiveStaleConflictResolutions(input: {
  recoveryLedger: FindingLedger;
  prospectiveLedger: FindingLedger;
  resolvedConflicts: FindingManagerOutput['resolvedConflicts'];
  capturedConflictHeads: ManagerDecisionStageResult['conflictTargetHeads'];
  reviewScopeSnapshotId: string;
}): Set<string> {
  const stale = new Set<string>();
  for (const resolved of input.resolvedConflicts) {
    const captured = input.capturedConflictHeads.get(resolved.conflictId);
    const originalConflict = input.recoveryLedger.conflicts.find(
      (conflict) => conflict.id === resolved.conflictId,
    );
    if (captured === undefined || originalConflict === undefined) {
      continue;
    }
    const dependencyLedger: FindingLedger = {
      ...input.prospectiveLedger,
      conflicts: input.prospectiveLedger.conflicts.map((conflict) => (
        conflict.id === resolved.conflictId ? originalConflict : conflict
      )),
    };
    const prospectiveHash = computeConflictEvidenceHash(
      originalConflict,
      dependencyLedger,
      input.reviewScopeSnapshotId,
    );
    if (
      captured.reviewScopeSnapshotId !== input.reviewScopeSnapshotId
      || captured.evidenceSetHash !== prospectiveHash
    ) {
      stale.add(resolved.conflictId);
    }
  }
  return stale;
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
    reviewScopeSnapshot: params.reviewScopeSnapshot,
    workflowTask: params.input.workflowTask,
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
    preAdmissionEntityMutations: evaluatedAdmission.preAdmissionEntityMutations.filter(
      (mutation) => retainSpec(mutation),
    ),
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
    ...params.intake.intakeProvisionalSpecs.filter(retainSpec),
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
    anomalySpecs: [
      ...params.intake.intakeAnomalySpecs,
      ...admission.admissionAnomalySpecs,
      ...admission.ladderAnomalySpecs,
    ],
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
        rawRecoveryManagerDecisionLedger: freshLedger,
        rawRecoveryManagerDecisionCommands: [],
        rawRecoveryLedger: freshLedger,
        rawRecoverySettlementCommands: [],
        managerDecisionLedger: freshLedger,
        managerDecisionCommands: [],
        lifecycleManagerOutput: params.managerDecision.managerOutput,
        staleRejections: [],
        unsupportedRawFindingReports: [],
        admissionRejections: [],
        provisionalLandings: [],
        reviewerAnomalyLandings: [],
        rawFindingDispositions: [],
        interpretationRecoverySettlements: [],
        resolutionRenotifications: [],
        rejectedObservationAttachments: [],
        settlementCommands: [],
        actionRecoveryPlan: null,
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
    reviewScopeSnapshot: params.reviewScopeSnapshot,
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
  const isolatedManagerOutput = isolateManagerOutput(
    managerOutput,
    managerEntryIsolation.droppedRawFindingIds,
  );
  const freshReviewScopeSnapshotId = isolatedManagerOutput.resolvedConflicts.length === 0
    ? params.reviewScopeSnapshotId
    : captureReviewScopeSnapshot(input.cwd).reviewScopeSnapshotId;

  const revalidated = revalidateManagerPlan({
    managerOutput: isolatedManagerOutput,
    freshLedger: recoveryLedger,
    cleanWire: admission.cleanWire,
    cleanWireById: prepared.cleanWireById,
    cleanCanonicalById: prepared.cleanCanonicalById,
    capturedPreconditions: prepared.capturedPreconditions,
    capturedConflictHeads: managerDecision.conflictTargetHeads,
    reviewScopeSnapshotId: freshReviewScopeSnapshotId,
    runInput: input,
  });
  const staleRejections = [...revalidated.staleRejections];
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
  let merged = isolateManagerOutput(
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
  const reconcileInput = {
    runInput: input,
    freshLedger: recoveryLedger,
    rawFindings: prepared.reconcileRawFindings,
    managerOutput: merged,
    provisionalSpecs: specs,
    entityProvisionalMutations: admission.preAdmissionEntityMutations,
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
    unsupportedRawFindingReports: [
      ...managerDecision.unsupportedRawFindingReports,
      ...revalidated.unsupportedRawFindingReports,
    ],
    healthyReviewerStableKeys: params.intake.healthyReviewerStableKeys,
    verifiedEvidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
  };
  let reconcilePlan = reconcileCommitPlan(reconcileInput);
  const buildActionRecoveryPlan = (
    ledger: FindingLedger,
  ): ManagerActionRecoveryLifecyclePlan => planManagerActionRecovery({
    ledger,
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
  let actionRecoveryPlan = buildActionRecoveryPlan(reconcilePlan.ledger);
  const prospectiveStaleConflictIds = prospectiveStaleConflictResolutions({
    recoveryLedger,
    prospectiveLedger: actionRecoveryPlan.ledger,
    resolvedConflicts: merged.resolvedConflicts,
    capturedConflictHeads: managerDecision.conflictTargetHeads,
    reviewScopeSnapshotId: freshReviewScopeSnapshotId,
  });
  if (prospectiveStaleConflictIds.size > 0) {
    merged = {
      ...merged,
      resolvedConflicts: merged.resolvedConflicts.filter(
        (resolved) => !prospectiveStaleConflictIds.has(resolved.conflictId),
      ),
    };
    staleRejections.push(...[...prospectiveStaleConflictIds]
      .sort(compareBinaryStrings)
      .map((conflictId) => (
        `conflictDecisions: conflict "${conflictId}" (resolve) rejected at commit: the same plan changes its adjudication evidence dependencies`
      )));
    reconcilePlan = reconcileCommitPlan({
      ...reconcileInput,
      managerOutput: merged,
    });
    actionRecoveryPlan = buildActionRecoveryPlan(reconcilePlan.ledger);
  }
  // 監査レポートには実際に着地した spec だけを載せる（dismiss と同一ラウンドで
  // 抑止された同一 claim の spec は着地していない — reconcileCommitPlan 参照）。
  const provisionalLandings = [
    ...reconcilePlan.landedSpecs.map((spec): ProvisionalLandingReport => ({
      kind: spec.kind,
      stableKey: spec.stableKey,
      reason: spec.reason,
      sourceRawFindingIds: spec.sourceRawFindingIds,
    })),
    ...reconcilePlan.entityMutationResults.flatMap((result): ProvisionalLandingReport[] => {
      if (result.outcome === 'terminal_audit') {
        return [];
      }
      const finding = reconcilePlan.ledger.findings.find(
        (entry) => entry.id === result.findingId,
      );
      return finding?.status === 'open' && finding.provisional !== undefined
        ? [{
            kind: finding.provisional.kind,
            stableKey: finding.provisional.stableKey,
            reason: result.mutation.reason,
            sourceRawFindingIds: result.mutation.sourceRawFindingIds,
          }]
        : [];
    }),
  ];

  const finalized = applyCommitLedgerStates({
    runInput: input,
    freshLedger,
    settledLedger: actionRecoveryPlan.ledger,
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
      rawRecoveryManagerDecisionLedger: rawAdjudicationRecovery.managerDecisionLedger,
      rawRecoveryManagerDecisionCommands: rawAdjudicationRecovery.managerDecisionCommands,
      rawRecoveryLedger: rawAdjudicationRecovery.ledger,
      rawRecoverySettlementCommands: rawAdjudicationRecovery.settlementCommands,
      managerDecisionLedger: reconcilePlan.managerDecisionLedger,
      managerDecisionCommands: attachCapturedConflictHeads({
        commands: reconcilePlan.managerDecisionCommands,
        resolvedConflictIds: new Set(
          reconcilePlan.managerOutput.resolvedConflicts.map(
            (conflict) => conflict.conflictId,
          ),
        ),
        capturedConflictHeads: managerDecision.conflictTargetHeads,
        cwd: input.cwd,
      }),
      lifecycleManagerOutput: reconcilePlan.managerOutput,
      staleRejections: [...staleRejections, ...reconcilePlan.normalizationRejections],
      unsupportedRawFindingReports: revalidated.unsupportedRawFindingReports,
      admissionRejections: admission.admissionRejections,
      provisionalLandings,
      reviewerAnomalyLandings: finalized.reviewerAnomalyLandings,
      rawFindingDispositions,
      interpretationRecoverySettlements,
      resolutionRenotifications: revalidated.resolutionRenotifications,
      rejectedObservationAttachments: [
        ...reconcilePlan.rejectedObservationAttachments,
        ...finalized.rejectedObservationAttachments,
      ],
      settlementCommands: reconcilePlan.settlementCommands,
      actionRecoveryPlan,
    },
  };
}
