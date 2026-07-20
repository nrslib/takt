/**
 * Finding Contract のハード上限。正常時が数件〜十数件、
 * 暴走時が435件という実測から、正常値の約4倍以上を許容しつつ暴走を早期遮断する。
 *
 * 1項目でも超過した reviewer 出力は部分採用しない: その reviewer の全 raw を
 * 単一の reviewer-output-overflow provisional に置き換える（先頭N件の部分採用は
 * 「やるな」リスト該当）。件数・byte の envelope 検査は巨大 JSON 全体を Zod
 * parse する前に行う（435件なら65件目を読んだ時点で打ち切る）。
 */

export const RAW_FINDING_LIMITS = {
  /** raw 件数 / reviewer / review invocation */
  maxRawFindingsPerReviewer: 64,
  /** raw 件数 / reconciliation step 全体 */
  maxRawFindingsPerStep: 128,
  /** reviewer rawFindings JSON バイト数 */
  maxReviewerRawFindingsJsonBytes: 256 * 1024,
  /** reconciliation step 全 raw JSON バイト数 */
  maxStepRawFindingsJsonBytes: 512 * 1024,
  maxRawFindingIdChars: 128,
  maxFamilyTagChars: 128,
  maxTitleChars: 512,
  maxLocationChars: 1024,
  maxDescriptionChars: 8192,
  maxSuggestionChars: 8192,
  /**
   * typed evidence protocol（review-integrity protocol）の verbatimExcerpt 上限。
   * admission-validation.ts の MAX_SOURCE_QUOTE_LINES（200行）と整合する
   * 概算バイト数 — 極端に広い引用（ファイル丸ごとの貼り付け等）を envelope
   * 検査（parse 前）の段階で早期遮断する、行数チェックとは別の防御線。
   */
  maxVerbatimExcerptChars: 8192,
  /** typed evidence protocol の snapshotId は不透明トークン（sha256 hex）なので短い。 */
  maxSnapshotIdChars: 128,
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
  /** input tokens / call */
  maxInputTokensPerCall: 24_000,
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
 * engine 主導の再裁定（RawAdjudicationRecovery）の上限。
 * maxReplayAttempts は「初回着地の失敗後に engine が再裁定を試みる回数」で、
 * 解釈 epoch（初回を含む解釈 attempt 総数）とは別カウンタ・別意味。
 * 枯渇後は dismiss 候補（内容の管轄裁定）へ回す。
 */
export const RAW_ADJUDICATION_RECOVERY_LIMITS = {
  maxReplayTargetsPerStep: 64,
  maxReplayCandidatesPerBatch: 16,
  maxManagerCallsPerStep: 4,
  maxInputTokensPerCall: 24_000,
  maxInputTokensPerStep: 64_000,
  maxOutputTokensPerCall: 2_048,
  maxOutputTokensPerStep: 8_192,
  maxReplayAttempts: 2,
} as const;

export const MANAGER_ACTION_RECOVERY_LIMITS = {
  maxAttempts: 2,
} as const;

export const REVIEWER_ENVELOPE_RECOVERY_LIMITS = {
  maxUnavailableRounds: 2,
} as const;

/** stable key / WAL のポリシー版数。上限・格子の互換が壊れる変更で上げる。 */
export const RAW_LADDER_POLICY_VERSION = 2 as const;

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
  jsonBytes: number;
}): ReviewerEnvelopeViolation | undefined {
  if (input.itemCount > RAW_FINDING_LIMITS.maxRawFindingsPerReviewer) {
    return {
      reason: `reviewer emitted ${input.itemCount} raw findings, exceeding the per-reviewer limit of ${RAW_FINDING_LIMITS.maxRawFindingsPerReviewer}`,
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
  location?: string;
  description?: string;
  suggestion?: string;
  verbatimExcerpt?: string;
  snapshotId?: string;
}): string | undefined {
  const checks: Array<[string, string | undefined, number]> = [
    ['rawFindingId', fields.rawFindingId, RAW_FINDING_LIMITS.maxRawFindingIdChars],
    ['familyTag', fields.familyTag, RAW_FINDING_LIMITS.maxFamilyTagChars],
    ['title', fields.title, RAW_FINDING_LIMITS.maxTitleChars],
    ['location', fields.location, RAW_FINDING_LIMITS.maxLocationChars],
    ['description', fields.description, RAW_FINDING_LIMITS.maxDescriptionChars],
    ['suggestion', fields.suggestion, RAW_FINDING_LIMITS.maxSuggestionChars],
    ['verbatimExcerpt', fields.verbatimExcerpt, RAW_FINDING_LIMITS.maxVerbatimExcerptChars],
    ['snapshotId', fields.snapshotId, RAW_FINDING_LIMITS.maxSnapshotIdChars],
  ];
  for (const [name, value, limit] of checks) {
    if (value !== undefined && value.length > limit) {
      return `${name} is ${value.length} characters, exceeding the limit of ${limit}`;
    }
  }
  return undefined;
}
