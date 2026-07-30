import { createHash } from 'node:crypto';
import type { AgentResponse, WorkflowStep } from '../../models/types.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import {
  canonicalizeReviewerRawFinding,
  computeOverflowStableKey,
  computeProvisionalStableKey,
  computeReviewerStableKey,
  createReviewerRawFindingCandidates,
  extractLenientRawFields,
  projectReviewerRawStructuredOutputWithEnvelope,
  toLedgerRawFinding,
  type ReviewerRawResourceEnvelope,
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
import { isWorkflowCallStep } from '../step-kind.js';
import { createLogger } from '../../../shared/utils/index.js';
import { issueFindingEvidenceRequests } from './evidence-request-issuer.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

const log = createLogger('finding-manager-intake');

export interface FindingManagerSubStepResult {
  subStep: WorkflowStep;
  response: AgentResponse;
  relationClarification?: ReviewerRelationClarification;
  reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
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
    input.previousLedger.findings.flatMap((finding) => (
      finding.provisional === undefined && finding.target !== null
        ? [[finding.id, structuredClone(finding.target)] as const]
        : []
    )),
  );
  const result: ReviewerIntakeResult = {
    items: [],
    entityBindings: new Map(),
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
  let admittedAtomizedCount = 0;
  let admittedBytes = 0;

  for (const subResult of input.subResults) {
    // workflow_call サブステップは raw findings を返さない（子ワークフロー側で
    // 取り込み済み）ため除外する。
    if (isWorkflowCallStep(subResult.subStep)) {
      continue;
    }
    const structuredOutput = subResult.response.structuredOutput;
    // raw findings は Finding Contract の契約入力。構造化出力自体の欠落は raw の
    // 意味矛盾ではなく provider / contract 障害なので従来どおり fail-fast する。
    if (structuredOutput === undefined) {
      throw new Error(
        `Finding contract reviewer "${subResult.subStep.name}" returned no structured output; raw findings are required`,
      );
    }
    if (!Array.isArray(structuredOutput.rawFindings)) {
      throw new Error(
        `Finding contract reviewer "${subResult.subStep.name}" returned structured output without a rawFindings array`,
      );
    }
    const items = structuredOutput.rawFindings as unknown[];
    const resourceEnvelope = subResult.reviewerRawResourceEnvelope
      ?? projectReviewerRawStructuredOutputWithEnvelope({
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
      reviewerPersonaKey: (subResult.subStep as { persona?: string }).persona ?? subResult.subStep.name,
      reviewReport: subResult.response.content,
      authoritativeTargetByFindingId,
      issueEvidenceRequests: (request) => issueFindingEvidenceRequests({
        snapshot: input.reviewScopeSnapshot,
        workflowName: input.workflowName,
        runId: input.runId,
        scopeIdentity: input.scopeIdentity,
        workflowTask: input.workflowTask,
        issuedAt: input.issuedAt,
      }, request),
    };
    if (subResult.relationClarification !== undefined) {
      result.clarifications.push({
        reviewer: subResult.subStep.name,
        flaggedRawFindingIds: subResult.relationClarification.flaggedRawFindingIds,
      });
    }

    // envelope 検査は Zod parse の前（65件目を読んだ時点で打ち切る）。
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

    if (overflowReason !== undefined) {
      // 部分採用しない: この reviewer の全 raw を単一 overflow provisional に置換。
      const reviewerStableKey = computeReviewerStableKey({
        workflowName: input.workflowName,
        callNamespace: input.callNamespace,
        parentStepName: input.parentStepName,
        reviewerPersonaKey: context.reviewerPersonaKey,
      });
      const stableKey = computeOverflowStableKey(reviewerStableKey);
      const description = `Reviewer "${subResult.subStep.name}" output exceeded Finding Contract limits: ${overflowReason}`;
      result.overflowReports.push({ reviewer: subResult.subStep.name, reason: overflowReason });
      result.intakeProvisionalSpecs.push({
        kind: 'reviewer-output-overflow',
        stableKey,
        lineageKey: stableKey,
        sourceRawFindingIds: [],
        reason: description,
        title: 'Reviewer output exceeded Finding Contract limits',
        severity: 'high',
        description,
        reviewers: [subResult.subStep.name],
        recoveryReviewerStableKey: reviewerStableKey,
      });
      log.warn('Reviewer output exceeded Finding Contract limits; replaced with a single overflow provisional', {
        reviewer: subResult.subStep.name,
        reason: overflowReason,
      });
      continue;
    }

    admittedAtomizedCount += atomizedItemCount;
    admittedBytes += jsonBytes;
    result.healthyReviewerStableKeys.add(computeReviewerStableKey({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      reviewerPersonaKey: context.reviewerPersonaKey,
    }));
    const candidateBatch = createReviewerRawFindingCandidates(items, context, resourceEnvelope);
    for (const rejection of candidateBatch.rejections) {
      const lineageKey = createHash('sha256').update(JSON.stringify({
        domain: 'finding-normalizer-extraction-rejection',
        intakeId: rejection.intakeId,
        reviewerStableKey: rejection.reviewerStableKey,
        reason: rejection.reason,
      })).digest('hex');
      result.intakeProvisionalSpecs.push({
        kind: 'raw-adjudication-unresolved',
        stableKey: computeProvisionalStableKey({
          reviewerStableKey: rejection.reviewerStableKey,
          lineageKey,
          provisionalKind: 'raw-adjudication-unresolved',
        }),
        lineageKey,
        sourceRawFindingIds: [],
        reason: rejection.reason,
        title: `Unbound reviewer extraction ${rejection.intakeId}`,
        severity: 'high',
        description: rejection.reason,
        reviewers: [rejection.reviewer],
        recoveryReviewerStableKey: rejection.reviewerStableKey,
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
