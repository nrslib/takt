import {
  reconcileFindingLedgerPlan,
  type CanonicalRawReconcileProvenance,
  type ProvisionalFindingSpec,
} from './reconciler.js';
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
  linkPromotedReviewerAnomalies,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import { attachStopBudgetState, resolveStopBudgetLimits } from './stop-budget.js';
import { attachReviewIntegrityState, resolveReviewIntegrityLimits } from './review-integrity.js';
import {
  markInterpretationsApplied,
} from './interpretation-wal.js';
import type { ReviewerAnomalyLandingReport } from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  FindingEvidenceRecord,
  InterpretationApplicationResult,
  RawFindingDisposition,
  RawFinding,
} from './types.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import {
  applyProvisionalSettlement,
  buildProvisionalSettlementLifecycleCommands,
  settleProvisionalsWithCleanEvidence,
} from './manager-provisional-settlement.js';
import { collectActiveConflictFindingIds, normalizeMergedManagerPlan } from './manager-plan-normalization.js';
import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { collectRegeneratedConflictIds } from '../../models/finding-conflict-identity.js';
import { collectLandedRawIds } from './manager-utils.js';
import type { FindingRejectedObservationCode } from '../../models/finding-types.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import {
  applyResolutionRenotificationTransitions,
  type ResolutionRenotificationTransition,
} from './resolution-renotification.js';

export interface RejectedObservationAttachment {
  targetFindingId: string;
  rawFindingId: string;
  reason: string;
  rejectionCode: FindingRejectedObservationCode;
}

interface RejectedObservationPlan {
  attachments: RejectedObservationAttachment[];
  anomalySpecs: ReviewerAnomalySpec[];
}

function classifyRejectedObservations(
  pendingObservations: RawAdmissionEvaluation['pendingRejectedObservations'],
  ledger: FindingLedger,
): RejectedObservationPlan {
  return pendingObservations.reduce<RejectedObservationPlan>((plan, pending) => {
    const target = ledger.findings.find((finding) => finding.id === pending.targetFindingId);
    if (target !== undefined && target.status === 'open') {
      return {
        ...plan,
        attachments: [...plan.attachments, {
          targetFindingId: pending.targetFindingId,
          rawFindingId: pending.item.wire.rawFindingId,
          reason: pending.reason,
          rejectionCode: 'evidence_admission_failed',
        }],
      };
    }
    return {
      ...plan,
      anomalySpecs: [...plan.anomalySpecs, createReviewerAnomalySpec({
        wire: pending.item.wire,
        canonical: pending.item.canonical,
        anomalyKind: 'quote-mismatch',
        failedEvidence: pending.failedEvidence,
        reason: `${pending.reason}; the target is no longer open after this round, so the observation is isolated as a reviewer anomaly instead`,
      })],
    };
  }, { attachments: [], anomalySpecs: [] });
}

