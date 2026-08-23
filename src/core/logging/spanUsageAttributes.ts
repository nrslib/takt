import type { ProviderUsageSnapshot } from '../models/response.js';
import {
  USAGE_MISSING_REASONS,
  type UsageMissingReason,
} from './contracts.js';

export function usageSnapshotFromSpanAttributes(attributes: Record<string, unknown>): ProviderUsageSnapshot {
  if (attributes['takt.usage.missing'] === true) {
    return {
      usageMissing: true,
      reason: getUsageMissingReason(attributes['takt.usage.missing_reason']),
    };
  }

  const inputTokens = getTokenCount(attributes, 'gen_ai.usage.input_tokens');
  const outputTokens = getTokenCount(attributes, 'gen_ai.usage.output_tokens');
  const totalTokenAttribute = attributes['gen_ai.usage.total_tokens'];
  const totalTokens = totalTokenAttribute === undefined
    ? deriveTotalTokenCount(inputTokens, outputTokens)
    : getNonNegativeFiniteNumber(totalTokenAttribute);

  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return {
      usageMissing: true,
      reason: hasAnyUsageAttribute(attributes)
        ? USAGE_MISSING_REASONS.TOKENS_MISSING
        : USAGE_MISSING_REASONS.NOT_AVAILABLE,
    };
  }

  return {
    usageMissing: false,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: getTokenCount(attributes, 'gen_ai.usage.cached_input_tokens'),
    cacheCreationInputTokens: getTokenCount(attributes, 'gen_ai.usage.cache_creation_input_tokens'),
    cacheReadInputTokens: getTokenCount(attributes, 'gen_ai.usage.cache_read_input_tokens'),
  };
}

function getTokenCount(attributes: Record<string, unknown>, key: string): number | undefined {
  return getNonNegativeFiniteNumber(attributes[key]);
}

function deriveTotalTokenCount(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return getNonNegativeFiniteNumber(inputTokens + outputTokens);
}

function getNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasAnyUsageAttribute(attributes: Record<string, unknown>): boolean {
  return Object.keys(attributes).some((key) => key.startsWith('gen_ai.usage.'));
}

function getUsageMissingReason(value: unknown): UsageMissingReason {
  return value === USAGE_MISSING_REASONS.NOT_AVAILABLE
    || value === USAGE_MISSING_REASONS.TOKENS_MISSING
    || value === USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER
    ? value
    : USAGE_MISSING_REASONS.NOT_AVAILABLE;
}

export function getNumber(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
