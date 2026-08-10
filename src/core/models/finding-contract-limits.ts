/**
 * Finding Contract の文字列フィールド上限。
 *
 * 未信頼 provider 出力の pre-parse 検査、Zod runtime schema、
 * provider-facing JSON Schema の全経路でこの正本を共有する。
 */
export const RAW_FINDING_FIELD_LIMITS = {
  maxProviderRawFindingIdChars: 256,
  maxWireRawFindingIdChars: 4096,
  maxFindingIdChars: 128,
  maxFamilyTagChars: 128,
  maxTitleChars: 512,
  maxEvidencePathChars: 1024,
  maxDescriptionChars: 8192,
  maxSuggestionChars: 8192,
  maxVerbatimExcerptChars: 8192,
  maxVerbatimExcerptBytes: 1024,
  /** snapshotId / proofId は SHA-256 content address の64桁 hex。 */
  maxSnapshotIdChars: 64,
  maxProofIdChars: 64,
} as const;

export const RAW_FINDING_NORMALIZER_LIMITS = {
  /** 1 extraction が atomize できる lifecycle target 数。 */
  maxTargetFindingIdsPerCandidate: 64,
} as const;

export const FINDING_EVIDENCE_ISSUANCE_LIMITS = {
  maxFileQuoteLines: 200,
  maxFileQuoteBytes: RAW_FINDING_FIELD_LIMITS.maxVerbatimExcerptBytes,
  maxSourceFileBytes: 1024 * 1024,
  maxReviewerBytes: 256 * 1024,
  maxStepBytes: 512 * 1024,
} as const;
