import { reconcileFindingLedger, type ProvisionalFindingSpec } from './reconciler.js';
import {
  applyReviewerAnomalySpecsToLedger,
  createReviewerAnomalySpec,
  linkPromotedReviewerAnomalies,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import { attachFixpointState } from './fixpoint.js';
import { attachStopBudgetState, resolveStopBudgetLimits } from './stop-budget.js';
import { attachReviewIntegrityState, resolveReviewIntegrityLimits } from './review-integrity.js';
import { markInterpretationsApplied } from './interpretation-wal.js';
import type { ReviewerAnomalyLandingReport } from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  InterpretationApplicationResult,
  RawFinding,
} from './types.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import {
  applyProvisionalSettlement,
  applyRejectedObservationAttachments,
  settleProvisionalsWithCleanEvidence,
} from './manager-provisional-settlement.js';
import { collectActiveConflictFindingIds, normalizeMergedManagerPlan } from './manager-plan-normalization.js';
import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { collectRegeneratedConflictIds } from './conflict-identity.js';

interface RejectedObservationPlan {
  attachments: Array<{ targetFindingId: string; rawFindingId: string; reason: string }>;
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
        }],
      };
    }
    return {
      ...plan,
      anomalySpecs: [...plan.anomalySpecs, createReviewerAnomalySpec({
        wire: pending.item.wire,
        canonical: pending.item.canonical,
        anomalyKind: 'quote-mismatch',
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
  rawProvenanceByRawFindingId: Map<string, { reviewerStableKey: string; lineageKey: string }>;
  cleanWire: RawFinding[];
  explicitResolvedByMapping: ReadonlyMap<string, string>;
  explicitPromotedFindingIds: ReadonlySet<string>;
  recoveryProvisionalRawFindingIds: ReadonlySet<string>;
  deferredRawFindingIds: ReadonlySet<string>;
  healthyReviewerStableKeys: ReadonlySet<string>;
}): { ledger: FindingLedger; landedSpecs: ProvisionalFindingSpec[]; normalizationRejections: string[] } {
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
  const reconciled = reconcileFindingLedger({
    priorStepResponseText: input.runInput.priorStepResponseText,
    previousLedger: input.freshLedger,
    rawFindings: input.rawFindings,
    managerOutput: settledOutput,
    provisionalFindings: landedSpecs,
    rawProvenanceByRawFindingId: input.rawProvenanceByRawFindingId,
    excludedFromUnmentionedFallbackRawFindingIds: new Set([
      ...input.pendingRejectedObservations.map((pending) => pending.item.wire.rawFindingId),
      ...input.anomalySpecs.flatMap((spec) => spec.sourceRawFindingIds),
      ...suppressedSpecs.flatMap((spec) => spec.sourceRawFindingIds),
      ...input.recoveryProvisionalRawFindingIds,
      ...input.deferredRawFindingIds,
    ]),
    context: {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  });
  const settled = applyProvisionalSettlement(reconciled, settlement, input.runInput.timestamp);
  const attached = attachSuppressedObservationsToDismissed(
    settled,
    suppressedSpecs,
    new Set(settledOutput.dismissedFindings.map((dismissed) => dismissed.findingId)),
    {
      runId: input.runInput.runId,
      stepName: input.runInput.parentStep.name,
      timestamp: input.runInput.timestamp,
    },
  );
  return {
    ledger: attached,
    landedSpecs,
    normalizationRejections,
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
  const regeneratedConflictIds = collectRegeneratedConflictIds(freshLedger.conflicts, output.conflicts);
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
 * status / revision / canonical evidence には影響しない
 * （rejectedObservations の既存契約と同じ）。
 */
function attachSuppressedObservationsToDismissed(
  ledger: FindingLedger,
  suppressedSpecs: readonly ProvisionalFindingSpec[],
  dismissedThisRoundFindingIds: ReadonlySet<string>,
  observedAt: { runId: string; stepName: string; timestamp: string },
): FindingLedger {
  if (suppressedSpecs.length === 0) {
    return ledger;
  }
  const rawIdsByStableKey = new Map<string, Set<string>>();
  for (const spec of suppressedSpecs) {
    const rawIds = rawIdsByStableKey.get(spec.stableKey) ?? new Set<string>();
    for (const rawFindingId of spec.sourceRawFindingIds) {
      rawIds.add(rawFindingId);
    }
    rawIdsByStableKey.set(spec.stableKey, rawIds);
  }
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      if (!dismissedThisRoundFindingIds.has(finding.id) || finding.provisional === undefined) {
        return finding;
      }
      const rawIds = rawIdsByStableKey.get(finding.provisional.stableKey);
      if (rawIds === undefined) {
        return finding;
      }
      return {
        ...finding,
        rejectedObservations: [
          ...(finding.rejectedObservations ?? []),
          ...[...rawIds].map((rawFindingId) => ({
            rawFindingId,
            reason: 'Same-claim observation arrived in the round its provisional was dismissed; recorded for audit only — the dismissal covers this re-assertion',
            observedAt: { runId: observedAt.runId, stepName: observedAt.stepName, timestamp: observedAt.timestamp },
          })),
        ],
      };
    }),
  };
}

export function applyCommitLedgerStates(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  settledLedger: FindingLedger;
  baseAnomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  interpretationResults: Map<string, InterpretationApplicationResult>;
  interpretationReservations: ReadonlyMap<string, string>;
  observation: FindingObservation;
  verifiedEvidenceCandidates: RawAdmissionEvaluation['verifiedEvidenceCandidates'];
  stopBudgetLimits: ReturnType<typeof resolveStopBudgetLimits>;
  stopBudgetRoundMarker: string;
  reviewIntegrityLimits: ReturnType<typeof resolveReviewIntegrityLimits>;
}): { ledger: FindingLedger; reviewerAnomalyLandings: ReviewerAnomalyLandingReport[] } {
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
  const withRejectedObservations = applyRejectedObservationAttachments(
    withAnomalies,
    rejectedObservations.attachments,
    input.observation,
  );
  const applied = markInterpretationsApplied(
    withRejectedObservations,
    input.interpretationResults,
    input.interpretationReservations,
    input.observation,
  );
  const withPromotions = linkPromotedReviewerAnomalies(applied, input.verifiedEvidenceCandidates);
  const withFixpoint = attachFixpointState(input.freshLedger, withPromotions, input.runInput.cwd);
  const withStopBudget = attachStopBudgetState(
    input.freshLedger,
    withFixpoint,
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
  };
}
