import { createHash } from 'node:crypto';
import type { AgentWorkflowStep } from '../../models/types.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import {
  canonicalizeReviewerRawFinding,
  computeOverflowStableKey,
  computeReviewerAnomalyStableKey,
  computeReviewerStableKey,
  createReviewerRawFindingCandidates,
  extractLenientRawFields,
  projectReviewerRawStructuredOutputWithEnvelope,
  toLedgerRawFinding,
  type ReviewerRawIntakeContext,
} from './raw-canonicalization.js';
import {
  RAW_FINDING_LIMITS,
  checkReviewerEnvelope,
  findRawFieldLimitViolation,
} from './raw-finding-limits.js';
import type { RawNormalizationAuditRecord } from './store.js';
import type { FindingLedger } from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { createLogger } from '../../../shared/utils/index.js';
import { issueFindingEvidenceRequests } from './evidence-request-issuer.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import type { CanonicalFindingReviewPublication } from './review-publication.js';
import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../../models/finding-contract-limits.js';

const log = createLogger('finding-manager-intake');

/**
 * 「lifecycle のつもりで書かれた観察が new として取り込まれた」疑いを1行残す。
 *
 * 正規化係が lifecycle relation を付けるのは、1つの連続した claim 箇所に literal
 * token と対象 finding ID の両方がある場合だけ。レビュアーがその2つを別の文へ
 * 分けて書くと、claim は黙って new へ降格し、同じ指摘が別 finding として積み上がる。
 * engine から見える兆候は「relation=new なのに claim 本文が既存 finding の ID を
 * 名指している」ことなので、それだけを報告する（判定は変えない — 本文の意図を
 * engine が推測して lifecycle へ格上げすると、検証していない解消が通る）。
 */
function warnOnLifecycleClaimReadAsNew(
  canonical: { relation: unknown; rawFindingId: string; reviewer: string; rawExcerpt?: string; description?: string },
  previousLedger: FindingLedger,
): void {
  if (canonical.relation !== 'new') {
    return;
  }
  const claimText = `${canonical.rawExcerpt ?? ''}\n${canonical.description ?? ''}`;
  const referenced = previousLedger.findings
    .filter((finding) => claimText.includes(finding.id))
    .map((finding) => finding.id);
  if (referenced.length === 0) {
    return;
  }
  log.warn(
    'Claim naming an existing finding was admitted as new; the lifecycle token and the finding ID may be in separate sentences',
    {
      rawFindingId: canonical.rawFindingId,
      reviewer: canonical.reviewer,
      referencedFindingIds: referenced,
    },
  );
}

export interface FindingManagerSubStepResult {
  subStep: AgentWorkflowStep;
  publication: CanonicalFindingReviewPublication;
  relationClarification?: ReviewerRelationClarification;
  /**
   * この publication が後続レビューとして何を成立させたか（既定 `verdict`）。
   *
   * - `verdict`: workflow のレビューステップ本体。判定ラダーを通るので verdict を伴う
   * - `review`: 差し戻し slot のフルレビュー。完全なレビューだが判定ラダーを持たないので
   *   verdict は無い
   * - `none`: 言い直しだけの差し戻し呼び出し。レビューとして成立していない
   *
   * 後続レビュー成立による取り下げ（withdrawReviewerAnomaliesSupersededByReview）が
   * これを根拠にする。verdict 由来の anomaly（verdict-claims-mismatch）は verdict を
   * 伴う publication でしか決着しない — verdict の無い再レビューで取り下げると、
   * 「非承認判定 + claim ゼロ件」を検出するゲートそのものが再レビューで洗い流される。
   */
  reviewEvidence?: 'verdict' | 'review' | 'none';
}

function recordReviewerOutputOverflow(input: {
  result: ReviewerIntakeResult;
  reviewer: string;
  reviewerStableKey: string;
  reason: string;
  emittedAtomizedRawFindingCount: number;
  admittedAtomizedRawFindingCount: number;
}): void {
  const overflowAtomizedRawFindingCount = input.emittedAtomizedRawFindingCount
    - input.admittedAtomizedRawFindingCount;
  const stableKey = computeOverflowStableKey(input.reviewerStableKey);
  const description = `Reviewer "${input.reviewer}" output exceeded Finding Contract limits: ${input.reason}`;
  input.result.overflowReports.push({
    reviewer: input.reviewer,
    reason: input.reason,
    emittedAtomizedRawFindingCount: input.emittedAtomizedRawFindingCount,
    admittedAtomizedRawFindingCount: input.admittedAtomizedRawFindingCount,
    overflowAtomizedRawFindingCount,
  });
  input.result.intakeProvisionalSpecs.push({
    kind: 'reviewer-output-overflow',
    stableKey,
    lineageKey: stableKey,
    sourceRawFindingIds: [],
    reason: description,
    title: 'Reviewer output exceeded Finding Contract limits',
    severity: 'high',
    description,
    reviewers: [input.reviewer],
    recoveryReviewerStableKey: input.reviewerStableKey,
  });
  log.warn('Reviewer output exceeded Finding Contract limits; recorded bounded overflow', {
    reviewer: input.reviewer,
    reason: input.reason,
    emittedAtomizedRawFindingCount: input.emittedAtomizedRawFindingCount,
    admittedAtomizedRawFindingCount: input.admittedAtomizedRawFindingCount,
    overflowAtomizedRawFindingCount,
  });
}