export function reconcileCommitPlan(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  anomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  rawProvenanceByRawFindingId: Map<string, CanonicalRawReconcileProvenance>;
  cleanWire: RawFinding[];
  explicitResolvedByMapping: ReadonlyMap<string, string>;
  explicitPromotedFindingIds: ReadonlySet<string>;
  recoveryProvisionalRawFindingIds: ReadonlySet<string>;
  staleRawFindingIds: ReadonlySet<string>;
  deferredRawFindingIds: ReadonlySet<string>;
  resolutionRenotifications: readonly ResolutionRenotificationTransition[];
  unsupportedRawFindingReports: readonly {
    rawFindingId: string;
    evidence: string;
  }[];
  healthyReviewerStableKeys: ReadonlySet<string>;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
}): {
  ledger: FindingLedger;
  managerDecisionLedger: FindingLedger;
  managerDecisionCommands: FindingLifecycleCommand[];
  managerOutput: FindingManagerOutput;
  landedSpecs: ProvisionalFindingSpec[];
  normalizationRejections: string[];
  rawFindingDispositions: RawFindingDisposition[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  settlementCommands: FindingLifecycleCommand[];
} {
  // ladder マージ（mergeOutputs）は matches / newFindings / conflicts を後着させる。
  // 閉じる決定との衝突をここで一括正規化し、残った統合の match 転写もこの1回で
  // 行う（reconciler の最終検証がこの後に走る）。
  const normalized = normalizeMergedManagerPlan({
    output: input.managerOutput,
    activeConflictFindingIds: collectActiveConflictFindingIds(input.freshLedger),
  });
  const settlement = settleProvisionalsWithCleanEvidence({
    output: normalized.output,
    cleanRawIds: new Set(input.cleanWire.map((wire) => wire.rawFindingId)),
    wireById: new Map(input.rawFindings.map((wire) => [wire.rawFindingId, wire])),
    freshLedger: input.freshLedger,
    explicitResolvedByMapping: input.explicitResolvedByMapping,
    explicitPromotedFindingIds: input.explicitPromotedFindingIds,
    healthyReviewerStableKeys: input.healthyReviewerStableKeys,
    replayOrigins: new Map(),
  });
  // clean 証拠による settlement（昇格 / 決定的 same による解消）が確定した
  // provisional への dismiss は不採用にする — clean 証拠が常に管轄裁定より
  // 優先（settlement 側が status を変えるため、残すと reconciler の
  // 「1 finding = 1 決定」検証で出力全体が落ちる）。
  const settledFindingIds = new Set([
    ...settlement.promotedFindingIds,
    ...settlement.resolvedByMapping.keys(),
    ...settlement.resolvedByEvidence.keys(),
  ]);
  // settlement も matches を後着させる（clean new → provisional への match 変換）。
  // resolution confirmation と衝突した場合に備え、canonicalize をもう一度通す
  // （純・冪等 — 衝突が無ければ no-op）。
  const canonicalized = canonicalizeFindingManagerOutput(
    settledFindingIds.size > 0
      ? {
          ...settlement.output,
          dismissedFindings: settlement.output.dismissedFindings.filter(
            (dismissed) => !settledFindingIds.has(dismissed.findingId),
          ),
        }
      : settlement.output,
  );
  const { output: settledOutput, rejections: normalizationRejections } = dropRegeneratedConflictResolves(
    canonicalized,
    input.freshLedger,
    normalized.rejections,
  );
  // dismiss と同一ラウンドに同じ主張（stableKey）の raw が再来した場合、その
  // provisional spec を着地させない — 裁定は claim の再発同定キー単位で有効で、
  // 着地を許すと dismissed の傍から同じ claim が新 ID の open provisional として
  // 復活し、ゲートが開かないまま dismissed が増殖する。抑止した観測は
  // 監査添付（rejectedObservations）として dismissed finding に残す。
  const dismissedStableKeys = new Set(
    settledOutput.dismissedFindings.flatMap((dismissed) => {
      const finding = input.freshLedger.findings.find((entry) => entry.id === dismissed.findingId);
      return finding?.provisional !== undefined ? [finding.provisional.stableKey] : [];
    }),
  );
  const suppressedSpecs = input.provisionalSpecs.filter((spec) => dismissedStableKeys.has(spec.stableKey));
  const landedSpecs = suppressedSpecs.length > 0
    ? input.provisionalSpecs.filter((spec) => !dismissedStableKeys.has(spec.stableKey))
    : input.provisionalSpecs;
  const landedRawFindingIds = collectLandedRawIds(settledOutput);
  const provisionalRawFindingIds = new Set(
    landedSpecs.flatMap((spec) => spec.sourceRawFindingIds),
  );
  const rawFindingDispositions: RawFindingDisposition[] = [
    ...input.pendingRejectedObservations.map((pending) => ({
      rawFindingId: pending.item.wire.rawFindingId,
      outcome: 'audit_only' as const,
      reason: pending.reason,
    })),
    ...input.anomalySpecs.flatMap((spec) => spec.sourceRawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      outcome: 'reviewer_anomaly' as const,
      reason: spec.mismatchReason,
    }))),
    ...suppressedSpecs.flatMap((spec) => spec.sourceRawFindingIds.map((rawFindingId) => ({
      rawFindingId,
      outcome: 'audit_only' as const,
      reason: `The observation was recorded on the finding dismissed in this round: ${spec.reason}`,
    }))),
    ...[...input.recoveryProvisionalRawFindingIds].flatMap((rawFindingId) => (
      landedRawFindingIds.has(rawFindingId) || provisionalRawFindingIds.has(rawFindingId)
        ? []
        : [{
            rawFindingId,
            outcome: 'audit_only' as const,
            reason: 'The interpretation recovery observation remains represented by its existing provisional finding',
          }]
    )),
    ...[...input.staleRawFindingIds].map((rawFindingId) => ({
      rawFindingId,
      outcome: 'stale' as const,
      reason: 'The recovery observation precondition became stale before commit',
    })),
    ...[...input.deferredRawFindingIds].map((rawFindingId) => ({
      rawFindingId,
      outcome: 'deferred' as const,
      reason: 'Another live interpretation reservation owns this raw finding',
    })),
    ...input.resolutionRenotifications.flatMap((transition) => (
      [...transition.resolutionRawFindingIds, ...transition.renotificationRawFindingIds]
        .filter((rawFindingId) => input.rawFindings.some(
          (rawFinding) => rawFinding.rawFindingId === rawFindingId,
        ))
        .map((rawFindingId) => ({
          rawFindingId,
          outcome: 'resolution_renotification_conflict' as const,
          reason: `Resolution and verified renotification both observed finding "${transition.findingId}" at revision ${transition.observed.targetRevision}`,
        }))
    )),
    ...input.unsupportedRawFindingReports.map((report) => ({
      rawFindingId: report.rawFindingId,
      outcome: 'unsupported' as const,
      reason: report.evidence,
    })),
  ];
  const dispositionRawFindingIds = new Set(
    rawFindingDispositions.map((disposition) => disposition.rawFindingId),
  );
  for (const rawFinding of input.rawFindings) {
    if (rawFinding.relation !== 'resolution_confirmation'
      || landedRawFindingIds.has(rawFinding.rawFindingId)
      || provisionalRawFindingIds.has(rawFinding.rawFindingId)
      || dispositionRawFindingIds.has(rawFinding.rawFindingId)) {
      continue;
    }
    rawFindingDispositions.push({
      rawFindingId: rawFinding.rawFindingId,
      outcome: 'confirmation_not_applied',
      reason: `Resolution confirmation for target "${rawFinding.targetFindingId}" was not accepted by any explicit manager or mechanical outcome`,
    });
    dispositionRawFindingIds.add(rawFinding.rawFindingId);
  }
  if (dispositionRawFindingIds.size !== rawFindingDispositions.length) {
    throw new Error('A raw finding received multiple finite dispositions during commit planning');
  }
  const reconcileRawFindingIds = new Set(
    input.rawFindings.map((rawFinding) => rawFinding.rawFindingId),
  );
  const reconciledPlan = reconcileFindingLedgerPlan({
    priorStepResponseText: input.runInput.priorStepResponseText,
    previousLedger: input.freshLedger,
    rawFindings: input.rawFindings,
    managerOutput: settledOutput,
    provisionalFindings: landedSpecs,
    rawProvenanceByRawFindingId: input.rawProvenanceByRawFindingId,
    rawFindingDispositions: rawFindingDispositions.filter(
      (disposition) => reconcileRawFindingIds.has(disposition.rawFindingId),
    ),
    verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
    context: {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  });
  const reconciled = reconciledPlan.ledger;
  const transitioned = applyResolutionRenotificationTransitions({
    ledger: reconciled,
    transitions: input.resolutionRenotifications,
    observation: {
      runId: input.runInput.runId,
      stepName: input.runInput.parentStep.name,
      timestamp: input.runInput.timestamp,
    },
  });
  const settled = applyProvisionalSettlement(transitioned, settlement, input.runInput.timestamp);
  const settlementCommands = buildProvisionalSettlementLifecycleCommands({
    after: settled,
    settlement,
  });
  const rejectedObservationAttachments = planSuppressedObservationsForDismissed(
    settled,
    suppressedSpecs,
    new Set(settledOutput.dismissedFindings.map((dismissed) => dismissed.findingId)),
  );
  return {
    ledger: settled,
    managerDecisionLedger: reconciled,
    managerDecisionCommands: reconciledPlan.lifecycleCommands,
    managerOutput: settledOutput,
    landedSpecs,
    normalizationRejections,
    rawFindingDispositions,
    rejectedObservationAttachments,
    settlementCommands,
  };
}

