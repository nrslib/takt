import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { ProviderUsageSnapshot } from '../../core/models/response.js';

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function extractClaudeProviderUsage(rawUsage: unknown): ProviderUsageSnapshot | undefined {
  const usage = toRecord(rawUsage);
  if (!usage) {
    return undefined;
  }

  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheCreationInputTokens = toNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = toNumber(usage.cache_read_input_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.TOKENS_MISSING,
    };
  }

  const providerUsage: ProviderUsageSnapshot = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usageMissing: false,
  };
  const cachedInputTokens = cacheCreationInputTokens !== undefined && cacheReadInputTokens !== undefined
    ? cacheCreationInputTokens + cacheReadInputTokens
    : cacheReadInputTokens ?? cacheCreationInputTokens;
  if (cachedInputTokens !== undefined) {
    providerUsage.cachedInputTokens = cachedInputTokens;
  }
  if (cacheCreationInputTokens !== undefined) {
    providerUsage.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (cacheReadInputTokens !== undefined) {
    providerUsage.cacheReadInputTokens = cacheReadInputTokens;
  }
  return providerUsage;
}
