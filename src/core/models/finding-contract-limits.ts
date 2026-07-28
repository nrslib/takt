/**
 * Finding Contract の文字列フィールド上限。
 *
 * 未信頼 provider 出力の pre-parse 検査、Zod runtime schema、
 * provider-facing JSON Schema の全経路でこの正本を共有する。
 */
export const RAW_FINDING_FIELD_LIMITS = {
  maxRawFindingIdChars: 128,
  maxFamilyTagChars: 128,
  maxTitleChars: 512,
  maxEvidencePathChars: 1024,
  maxDescriptionChars: 8192,
  maxSuggestionChars: 8192,
  maxVerbatimExcerptChars: 8192,
  /** snapshotId / proofId は SHA-256 content address の64桁 hex。 */
  maxSnapshotIdChars: 64,
  maxProofIdChars: 64,
} as const;
