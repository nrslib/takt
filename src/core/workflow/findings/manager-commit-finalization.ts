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
    const publications = publicationsByAnomalyId.get(anomaly.id) ?? [];
    if (
      publications.length === 0
      || publications.length < defect.presentationLimit
        && defect.observationClass === 'claim-bearing'
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
    normalizationRejections,
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
      ...(input.runInput.subResults ?? []).map(({ publication }) => publication),
    ],
    observation: {
      runId: input.runInput.runId,
      stepName: input.runInput.parentStep.name,
      timestamp: input.runInput.timestamp,
    },
  });
  return {
    ledger: withTerminalDispositions,
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