/**
 * ladder / settlement / canonicalize が後着させた conflict が、この出力で resolve
 * 済みの conflict と同じ署名を再生成する場合、その resolve を項目単位で不採用に
 * する。残すと reconciler が resolve 直後に同じ conflict を active へ戻し、
 * resolution evidence だけが消えて「採用済みなのに未解決」の記録不整合が残る
 * （assembleConflictDecisions が組み立て段で行うのと同じ規則の保存時版）。
 */
function dropRegeneratedConflictResolves(
  output: FindingManagerOutput,
  freshLedger: FindingLedger,
  priorRejections: readonly string[],
): { output: FindingManagerOutput; rejections: string[] } {
  if (output.resolvedConflicts.length === 0) {
    return { output, rejections: [...priorRejections] };
  }
  const regeneratedConflictIds = collectRegeneratedConflictIds(output.conflicts);
  const regenerated = output.resolvedConflicts.filter(
    (resolved) => regeneratedConflictIds.has(resolved.conflictId),
  );
  if (regenerated.length === 0) {
    return { output, rejections: [...priorRejections] };
  }
  return {
    output: {
      ...output,
      resolvedConflicts: output.resolvedConflicts.filter(
        (resolved) => !regeneratedConflictIds.has(resolved.conflictId),
      ),
    },
    rejections: [
      ...priorRejections,
      ...regenerated.map((resolved) => (
        `conflictDecisions: conflict "${resolved.conflictId}" (resolve) rejected at save time: the same conflict is regenerated by evidence merged after the decision; it stays active`
      )),
    ],
  };
}

