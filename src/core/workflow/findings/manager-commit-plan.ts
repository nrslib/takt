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
} from './types.js';
import { evaluateRawAdmission, type RawAdmissionEvaluation, type ReviewerIntakeResult } from './manager-admission.js';
import { provisionalSpecForRawKind } from './manager-provisional.js';
import type { ManagerDecisionStageResult, RunFindingManagerForStepInput } from './manager-contracts.js';

import { mergeOutputs, revalidateManagerPlan } from './manager-commit-revalidation.js';
import {
  applyCommitLedgerStates,
  reconcileCommitPlan,
} from './manager-commit-finalization.js';
import type { RejectedObservationAttachment } from './manager-provisional-settlement.js';
import {
  collectManagerActionRecoveryCandidates,
  planManagerActionRecovery,
  type ManagerActionRecoveryLifecyclePlan,
} from './manager-action-recovery.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import type { ResolutionRenotificationTransition } from './resolution-renotification.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import {
  captureReviewScopeSnapshot,
  type ReviewScopeProofSnapshot,
} from './snapshot.js';
import { computeConflictEvidenceHash } from './adjudication-evidence.js';
import {
  prepareInterpretationCaseActions,
  stagePreparedInterpretationCaseOwnership,
  type PreparedInterpretationCasePlan,
} from './interpretation-case-finalizer.js';
import { issueInterpretationCaseConflictAuthority } from './interpretation-case-authority.js';
import { createAnchorAdjudication } from '../../models/finding-anchor-relevance.js';
import { createEmptyManagerOutput } from './manager-output.js';

export function attachCapturedConflictHeads(input: {
  commands: readonly FindingLifecycleCommand[];
  resolvedConflictIds: ReadonlySet<string>;
  capturedConflictHeads: ManagerDecisionStageResult['conflictTargetHeads'];
  cwd: string;
}): FindingLifecycleCommand[] {
  return input.commands.map((command) => {
    const expectedHeadsByTarget = new Map(command.expectedHeadsByTarget);
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
      }
    }
    return expectedHeadsByTarget.size === 0
      ? command
      : {
          ...command,
          expectedHeadsByTarget,
        };
  });
}

function attachInterpretationCaseOrigins(
  commands: readonly FindingLifecycleCommand[],
  prepared: PreparedInterpretationCasePlan,
): FindingLifecycleCommand[] {
  const caseIdsByRawFindingId = new Map<string, string>();
  for (const preparedCase of prepared.cases) {
    for (const rawFindingId of preparedCase.rawFindingIds) {
      if (caseIdsByRawFindingId.has(rawFindingId)) {
        throw new Error(`Interpretation raw finding "${rawFindingId}" has multiple case owners`);
      }
      caseIdsByRawFindingId.set(rawFindingId, preparedCase.caseId);
    }
  }
  return commands.map((command) => ({
    ...command,
    interpretationCaseIdsByRawFindingId: caseIdsByRawFindingId,
  }));
}

