export const PROVIDER_EVENTS_LOG_FILE_SUFFIX = '-provider-events.jsonl';
export const USAGE_EVENTS_LOG_FILE_SUFFIX = '-usage-events.jsonl';

export const USAGE_MISSING_REASONS = {
  NOT_AVAILABLE: 'usage_not_available',
  TOKENS_MISSING: 'usage_tokens_missing',
  NOT_SUPPORTED_BY_PROVIDER: 'usage_not_supported_by_provider',
} as const;

export type UsageMissingReason =
  (typeof USAGE_MISSING_REASONS)[keyof typeof USAGE_MISSING_REASONS];
