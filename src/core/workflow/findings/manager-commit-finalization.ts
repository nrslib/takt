import {
  reconcileFindingLedgerPlan,
  type CanonicalRawReconcileProvenance,
  type ProvisionalFindingSpec,
} from './reconciler.js';
import {
  applyReviewerAnomalySpecsToLedger,
  collectReviewSupersededReviewerAnomalyIds,
  createReviewerAnomalySpec,
  linkPromotedReviewerAnomalies,
  selectRestatementSourceClaimAtom,
  withdrawReviewerAnomaliesSupersededByReview,
  type ReviewerAnomalySpec,
} from './reviewer-anomalies.js';
import type { ReviewerAnomalyLandingReport } from './store.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingEvidenceRecord,
  FindingObservation,
  RawFinding,
} from './types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type {
  PreAdmissionEntityMutationResult,
  PreAdmissionEntityProvisionalMutation,
} from './pre-admission-entity-binding-types.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import {
  applyProvisionalSettlement,
  buildProvisionalSettlementLifecycleCommands,
  settleProvisionalsWithCleanEvidence,
  type RejectedObservationAttachment,
} from './manager-provisional-settlement.js';
import {
  collectActiveConflictFindingIds,
  normalizeEngineDerivedWaiverConflicts,
  normalizeMergedManagerPlan,
} from './manager-plan-normalization.js';
import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { collectRegeneratedConflictIds } from '../../models/finding-conflict-identity.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import {
  applyResolutionRenotificationTransitions,
  type ResolutionRenotificationTransition,
} from './resolution-renotification.js';
import { resolveCurrentLifecycleObservationTarget } from './reviewer-anomaly-policy.js';
import {
  reviewerAnomalySettlementEligibilityViolation,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
import type { ReviewerAnomalyAdjudicationSettlement } from '../../models/finding-types.js';
import type { ReviewerAnomalyAdjudicationDecision } from './manager-task-contracts.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';
import {
  listFindingReviewPublications,
  type CanonicalFindingReviewPublication,
} from './review-publication.js';

interface RejectedObservationPlan {
  attachments: RejectedObservationAttachment[];
  anomalySpecs: ReviewerAnomalySpec[];
}

function applyIntakeContractTerminalDispositions(input: {
  ledger: FindingLedger;
  publications: readonly CanonicalFindingReviewPublication[];
  observation: FindingObservation;
  deferClaimBearingTerminalDispositions?: boolean;
}): FindingLedger {
  const publicationsByAnomalyId = new Map<string, CanonicalFindingReviewPublication[]>();
  for (const publication of input.publications) {
    if (publication.presentationContext?.revision !== 2) {
      continue;
    }
    for (const anomalyId of publication.presentationContext.presentedReviewerAnomalyIds) {
      const publications = publicationsByAnomalyId.get(anomalyId) ?? [];
      if (!publications.some((candidate) => candidate.publicationId === publication.publicationId)) {
        publications.push(publication);
      }
      publicationsByAnomalyId.set(anomalyId, publications);
    }
  }
  let changed = false;
  const reviewerAnomalies = (input.ledger.reviewerAnomalies ?? []).map((anomaly) => {
    const defect = anomaly.intakeContract;
    if (
      anomaly.kind !== 'intake-contract-incomplete'
      || defect === undefined
      || anomaly.promotedFindingId !== undefined
      || anomaly.settlement !== undefined
      || defect.terminalDisposition !== undefined
    ) {
      return anomaly;
    }
    // 言い直しで再現を要求できる claim 本文を選べない観測は、提示を何度重ねても
    // 受理され得ない。request 自体が作られないので提示による終端にも到達せず、
    // 放置すると未決着のまま COMPLETE を永久に塞ぐ。その場で終端する。
    const sourceRaw = anomaly.sourceRawFindingIds
      .map((rawFindingId) => input.ledger.rawFindings.find((raw) => raw.rawFindingId === rawFindingId))
      .find((raw) => raw !== undefined);
    if (
      sourceRaw !== undefined
      && selectRestatementSourceClaimAtom(anomaly, sourceRaw) === undefined
    ) {
      changed = true;
      return {
        ...anomaly,
        intakeContract: {
          ...defect,
          terminalDisposition: {
            kind: 'undemandable_claim_atom' as const,
            // claim-bearing は「主張はあったのに機械可読な形で残らなかった」事実を
            // 可視的失敗として扱う。protocol-noise だけが静かに却下される。
            workflowOutcome: defect.observationClass === 'claim-bearing'
              ? 'review_integrity_unresolved' as const
              : 'non_claim_observation_rejected' as const,
            decidedAt: input.observation,
            reason: 'The recorded observation carries no claim body that a restatement request could ask back',
          },
        },
      };
    }
    if (
      input.deferClaimBearingTerminalDispositions === true
      && defect.observationClass === 'claim-bearing'
    ) {
      // 除外扱いの restatement slot では、この時点の未成立 publication を終端化しない。
      // slot の evidence-search 結果を同じ manager commit に取り込んでから、通常の
      // presentation limit / terminal disposition 判定へ進める必要がある。
      return anomaly;
    }
    const publications = publicationsByAnomalyId.get(anomaly.id) ?? [];
    if (
      publications.length === 0
      || (
        publications.length < defect.presentationLimit
        && defect.observationClass === 'claim-bearing'
      )
    ) {
      return anomaly;
    }
    changed = true;
    const terminalPublicationId = [...publications]
      .sort((left, right) => {
        const leftRequest = left.presentationContext.restatementRequests.find(
          (request) => request.anomalyId === anomaly.id,
        );
        const rightRequest = right.presentationContext.restatementRequests.find(
          (request) => request.anomalyId === anomaly.id,
        );
        return left.stepIteration - right.stepIteration
          || (leftRequest?.presentationOrdinal ?? 0) - (rightRequest?.presentationOrdinal ?? 0)
          || compareBinaryStrings(left.publicationId, right.publicationId);
      })
      .at(-1)!.publicationId;
    return {
      ...anomaly,
      intakeContract: {
        ...defect,
        terminalDisposition: {
          kind: defect.observationClass === 'claim-bearing'
            ? 'restatement_exhausted_claim_bearing' as const
            : 'protocol_noise_rejected_after_presentation' as const,
          workflowOutcome: defect.observationClass === 'claim-bearing'
            ? 'review_integrity_unresolved' as const
            : 'non_claim_observation_rejected' as const,
          decidedAt: input.observation,
          terminalPublicationId,
          reason: defect.observationClass === 'claim-bearing'
            ? `Restatement presentation limit ${defect.presentationLimit} was reached without verified correspondence`
            : 'The protocol-noise observation was presented once without a claim-bearing reassertion',
        },
      },
    };
  });
  return changed ? { ...input.ledger, reviewerAnomalies } : input.ledger;
}

/**
 * 裁定が却下した終端処分済み anomaly へ settlement を書き込む。
 *
 * 成立判定は書き込み先の台帳（このコミットで出来上がる配列）で行い、台帳側の
 * 成立条件（reviewerAnomalySettlementEligibilityViolation）をそのまま使う。裁定を
 * 出した時点と保存時点で状態がずれた anomaly（同ラウンドで昇格した等）は黙って
 * 落とす — 決着済みを二重に決着させない。
 */
function applyReviewerAnomalyAdjudications(input: {
  ledger: FindingLedger;
  adjudications: readonly ReviewerAnomalyAdjudicationDecision[];
  workflowTask: string;
  observation: FindingObservation;
  /** 不採用になった裁定の理由。監査レポートへ載せるため呼び出し側が受け取る。 */
  rejections: string[];
}): FindingLedger {
  const anomalies = input.ledger.reviewerAnomalies;
  if (anomalies === undefined || input.adjudications.length === 0) {
    return input.ledger;
  }
  const workflowTaskDigest = computeWorkflowTaskDigest(input.workflowTask);
  const adjudicationByAnomalyId = new Map(
    input.adjudications.map((adjudication) => [adjudication.anomalyId, adjudication] as const),
  );
  let changed = false;
  const updated = anomalies.map((anomaly) => {
    const adjudication = adjudicationByAnomalyId.get(anomaly.id);
    if (adjudication === undefined) {
      return anomaly;
    }
    const settlement: ReviewerAnomalyAdjudicationSettlement = {
      kind: 'dismissed_by_terminal_adjudication',
      basis: adjudication.basis,
      taskQuote: adjudication.taskQuote,
      workflowTaskDigest: adjudication.workflowTaskDigest,
      claimQuote: adjudication.claimQuote,
      adjudicationTaskId: adjudication.adjudicationTaskId,
      reason: adjudication.reason,
      decidedAt: input.observation,
    };
    const violation = reviewerAnomalySettlementEligibilityViolation({
      projection: input.ledger,
      anomaly,
      settlement,
      sourceHead: { kind: 'projection' },
      workflowTaskDigest,
    });
    if (violation !== undefined) {
      // 無言で捨てない。裁定が出たのに保存されなかった事実と理由を監査へ残す。
      input.rejections.push(
        `reviewerAnomalyAdjudications: anomaly "${anomaly.id}" rejected at save time: ${violation}`,
      );
      return anomaly;
    }
    changed = true;
    return { ...anomaly, settlement };
  });
  return changed ? { ...input.ledger, reviewerAnomalies: updated } : input.ledger;
}

function classifyRejectedObservations(
  pendingObservations: RawAdmissionEvaluation['pendingRejectedObservations'],
  ledger: FindingLedger,
): RejectedObservationPlan {
  return pendingObservations.reduce<RejectedObservationPlan>((plan, pending) => {
    const target = ledger.findings.find((finding) => finding.id === pending.targetFindingId);
    const auditTarget = resolveCurrentLifecycleObservationTarget(
      ledger,
      pending.item.wire,
    );
    if (
      pending.destination === 'target_audit'
      && (
        pending.targetValidation === 'entity_binding'
          ? target !== undefined
          : auditTarget?.id === pending.targetFindingId
      )
    ) {
      return {
        ...plan,
        attachments: [...plan.attachments, {
          targetFindingId: pending.targetFindingId,
          rawFindingId: pending.item.wire.rawFindingId,
          reason: `${pending.reason}; recorded for audit only without lifecycle or evidence authority`,
          rejectionCode: 'evidence_admission_failed',
        }],
      };
    }
    const anomalySpec = createReviewerAnomalySpec({
      wire: pending.item.wire,
      canonical: pending.item.canonical,
      anomalyKind: pending.anomalyKind,
      failedEvidence: pending.failedEvidence,
      reason: `${pending.reason}; lifecycle evidence failure is audit-only and cannot mutate the target (current status: ${target?.status ?? 'missing'})`,
    });
    return {
      ...plan,
      anomalySpecs: [...plan.anomalySpecs, anomalySpec],
    };
  }, { attachments: [], anomalySpecs: [] });
}

export function reconcileCommitPlan(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  entityProvisionalMutations: PreAdmissionEntityProvisionalMutation[];
  anomalySpecs: ReviewerAnomalySpec[];
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
  entityMutationResults: PreAdmissionEntityMutationResult[];
  normalizationRejections: string[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  settlementCommands: FindingLifecycleCommand[];
} {
  if (!Array.isArray(input.entityProvisionalMutations)) {
    throw new Error(
      'Commit reconciliation entityProvisionalMutations must be an explicit array',
    );
  }
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
  });
  const rejectedProvisionalMatchRawIds = new Set(
    settlement.rejectedObservationAttachments.map((attachment) => attachment.rawFindingId),
  );
  const provisionalSpecs = input.provisionalSpecs.flatMap((spec) => {
    const sourceRawFindingIds = spec.sourceRawFindingIds.filter(
      (rawFindingId) => !rejectedProvisionalMatchRawIds.has(rawFindingId),
    );
    return sourceRawFindingIds.length === 0
      ? []
      : [{ ...spec, sourceRawFindingIds }];
  });
  const entityProvisionalMutations = input.entityProvisionalMutations.flatMap((mutation) => {
    const sourceRawFindingIds = mutation.sourceRawFindingIds.filter(
      (rawFindingId) => !rejectedProvisionalMatchRawIds.has(rawFindingId),
    );
    return sourceRawFindingIds.length === 0
      ? []
      : [{ ...mutation, sourceRawFindingIds }];
  });
  // settlement も matches を後着させる（clean new → provisional への match 変換）。
  // resolution confirmation と衝突した場合に備え、canonicalize をもう一度通す
  // （純・冪等 — 衝突が無ければ no-op）。
  const canonicalized = normalizeEngineDerivedWaiverConflicts(
    canonicalizeFindingManagerOutput(settlement.output),
  );
  const { output: settledOutput, rejections: normalizationRejections } = dropRegeneratedConflictResolves(
    canonicalized,
    input.freshLedger,
    normalized.rejections,
  );
  const landedSpecs = provisionalSpecs;
  const reconciledPlan = reconcileFindingLedgerPlan({
    priorStepResponseText: input.runInput.priorStepResponseText,
    previousLedger: input.freshLedger,
    rawFindings: input.rawFindings,
    managerOutput: settledOutput,
    provisionalFindings: landedSpecs,
    entityProvisionalMutations,
    terminalEntityAttachmentFindingIds: new Set([
      ...settlement.promotedFindingIds,
      ...settlement.resolvedByMapping.keys(),
      ...settlement.resolvedByEvidence.keys(),
    ]),
    rawProvenanceByRawFindingId: input.rawProvenanceByRawFindingId,
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
  const entityMutationResults = reconciledPlan.entityMutationResults.map(
    (result): PreAdmissionEntityMutationResult => {
      if (result.outcome === 'terminal_audit') {
        return result;
      }
      const target = settled.findings.find((finding) => finding.id === result.findingId);
      return target?.status === 'open' && target.provisional !== undefined
        ? result
        : {
            outcome: 'terminal_audit',
            targetFindingId: result.findingId,
            sourceRawFindingIds: result.mutation.sourceRawFindingIds,
            reason: `${result.mutation.reason}; target became terminal during commit`,
          };
    },
  );
  const terminalEntityResults = entityMutationResults.filter(
    (result): result is Extract<
      PreAdmissionEntityMutationResult,
      { outcome: 'terminal_audit' }
    > => result.outcome === 'terminal_audit',
  );
  const settlementCommands = buildProvisionalSettlementLifecycleCommands({
    after: settled,
    settlement,
  });
  const rejectedObservationAttachments = [
    ...reconciledPlan.rejectedObservationAttachments,
    ...settlement.rejectedObservationAttachments,
    ...terminalEntityResults.flatMap((result) => (
      result.sourceRawFindingIds.map((rawFindingId) => ({
        targetFindingId: result.targetFindingId,
        rawFindingId,
        reason: `${result.reason}; recorded for audit because the ambiguity episode became terminal`,
        rejectionCode: 'evidence_admission_failed' as const,
      }))
    )),
  ];
  return {
    ledger: settled,
    managerDecisionLedger: reconciled,
    managerDecisionCommands: reconciledPlan.lifecycleCommands,
    managerOutput: settledOutput,
    landedSpecs,
    entityMutationResults,
    normalizationRejections: [
      ...normalizationRejections,
      ...reconciledPlan.deferredResolutionRejections,
    ],
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

export function applyCommitLedgerStates(input: {
  runInput: RunFindingManagerForStepInput;
  freshLedger: FindingLedger;
  settledLedger: FindingLedger;
  baseAnomalySpecs: ReviewerAnomalySpec[];
  pendingRejectedObservations: RawAdmissionEvaluation['pendingRejectedObservations'];
  verifiedEvidenceCandidates: RawAdmissionEvaluation['verifiedEvidenceCandidates'];
  anomalyAdjudications: readonly ReviewerAnomalyAdjudicationDecision[];
}): {
  ledger: FindingLedger;
  reviewerAnomalyLandings: ReviewerAnomalyLandingReport[];
  rejectedObservationAttachments: RejectedObservationAttachment[];
  /** 保存時に不採用となった裁定の理由。manager validation report へ載せる。 */
  adjudicationRejections: string[];
} {
  const adjudicationRejections: string[] = [];
  const rejectedObservations = classifyRejectedObservations(
    input.pendingRejectedObservations,
    input.settledLedger,
  );
  const observation = {
    runId: input.runInput.runId,
    stepName: input.runInput.parentStep.name,
    timestamp: input.runInput.timestamp,
  };
  // このラウンドでレビューを台帳へ登録したレビュアー枠。publication があること
  // 自体が「そのレビュアーの完全なレビューが成立した」証跡（ParallelRunner は
  // 全レビュアーの canonical publication が揃うまで取り込みを始めない）。
  // 1レビュアー枠が同一ラウンドに複数 publication を持つことがある(格上げ
  // 再レビューは owner ごとに1呼び出しだが reviewer キーは固定)。Map の値を
  // 単一 ID にすると後勝ちで1件へ潰れ、取り下げの監査記録に別 owner の
  // publication ID が入る。全件を保持する。
  const publicationIdsByReviewer = new Map<string, string[]>();
  const verdictReviewers = new Set<string>();
  for (const { publication, reviewEvidence } of input.runInput.subResults) {
    // 言い直しだけを行った差し戻し publication は「完全なレビューが成立した」
    // 証跡にならない。ここへ入れると、レビューされていない anomaly が
    // 「後続レビューがあった」ものとして未検証のまま取り下げられる。
    if (reviewEvidence === 'none') {
      continue;
    }
    if (reviewEvidence === undefined || reviewEvidence === 'verdict') {
      verdictReviewers.add(publication.reviewerStepName);
    }
    const ids = publicationIdsByReviewer.get(publication.reviewerStepName);
    if (ids === undefined) {
      publicationIdsByReviewer.set(publication.reviewerStepName, [publication.publicationId]);
    } else {
      ids.push(publication.publicationId);
    }
  }
  const supersededAnomalyIds = collectReviewSupersededReviewerAnomalyIds(
    input.settledLedger,
    new Set(publicationIdsByReviewer.keys()),
    verdictReviewers,
  );
  const anomalySpecs = [...input.baseAnomalySpecs, ...rejectedObservations.anomalySpecs];
  const withAnomalies = applyReviewerAnomalySpecsToLedger(
    input.settledLedger,
    anomalySpecs,
    {
      workflowName: input.runInput.workflowName,
      ...observation,
    },
    supersededAnomalyIds,
  );
  const storedPublications = input.runInput.reviewPublicationDir === undefined
    ? []
    : listFindingReviewPublications(input.runInput.reviewPublicationDir);
  const withPromotions = linkPromotedReviewerAnomalies(
    withAnomalies,
    input.verifiedEvidenceCandidates,
  );
  const withTerminalDispositions = applyIntakeContractTerminalDispositions({
    ledger: withPromotions,
    publications: [
      ...storedPublications,
      ...input.runInput.subResults.map(({ publication }) => publication),
    ],
    observation,
    deferClaimBearingTerminalDispositions: input.runInput.deferClaimBearingTerminalDispositions,
  });
  // 昇格（promotedFindingId）が成立しなかった古い anomaly は、そのレビュアーの
  // 後続レビューが登録された時点で取り下げとして決着する。linkPromotedReviewerAnomalies
  // の後に置くこと — 取り下げ対象になる非 intake anomaly の昇格は lineageKey 経由で
  // 判定されるため、先に決着させるとその昇格が記録されない。
  const withWithdrawals = withdrawReviewerAnomaliesSupersededByReview({
    ledger: withTerminalDispositions,
    candidateAnomalyIds: supersededAnomalyIds,
    publicationIdsByReviewer,
    observation,
  });
  // 裁定は決着済みを触らないので、他の決着経路が全て終わった後の台帳で成立を
  // 判定する（このコミットで昇格・取り下げになった anomaly は対象から落ちる）。
  const withAdjudications = applyReviewerAnomalyAdjudications({
    ledger: withWithdrawals,
    adjudications: input.anomalyAdjudications,
    workflowTask: input.runInput.workflowTask,
    observation,
    rejections: adjudicationRejections,
  });
  return {
    ledger: withAdjudications,
    adjudicationRejections,
    reviewerAnomalyLandings: anomalySpecs.map((spec) => ({
      kind: spec.kind,
      stableKey: spec.stableKey,
      reason: spec.mismatchReason,
      sourceRawFindingIds: spec.sourceRawFindingIds,
      sourceIntakeIds: spec.sourceIntakeIds,
    })),
    rejectedObservationAttachments: rejectedObservations.attachments,
  };
}