export interface CommitMutationResult {
  applied: boolean;
  managerDecisionLedger: FindingLedger;
  managerDecisionCommands: FindingLifecycleCommand[];
  lifecycleManagerOutput: FindingManagerOutput;
  staleRejections: string[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  admissionRejections: RawAdmissionEvaluation['admissionRejections'];
  provisionalLandings: ProvisionalLandingReport[];
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[];
  resolutionRenotifications: ResolutionRenotificationTransition[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  settlementCommands: FindingLifecycleCommand[];
  actionRecoveryPlan: ManagerActionRecoveryLifecyclePlan | null;
  interpretationPrepared: PreparedInterpretationCasePlan;
}

export interface FindingManagerCommitPlanInput {
  input: RunFindingManagerForStepInput;
  previousLedger: FindingLedger;
  intake: ReviewerIntakeResult;
  admission: RawAdmissionEvaluation;
  managerDecision: ManagerDecisionStageResult;
  observation: FindingObservation;
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}

function containsIsolatedRawFinding(
  sourceRawFindingIds: readonly string[],
  isolatedRawFindingIds: ReadonlySet<string>,
): boolean {
  return sourceRawFindingIds.some((rawFindingId) => isolatedRawFindingIds.has(rawFindingId));
}

function isolateManagerOutputForCommit(
  output: FindingManagerOutput,
  isolatedRawFindingIds: ReadonlySet<string>,
): FindingManagerOutput {
  const retain = <T extends { rawFindingIds: string[] }>(entries: readonly T[]): T[] => (
    entries.filter((entry) => !containsIsolatedRawFinding(entry.rawFindingIds, isolatedRawFindingIds))
  );
  const matches = retain(output.matches);
  const newFindings = retain(output.newFindings);
  const resolvedFindings = retain(output.resolvedFindings);
  const reopenedFindings = retain(output.reopenedFindings);
  const conflicts = retain(output.conflicts);
  const landedRawFindingIds = new Set([
    ...matches.flatMap((entry) => entry.rawFindingIds),
    ...newFindings.flatMap((entry) => entry.rawFindingIds),
    ...resolvedFindings.flatMap((entry) => entry.rawFindingIds),
    ...reopenedFindings.flatMap((entry) => entry.rawFindingIds),
    ...conflicts.flatMap((entry) => entry.rawFindingIds),
  ]);
  return {
    ...output,
    anchorAdjudications: output.anchorAdjudications.filter(
      (adjudication) => landedRawFindingIds.has(adjudication.rawFindingId),
    ),
    matches,
    newFindings,
    resolvedFindings,
    reopenedFindings,
    conflicts,
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
  interpretationPrepared: PreparedInterpretationCasePlan,
  isolatedRawFindingIds: ReadonlySet<string>,
) {
  const evaluatedAdmission = evaluateRawAdmission({
    cwd: params.input.cwd,
    reviewScopeSnapshotId: params.reviewScopeSnapshotId,
    runId: params.input.ledgerStore.runId,
    scopeIdentity: params.input.ledgerStore.ledgerIdentity,
    previousLedger: freshLedger,
    intake: params.intake,
    reviewScopeSnapshot: params.reviewScopeSnapshot,
    workflowTask: params.input.workflowTask,
  });
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
  const pendingRejectedRawFindingIds = new Set(
    admission.pendingRejectedObservations.map(({ item }) => item.wire.rawFindingId),
  );
  const reconcileRawFindings = [
    ...admission.cleanWire,
    ...admission.admissionRejectedItems
      .filter((item) => !pendingRejectedRawFindingIds.has(item.wire.rawFindingId))
      .map((item) => item.wire),
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
    ...interpretationPrepared.provisionalFindings.filter((spec) => (
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
    invalidInterpretationRawFindingIds: new Set([
      ...admission.admissionAnomalySpecs,
      ...admission.ladderAnomalySpecs,
    ].flatMap((spec) => spec.sourceRawFindingIds)),
  };
}

function interpretationManagerOutput(
  prepared: PreparedInterpretationCasePlan,
  items: readonly ReviewerIntakeResult['items'][number][],
): FindingManagerOutput {
  const rawFindingsById = new Map(items.map((item) => [item.wire.rawFindingId, item.wire]));
  const adjudicate = (input: {
    rawFindingId: string;
    decision: 'same' | 'new' | 'conflict';
    findingId?: string;
    evidence: string;
  }) => {
    const rawFinding = rawFindingsById.get(input.rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Interpretation output is missing raw finding "${input.rawFindingId}"`);
    }
    if (rawFinding.target.kind === 'absence') {
      throw new Error(
        `Absence raw finding "${input.rawFindingId}" cannot land without explicit anchor relevance`,
      );
    }
    return createAnchorAdjudication({
      rawFindingId: input.rawFindingId,
      decision: input.decision,
      anchorRelevance: 'not_applicable',
      ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
      evidence: input.evidence,
    });
  };
  return {
    ...prepared.managerOutput,
    anchorAdjudications: [
      ...prepared.managerOutput.matches.flatMap((match) => (
        match.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'same',
          findingId: match.findingId,
          evidence: match.evidence ?? 'Engine-issued interpretation-case SameProof.',
        }))
      )),
      ...prepared.managerOutput.newFindings.flatMap((finding) => (
        finding.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'new',
          evidence: 'Interpretation case created one independent product finding.',
        }))
      )),
      ...prepared.managerOutput.conflicts.flatMap((conflict) => {
        const findingId = conflict.findingIds[0];
        if (findingId === undefined || conflict.findingIds.length !== 1) {
          throw new Error('Interpretation case conflict must reference exactly one product finding');
        }
        return conflict.rawFindingIds.map((rawFindingId) => adjudicate({
          rawFindingId,
          decision: 'conflict',
          findingId,
          evidence: conflict.description,
        }));
      }),
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
        managerDecisionLedger: freshLedger,
        managerDecisionCommands: [],
        lifecycleManagerOutput: params.managerDecision.managerOutput,
        staleRejections: [],
        unsupportedRawFindingReports: [],
        admissionRejections: [],
        provisionalLandings: [],
        reviewerAnomalyLandings: [],
        interpretationRecoverySettlements: [],
        resolutionRenotifications: [],
        rejectedObservationAttachments: [],
        settlementCommands: [],
        actionRecoveryPlan: null,
        interpretationPrepared: {
          cases: [],
          managerOutput: createEmptyManagerOutput(),
          provisionalFindings: [],
        },
      },
    };
  }
  const recoveryLedger = freshLedger;
  let interpretationPrepared = prepareInterpretationCaseActions({
    ledger: recoveryLedger,
    items: params.managerDecision.interpretation.items,
    completedAttemptIds:
      params.managerDecision.interpretation.completedAttemptIdsForCommit,
    directPlans: params.managerDecision.interpretation.directPlans,
    proofFastPathPlans: params.managerDecision.interpretation.proofFastPathPlans,
    provisionalOnlyRawFindingIds:
      params.managerDecision.interpretation.provisionalOnlyRawFindingIds,
  });
  const staleRecoveryRawFindingIds = new Set<string>();
  const managerEntryIsolation = planManagerEntryIsolation(
    params.managerDecision.managerOutput,
    staleRecoveryRawFindingIds,
    params.intake,
  );
  let prepared = prepareCommitReconciliation(
    params,
    recoveryLedger,
    interpretationPrepared,
    staleRecoveryRawFindingIds,
  );
  if (prepared.invalidInterpretationRawFindingIds.size > 0) {
    interpretationPrepared = prepareInterpretationCaseActions({
      ledger: recoveryLedger,
      items: params.managerDecision.interpretation.items,
      completedAttemptIds: params.managerDecision.interpretation.completedAttemptIdsForCommit,
      directPlans: params.managerDecision.interpretation.directPlans,
      proofFastPathPlans: params.managerDecision.interpretation.proofFastPathPlans,
      provisionalOnlyRawFindingIds: params.managerDecision.interpretation.provisionalOnlyRawFindingIds,
      invalidRawFindingIds: prepared.invalidInterpretationRawFindingIds,
    });
    prepared = prepareCommitReconciliation(
      params,
      recoveryLedger,
      interpretationPrepared,
      staleRecoveryRawFindingIds,
    );
  }
  const roundsCompleted = stopBudgetRoundsCompleted(freshLedger);
  const actionRecoveryCandidates = collectManagerActionRecoveryCandidates(
    recoveryLedger,
    roundsCompleted,
  );
  const { input, managerDecision } = params;
  const { managerOutput } = managerDecision;
  const { admission } = prepared;
  const isolatedManagerOutput = isolateManagerOutputForCommit(
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
    ...managerEntryIsolation.provisionalSpecs,
  ].filter((spec) => !containsIsolatedRawFinding(
    spec.sourceRawFindingIds,
    staleRecoveryRawFindingIds,
  ));
  let merged = isolateManagerOutputForCommit(
    mergeOutputs(
      output,
      interpretationManagerOutput(interpretationPrepared, params.managerDecision.interpretation.items),
    ),
    managerEntryIsolation.droppedRawFindingIds,
  );
  const conflictAuthorityByRawFindingId = new Map(
    interpretationPrepared.cases.flatMap((preparedCase) => {
      if (preparedCase.action.kind !== 'open_conflict') {
        return [];
      }
      const authority = issueInterpretationCaseConflictAuthority({
        ledger: recoveryLedger,
        preparedCase,
        items: params.managerDecision.interpretation.items,
      });
      return preparedCase.rawFindingIds.map((rawFindingId) => [rawFindingId, authority] as const);
    }),
  );
  const rawProvenanceByRawFindingId = new Map(
    [...prepared.rawProvenanceByRawFindingId].map(([rawFindingId, provenance]) => {
      const authority = conflictAuthorityByRawFindingId.get(rawFindingId);
      return [
        rawFindingId,
        authority === undefined
          ? provenance
          : { ...provenance, interpretationCaseConflictAuthority: authority },
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
    rawProvenanceByRawFindingId,
    cleanWire: admission.cleanWire,
    explicitResolvedByMapping: new Map<string, string>(),
    explicitPromotedFindingIds: new Set<string>(),
    recoveryProvisionalRawFindingIds: new Set<string>(),
    staleRawFindingIds: staleRecoveryRawFindingIds,
    deferredRawFindingIds: new Set<string>(),
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
  const noActionRecoveryPlan = (ledger: FindingLedger): ManagerActionRecoveryLifecyclePlan => ({
    ledger,
    output: createEmptyManagerOutput(),
    appliedLedger: ledger,
    settledLedger: ledger,
    settlements: new Map(),
    failures: new Map(),
  });
  let actionRecoveryPlan = interpretationPrepared.cases.length === 0
    ? buildActionRecoveryPlan(reconcilePlan.ledger)
    : noActionRecoveryPlan(reconcilePlan.ledger);
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
    actionRecoveryPlan = interpretationPrepared.cases.length === 0
      ? buildActionRecoveryPlan(reconcilePlan.ledger)
      : noActionRecoveryPlan(reconcilePlan.ledger);
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

  const stagedManagerDecisionLedger = stagePreparedInterpretationCaseOwnership({
    ledger: reconcilePlan.managerDecisionLedger,
    prepared: interpretationPrepared,
    items: params.managerDecision.interpretation.items,
    observation: params.observation,
  });
  const stagedSettledLedger = stagePreparedInterpretationCaseOwnership({
    ledger: actionRecoveryPlan.ledger,
    prepared: interpretationPrepared,
    items: params.managerDecision.interpretation.items,
    observation: params.observation,
  });
  const finalized = applyCommitLedgerStates({
    runInput: input,
    freshLedger,
    settledLedger: stagedSettledLedger,
    baseAnomalySpecs: prepared.anomalySpecs,
    pendingRejectedObservations: admission.pendingRejectedObservations,
    verifiedEvidenceCandidates: admission.verifiedEvidenceCandidates,
  });
  const interpretationRecoverySettlements: InterpretationRecoveryOriginSettlement[] = [];
  return {
    ledger: finalized.ledger,
    result: {
      applied: true,
      managerDecisionLedger: stagedManagerDecisionLedger,
      managerDecisionCommands: attachInterpretationCaseOrigins(attachCapturedConflictHeads({
        commands: reconcilePlan.managerDecisionCommands,
        resolvedConflictIds: new Set(
          reconcilePlan.managerOutput.resolvedConflicts.map(
            (conflict) => conflict.conflictId,
          ),
        ),
        capturedConflictHeads: managerDecision.conflictTargetHeads,
        cwd: input.cwd,
      }), interpretationPrepared),
      lifecycleManagerOutput: reconcilePlan.managerOutput,
      staleRejections: [...staleRejections, ...reconcilePlan.normalizationRejections],
      unsupportedRawFindingReports: revalidated.unsupportedRawFindingReports,
      admissionRejections: admission.admissionRejections,
      provisionalLandings,
      reviewerAnomalyLandings: finalized.reviewerAnomalyLandings,
      interpretationRecoverySettlements,
      resolutionRenotifications: revalidated.resolutionRenotifications,
      rejectedObservationAttachments: [
        ...reconcilePlan.rejectedObservationAttachments,
        ...finalized.rejectedObservationAttachments,
      ],
      settlementCommands: attachInterpretationCaseOrigins(
        reconcilePlan.settlementCommands,
        interpretationPrepared,
      ),
      actionRecoveryPlan,
      interpretationPrepared,
    },
  };
}
