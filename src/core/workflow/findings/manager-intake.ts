import type { AgentResponse, WorkflowStep } from '../../models/types.js';
import { classifyLocationAdmissionNormalization } from './admission-validation.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import {
  canonicalizeReviewerRawFinding,
  computeOverflowStableKey,
  computeReviewerStableKey,
  createOverflowRawCandidate,
  createReviewerRawFindingCandidates,
  extractLenientRawFields,
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
import { isWorkflowCallStep } from '../step-kind.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('finding-manager-intake');

export interface FindingManagerSubStepResult {
  subStep: WorkflowStep;
  response: AgentResponse;
  relationClarification?: ReviewerRelationClarification;
}

export function intakeReviewerOutputs(input: {
  subResults: readonly FindingManagerSubStepResult[];
  previousLedger: FindingLedger;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
  stepIteration: number;
  runId: string;
}): ReviewerIntakeResult {
  const result: ReviewerIntakeResult = {
    items: [],
    overflowRawFindingIds: new Set(),
    overflowSpecs: [],
    overflowReports: [],
    clarifications: [],
    rawNormalizations: [],
    healthyReviewerStableKeys: new Set(),
  };
  let admittedCount = 0;
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
    const context: ReviewerRawIntakeContext = {
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      runId: input.runId,
      reviewerStepName: subResult.subStep.name,
      reviewerPersonaKey: (subResult.subStep as { persona?: string }).persona ?? subResult.subStep.name,
    };
    if (subResult.relationClarification !== undefined) {
      result.clarifications.push({
        reviewer: subResult.subStep.name,
        flaggedRawFindingIds: subResult.relationClarification.flaggedRawFindingIds,
      });
    }

    // envelope 検査は Zod parse の前（65件目を読んだ時点で打ち切る）。
    const jsonBytes = Buffer.byteLength(JSON.stringify(items), 'utf-8');
    const envelopeViolation = checkReviewerEnvelope({ itemCount: items.length, jsonBytes });
    const fieldViolation = envelopeViolation === undefined
      ? items.map((item) => findRawFieldLimitViolation(extractLenientRawFields(item))).find((violation) => violation !== undefined)
      : undefined;
    const wouldExceedStep = envelopeViolation === undefined && fieldViolation === undefined
      && (admittedCount + items.length > RAW_FINDING_LIMITS.maxRawFindingsPerStep
        || admittedBytes + jsonBytes > RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes);
    const overflowReason = envelopeViolation?.reason
      ?? (fieldViolation !== undefined ? `a raw finding field exceeded its limit: ${fieldViolation}` : undefined)
      ?? (wouldExceedStep
        ? `admitting this reviewer's ${items.length} raw findings (${jsonBytes} bytes) would exceed the per-step limits (${RAW_FINDING_LIMITS.maxRawFindingsPerStep} findings / ${RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes} bytes)`
        : undefined);

    if (overflowReason !== undefined) {
      // 部分採用しない: この reviewer の全 raw を単一 overflow provisional に置換。
      const candidate = createOverflowRawCandidate({
        context,
        reason: `Reviewer "${subResult.subStep.name}" output exceeded Finding Contract limits: ${overflowReason}`,
      });
      const canonicalized = canonicalizeReviewerRawFinding(candidate, { ledger: input.previousLedger });
      const canonical = canonicalized.canonical;
      const wire = toLedgerRawFinding(canonical);
      result.items.push({ canonical, wire });
      result.overflowRawFindingIds.add(canonical.rawFindingId);
      result.overflowReports.push({ reviewer: subResult.subStep.name, reason: overflowReason });
      result.overflowSpecs.push({
        kind: 'reviewer-output-overflow',
        stableKey: computeOverflowStableKey(canonical.reviewerStableKey),
        lineageKey: canonical.lineageKey,
        sourceRawFindingIds: [canonical.rawFindingId],
        reason: wire.description,
        title: 'Reviewer output exceeded Finding Contract limits',
        severity: 'high',
        description: wire.description,
        reviewers: [subResult.subStep.name],
        recoveryReviewerStableKey: canonical.reviewerStableKey,
      });
      log.warn('Reviewer output exceeded Finding Contract limits; replaced with a single overflow provisional', {
        reviewer: subResult.subStep.name,
        reason: overflowReason,
      });
      continue;
    }

    admittedCount += items.length;
    admittedBytes += jsonBytes;
    result.healthyReviewerStableKeys.add(computeReviewerStableKey({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      reviewerPersonaKey: context.reviewerPersonaKey,
    }));
    const candidates = createReviewerRawFindingCandidates(items, context);
    const clarification = subResult.relationClarification;
    for (const candidate of candidates) {
      const priorCodes = clarification !== undefined
        && candidate.reviewerRawFindingId !== undefined
        && Object.hasOwn(clarification.priorAmbiguityCodesByRawId, candidate.reviewerRawFindingId)
        ? clarification.priorAmbiguityCodesByRawId[candidate.reviewerRawFindingId]
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
      // location の機械正規化（行範囲解釈 / N/A → locationless）の適用事実。
      const locationNormalization = classifyLocationAdmissionNormalization(candidate.location);
      if (locationNormalization !== undefined) {
        normalizations.push(locationNormalization);
      }
      if (candidate.targetFindingId !== undefined && wire.targetFindingId === undefined) {
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
          ...(wire.targetFindingId !== undefined ? { wireTargetFindingId: wire.targetFindingId } : {}),
          ambiguityCodes: [...canonical.provenance.ambiguityCodes],
          normalizations,
        });
      }
    }
  }
  return result;
}
