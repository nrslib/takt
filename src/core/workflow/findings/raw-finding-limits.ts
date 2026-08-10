/**
 * Finding Contract のハード上限。正常時が数件〜十数件、
 * 暴走時が435件という実測から、正常値の約4倍以上を許容しつつ暴走を早期遮断する。
 *
 * reviewer 件数超過は publication 境界で atomized 64件までを intake 対象にし、
 * 超過件数を reviewer-output-overflow provisional と report に残す。byte・field・
 * step envelope 違反は reviewer 全体を単一 overflow provisional に置き換える。
 */
import {
  RAW_FINDING_FIELD_LIMITS,
  RAW_FINDING_NORMALIZER_LIMITS,
} from '../../models/finding-contract-limits.js';

export const RAW_FINDING_LIMITS = {
  /** raw 件数 / reviewer / review invocation */
  maxRawFindingsPerReviewer: 64,
  /** raw 件数 / reconciliation step 全体 */
  maxRawFindingsPerStep: 128,
  /** reviewer rawFindings JSON バイト数 */
  maxReviewerRawFindingsJsonBytes: 256 * 1024,
  /** reconciliation step 全 raw JSON バイト数 */
  maxStepRawFindingsJsonBytes: 512 * 1024,
  ...RAW_FINDING_FIELD_LIMITS,
  ...RAW_FINDING_NORMALIZER_LIMITS,
  /** reviewer correction は reviewer あたり1回 */
  maxReviewerCorrectionsPerReviewer: 1,
  /** correction 出力の上限（output tokens 近似） */
  maxCorrectionOutputTokens: 2048,
} as const;

export const MANAGER_INTERPRETATION_LIMITS = {
  /** ambiguous candidates / batch */
  maxAmbiguousCandidatesPerBatch: 16,
  /** manager calls / reconciliation step */
  maxManagerCallsPerStep: 4,
  /** 解釈対象 / step */
  maxInterpretationTargetsPerStep: 64,
  /** adapter-visible UTF-8 bytes / call */
  maxInputBytesPerCall: 24_000,
  /** input tokens / step */
  maxInputTokensPerStep: 64_000,
  /** output tokens / call */
  maxOutputTokensPerCall: 2_048,
  /** output tokens / step */
  maxOutputTokensPerStep: 8_192,
  /** manager semantic retry は 0回（reviewer correction 1回が唯一の再問い合わせ枠） */
  maxManagerSemanticRetries: 0,
  /** 自動解釈 epoch / lineage */
  maxInterpretationEpochsPerLineage: 2,
} as const;

/**
 * conflict adjudication は想定する 10 subjects と長大な ID 集合を 1 呼び出しで
 * 扱うため、実測した 27,279 bytes のリクエストにプロンプト差分の余裕を加えた
 * 96 KiB を上限とする。128K コンテキスト級モデルに合わせた値だが、これは暴走を
 * 防止する guard であり、入力が無制限になるわけではないため有界性は維持する。
 */
export const CONFLICT_ADJUDICATION_INPUT_MAX_BYTES = 98_304;

export const MANAGER_ACTION_RECOVERY_LIMITS = {
  maxAttempts: 2,
} as const;

export const REVIEWER_ENVELOPE_RECOVERY_LIMITS = {
  maxUnavailableRounds: 2,
} as const;

/**
 * トークン概算。provider 非依存の保守的近似（1 token ≒ 4 bytes）。
 *
 * これは計測・ログとバッチ縮小の判断材料であって、ハード上限ではない
 * （synthetic-step requirement）。出力サイズのハード上限は structured output schema 自体の
 * maxItems / maxLength（AmbiguousInterpretationsOutputJsonSchema）が構造的に
 * 保証する。入力側は送信前にこの概算で遮断する（送らなければ消費されない）。
 * 概算超過の応答を受信後に不採用 → provisional にする既存の検査は、schema を
 * 強制できない provider 向けの防御線として残す。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

export interface ReviewerEnvelopeViolation {
  reason: string;
}

/**
 * reviewer 1体の rawFindings 出力の envelope 検査（parse 前）。
 * `items` は未検証の配列（Zod parse 前）、`jsonBytes` はその JSON 表現の byte 数。
 */
