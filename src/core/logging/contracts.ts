import type { RuleMatchMethod } from '../models/status.js';

export const PROVIDER_EVENTS_LOG_FILE_SUFFIX = '-provider-events.jsonl';
export const USAGE_EVENTS_LOG_FILE_SUFFIX = '-usage-events.jsonl';
export const PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX = '-usage-events.phase.jsonl';

export const USAGE_MISSING_REASONS = {
  NOT_AVAILABLE: 'usage_not_available',
  TOKENS_MISSING: 'usage_tokens_missing',
  NOT_SUPPORTED_BY_PROVIDER: 'usage_not_supported_by_provider',
} as const;

export type UsageMissingReason =
  (typeof USAGE_MISSING_REASONS)[keyof typeof USAGE_MISSING_REASONS];

export type JudgmentMatchMethod = 'structured_output' | 'ai_judge' | 'tag_fallback';

export function toJudgmentMatchMethod(
  matchedRuleMethod: RuleMatchMethod | undefined,
): JudgmentMatchMethod | undefined {
  switch (matchedRuleMethod) {
    case 'structured_output':
    case 'ai_judge':
      return matchedRuleMethod;
    case 'phase3_tag':
      return 'tag_fallback';
    default:
      return undefined;
  }
}