export function intakeReviewerOutputs(input: {
  subResults: readonly FindingManagerSubStepResult[];
  previousLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
  runId: string;
  workflowTask: string;
  cwd: string;
  scopeIdentity: string;
  issuedAt: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): ReviewerIntakeResult {
  const authoritativeTargetByFindingId = new Map(
    input.previousLedger.findings.map((finding) => [
      finding.id,
      finding.target === null ? null : structuredClone(finding.target),
    ] as const),
  );
  const result: ReviewerIntakeResult = {
    items: [],
    entityBindings: new Map(),
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    intakeAnomalySpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
  let admittedAtomizedCount = 0;
  let admittedBytes = 0;
  let issuedStepQuoteBytes = 0;

  for (const subResult of input.subResults) {
    let issuedReviewerQuoteBytes = 0;
    const items = [...subResult.publication.rawFindings];
    const resourceEnvelope = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: items,
    }).resourceEnvelope;
    if (
      resourceEnvelope.itemCount !== items.length
      || resourceEnvelope.itemSourceBytes.length !== items.length
    ) {
      throw new Error(
        `Finding contract reviewer "${subResult.subStep.name}" resource envelope does not match rawFindings`,
      );
    }
    const context: ReviewerRawIntakeContext = {
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      runId: input.runId,
      reviewerStepName: subResult.subStep.name,
      reportName: subResult.publication.reportName,
      reviewerPersonaKey: (subResult.subStep as { persona?: string }).persona ?? subResult.subStep.name,
      reviewReport: subResult.publication.reportContent,
      ledger: input.previousLedger,
      authoritativeTargetByFindingId,
      issueEvidenceRequests: (request) => {
        const issued = issueFindingEvidenceRequests({
          cwd: input.cwd,
          snapshot: input.reviewScopeSnapshot,
          workflowName: input.workflowName,
          runId: input.runId,
          scopeIdentity: input.scopeIdentity,
          workflowTask: input.workflowTask,
          issuedAt: input.issuedAt,
        }, {
          ...request,
          quoteByteBudget: {
            reviewerRemainingBytes: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxReviewerBytes
              - issuedReviewerQuoteBytes,
            stepRemainingBytes: FINDING_EVIDENCE_ISSUANCE_LIMITS.maxStepBytes
              - issuedStepQuoteBytes,
          },
        });
        return issued;
      },
      commitEvidenceIssuance: (materializedQuoteBytes) => {
        issuedReviewerQuoteBytes += materializedQuoteBytes;
        issuedStepQuoteBytes += materializedQuoteBytes;
      },
    };
    if (subResult.relationClarification !== undefined) {
      result.clarifications.push({
        reviewer: subResult.subStep.name,
        flaggedRawFindingIds: subResult.relationClarification.flaggedRawFindingIds,
      });
    }

    // publication 境界で件数を bounded 化済み。ここでは field と step 合算を再検査する。
    const jsonBytes = resourceEnvelope.jsonBytes;
    const lenientFields = items.map(extractLenientRawFields);
    const atomizedItemCount = lenientFields.reduce(
      (total, fields) => total + Math.max(1, fields.targetFindingIds?.length ?? 0),
      0,
    );
    const envelopeViolation = checkReviewerEnvelope({
      itemCount: resourceEnvelope.itemCount,
      atomizedItemCount,
      jsonBytes,
    });
    const fieldViolation = envelopeViolation === undefined
      ? lenientFields.map(findRawFieldLimitViolation).find((violation) => violation !== undefined)
      : undefined;
    const wouldExceedStep = envelopeViolation === undefined && fieldViolation === undefined
      && (admittedAtomizedCount + atomizedItemCount > RAW_FINDING_LIMITS.maxRawFindingsPerStep
        || admittedBytes + jsonBytes > RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes);
    const overflowReason = envelopeViolation?.reason
      ?? (fieldViolation !== undefined ? `a raw finding field exceeded its limit: ${fieldViolation}` : undefined)
      ?? (wouldExceedStep
        ? `admitting this reviewer's ${atomizedItemCount} atomized raw findings (${jsonBytes} bytes) would exceed the per-step limits (${RAW_FINDING_LIMITS.maxRawFindingsPerStep} findings / ${RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes} bytes)`
        : undefined);

    const reviewerStableKey = computeReviewerStableKey({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      reviewerPersonaKey: context.reviewerPersonaKey,
    });
    const publicationOverflow = subResult.publication.reviewerOutputOverflow;
    if (overflowReason !== undefined) {
      recordReviewerOutputOverflow({
        result,
        reviewer: subResult.subStep.name,
        reviewerStableKey,
        reason: overflowReason,
        emittedAtomizedRawFindingCount: publicationOverflow
          ?.emittedAtomizedRawFindingCount ?? atomizedItemCount,
        admittedAtomizedRawFindingCount: 0,
      });
      continue;
    }

    if (publicationOverflow !== undefined) {
      recordReviewerOutputOverflow({
        result,
        reviewer: subResult.subStep.name,
        reviewerStableKey,
        reason: publicationOverflow.reason,
        emittedAtomizedRawFindingCount:
          publicationOverflow.emittedAtomizedRawFindingCount,
        admittedAtomizedRawFindingCount:
          publicationOverflow.admittedAtomizedRawFindingCount,
      });
    }

    admittedAtomizedCount += atomizedItemCount;
    admittedBytes += jsonBytes;
    if (publicationOverflow === undefined) {
      result.healthyReviewerStableKeys.add(reviewerStableKey);
    }
    const candidateBatch = createReviewerRawFindingCandidates(items, context, resourceEnvelope);
    for (const rejection of candidateBatch.rejections) {
      const lineageKey = rejection.lineageKey
        ?? createHash('sha256').update(JSON.stringify({
          domain: 'finding-normalizer-extraction-rejection',
          intakeId: rejection.intakeId,
          reviewerStableKey: rejection.reviewerStableKey,
          reason: rejection.reason,
        })).digest('hex');
      result.intakeAnomalySpecs.push({
        kind: 'protocol-anomaly',
        stableKey: computeReviewerAnomalyStableKey({
          reviewerStableKey: rejection.reviewerStableKey,
          lineageKey,
          anomalyKind: 'protocol-anomaly',
        }),
        lineageKey,
        sourceRawFindingIds: [],
        sourceIntakeIds: [rejection.intakeId],
        reviewers: [rejection.reviewer],
        title: `Unbound reviewer extraction ${rejection.intakeId}`,
        ...(rejection.claimedExcerpt !== undefined
          ? { claimedExcerpt: rejection.claimedExcerpt }
          : {}),
        mismatchReason: rejection.reason,
      });
    }
    const candidates = candidateBatch.candidates;
    const clarification = subResult.relationClarification;
    for (const candidate of candidates) {
      const priorCodes = clarification !== undefined
        && candidate.sourceReviewerRawFindingId !== undefined
        && Object.hasOwn(clarification.priorAmbiguityCodesByRawId, candidate.sourceReviewerRawFindingId)
        ? clarification.priorAmbiguityCodesByRawId[candidate.sourceReviewerRawFindingId]
        : undefined;
      const canonicalized = canonicalizeReviewerRawFinding(candidate, {
        ledger: input.previousLedger,
        ...(clarification !== undefined ? { clarificationAttempted: true } : {}),
        ...(priorCodes !== undefined ? { priorAmbiguityCodes: priorCodes } : {}),
      });
      const canonical = canonicalized.canonical;
      const wire = toLedgerRawFinding(canonical);
      result.items.push({ canonical, wire });

      // 正規化監査（変換が起きた raw のみ）: 元の主張は candidate 側にしか無く、
      // wire は identity を汚さないために正規化後の整合ペアだけを持つ。
      const normalizations: RawNormalizationAuditRecord['normalizations'] = [];
      if (candidate.relation !== canonical.relation) {
        normalizations.push('relation-normalized');
      }
      if (candidate.targetFindingId !== undefined && wire.targetFindingId === null) {
        normalizations.push('target-dropped-from-wire');
      }
      if (candidate.title === undefined || candidate.description === undefined
        || candidate.severity === undefined || candidate.familyTag === undefined) {
        normalizations.push('required-fields-missing');
      }
      warnOnLifecycleClaimReadAsNew(canonical, input.previousLedger);
      if (normalizations.length > 0 || canonical.provenance.ambiguityCodes.length > 0) {
        result.rawNormalizations.push({
          rawFindingId: canonical.rawFindingId,
          reviewer: canonical.reviewer,
          ...(candidate.relation !== undefined ? { claimedRelation: candidate.relation } : {}),
          ...(candidate.targetFindingId !== undefined ? { claimedTargetFindingId: candidate.targetFindingId } : {}),
          normalizedRelation: canonical.relation,
          ...(wire.targetFindingId !== null ? { wireTargetFindingId: wire.targetFindingId } : {}),
          ambiguityCodes: [...canonical.provenance.ambiguityCodes],
          normalizations,
        });
      }
    }
  }
  return result;
}