export function checkReviewerEnvelope(input: {
  itemCount: number;
  atomizedItemCount: number;
  jsonBytes: number;
}): ReviewerEnvelopeViolation | undefined {
  if (input.itemCount > RAW_FINDING_LIMITS.maxRawFindingsPerReviewer) {
    return {
      reason: `reviewer emitted ${input.itemCount} raw findings, exceeding the per-reviewer limit of ${RAW_FINDING_LIMITS.maxRawFindingsPerReviewer}`,
    };
  }
  if (input.atomizedItemCount > RAW_FINDING_LIMITS.maxRawFindingsPerReviewer) {
    return {
      reason: `reviewer emitted ${input.atomizedItemCount} atomized raw findings, exceeding the per-reviewer limit of ${RAW_FINDING_LIMITS.maxRawFindingsPerReviewer}`,
    };
  }
  if (input.jsonBytes > RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes) {
    return {
      reason: `reviewer rawFindings JSON is ${input.jsonBytes} bytes, exceeding the per-reviewer limit of ${RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes} bytes`,
    };
  }
  return undefined;
}

/**
 * step 全体（全 reviewer 合算）の envelope 検査。超過した場合、呼び出し元は
 * 超過を発生させた reviewer 単位で overflow に置き換える（正常 reviewer の raw は
 * 処理を続ける）。
 */
export function checkStepEnvelope(input: {
  totalItemCount: number;
  totalJsonBytes: number;
}): ReviewerEnvelopeViolation | undefined {
  if (input.totalItemCount > RAW_FINDING_LIMITS.maxRawFindingsPerStep) {
    return {
      reason: `step emitted ${input.totalItemCount} raw findings in total, exceeding the per-step limit of ${RAW_FINDING_LIMITS.maxRawFindingsPerStep}`,
    };
  }
  if (input.totalJsonBytes > RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes) {
    return {
      reason: `step rawFindings JSON is ${input.totalJsonBytes} bytes in total, exceeding the per-step limit of ${RAW_FINDING_LIMITS.maxStepRawFindingsJsonBytes} bytes`,
    };
  }
  return undefined;
}

/**
 * raw 1件の文字列フィールド上限検査。1件でも違反があればその reviewer の出力
 * 全体が overflow になる（部分採用しない）。
 */
export function findRawFieldLimitViolation(fields: {
  rawFindingId?: string;
  familyTag?: string;
  title?: string;
  description?: string;
  suggestion?: string;
  evidence?: readonly unknown[];
  rawExcerpt?: string;
  targetFindingIds?: readonly string[];
  targetFindingIdCount?: number;
  evidenceRequests?: readonly unknown[];
}): string | undefined {
  const checks: Array<[string, string | undefined, number]> = [
    [
      'rawFindingId',
      fields.rawFindingId,
      RAW_FINDING_LIMITS.maxProviderRawFindingIdChars,
    ],
    ['familyTag', fields.familyTag, RAW_FINDING_LIMITS.maxFamilyTagChars],
    ['title', fields.title, RAW_FINDING_LIMITS.maxTitleChars],
    ['description', fields.description, RAW_FINDING_LIMITS.maxDescriptionChars],
    ['suggestion', fields.suggestion, RAW_FINDING_LIMITS.maxSuggestionChars],
    ['rawExcerpt', fields.rawExcerpt, RAW_FINDING_LIMITS.maxDescriptionChars],
  ];
  for (const [name, value, limit] of checks) {
    if (value !== undefined && value.length > limit) {
      return `${name} is ${value.length} characters, exceeding the limit of ${limit}`;
    }
  }
  if (
    (fields.targetFindingIdCount ?? 0)
    > RAW_FINDING_LIMITS.maxTargetFindingIdsPerCandidate
  ) {
    return `targetFindingIds has ${fields.targetFindingIdCount} items, exceeding the limit of ${RAW_FINDING_LIMITS.maxTargetFindingIdsPerCandidate}`;
  }
  for (const [index, targetFindingId] of (fields.targetFindingIds ?? []).entries()) {
    if (targetFindingId.length > RAW_FINDING_LIMITS.maxFindingIdChars) {
      return `targetFindingIds[${index}] is ${targetFindingId.length} characters, exceeding the limit of ${RAW_FINDING_LIMITS.maxFindingIdChars}`;
    }
  }
  for (const [index, evidence] of (
    fields.evidenceRequests ?? fields.evidence ?? []
  ).entries()) {
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
      continue;
    }
    const record = evidence as Record<string, unknown>;
    const evidenceChecks: Array<[string, unknown, number]> = record.kind === 'file_quote'
      ? [
          [`evidence[${index}].path`, record.path, RAW_FINDING_LIMITS.maxEvidencePathChars],
          [`evidence[${index}].verbatimExcerpt`, record.verbatimExcerpt, RAW_FINDING_LIMITS.maxVerbatimExcerptBytes],
        ]
      : [];
    for (const [name, value, limit] of evidenceChecks) {
      if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > limit) {
        return `${name} is ${Buffer.byteLength(value, 'utf8')} UTF-8 bytes, exceeding the limit of ${limit}`;
      }
    }
  }
  return undefined;
}