/**
 * dismiss と同一ラウンドで抑止した同一 claim の観測を、**このラウンドで**
 * dismissed になった finding の rejectedObservations へ監査添付する（黙って
 * 消さない）。同一 stableKey の spec が複数あっても raw ID を全量集約し、
 * 過去ラウンドで dismissed になった同 stableKey の finding には添付しない。
 * status / canonical evidence には影響しない
 * （rejectedObservations の既存契約と同じ）。
 */
function planSuppressedObservationsForDismissed(
  ledger: FindingLedger,
  suppressedSpecs: readonly ProvisionalFindingSpec[],
  dismissedThisRoundFindingIds: ReadonlySet<string>,
): RejectedObservationAttachment[] {
  if (suppressedSpecs.length === 0) {
    return [];
  }
  const rawIdsByStableKey = new Map<string, Set<string>>();
  for (const spec of suppressedSpecs) {
    const rawIds = rawIdsByStableKey.get(spec.stableKey) ?? new Set<string>();
    for (const rawFindingId of spec.sourceRawFindingIds) {
      rawIds.add(rawFindingId);
    }
    rawIdsByStableKey.set(spec.stableKey, rawIds);
  }
  return ledger.findings.flatMap((finding) => {
    if (!dismissedThisRoundFindingIds.has(finding.id) || finding.provisional === undefined) {
      return [];
    }
    const rawIds = rawIdsByStableKey.get(finding.provisional.stableKey);
    if (rawIds === undefined) {
      return [];
    }
    return [...rawIds].map((rawFindingId) => ({
      targetFindingId: finding.id,
      rawFindingId,
      reason: 'Same-claim observation arrived in the round its provisional was dismissed; recorded for audit only — the dismissal covers this re-assertion',
      rejectionCode: 'dismissed_same_round' as const,
    }));
  });
}

export function applyCommitLedgerStates(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  settledLedger: FindingLedger;
  baseAnomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  interpretationResults: Map<string, InterpretationApplicationResult>;
  interpretationReservations: ReadonlyMap<string, string>;
  interpretationIntegrityDigests: ReadonlyMap<string, string>;
  observation: FindingObservation;
  verifiedEvidenceCandidates: RawAdmissionEvaluation['verifiedEvidenceCandidates'];
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
}): {
  ledger: FindingLedger;
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
} {
  const rejectedObservations = classifyRejectedObservations(
    input.pendingRejectedObservations,
    input.settledLedger,
  );
  const anomalySpecs = [...input.baseAnomalySpecs, ...rejectedObservations.anomalySpecs];
  const withAnomalies = applyReviewerAnomalySpecsToLedger(
    input.settledLedger,
    anomalySpecs,
    {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  );
  const applied = markInterpretationsApplied(
    withAnomalies,
    input.interpretationResults,
    input.interpretationReservations,
    input.interpretationIntegrityDigests,
    input.observation,
  );
  const withPromotions = linkPromotedReviewerAnomalies(applied, input.verifiedEvidenceCandidates);
  const withStopBudget = attachStopBudgetState(
    input.freshLedger,
    withPromotions,
    input.stopBudgetLimits,
    input.stopBudgetRoundMarker,
    input.runInput.timestamp,
  );
  return {
    ledger: attachReviewIntegrityState(
      input.freshLedger,
      withStopBudget,
      input.reviewIntegrityLimits,
      input.stopBudgetRoundMarker,
      input.runInput.timestamp,
    ),
    reviewerAnomalyLandings: anomalySpecs.map((spec) => ({
      kind: spec.kind,
      stableKey: spec.stableKey,
      reason: spec.mismatchReason,
      sourceRawFindingIds: spec.sourceRawFindingIds,
    })),
    rejectedObservationAttachments: rejectedObservations.attachments,
  };
}
