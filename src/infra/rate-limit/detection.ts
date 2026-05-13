import type { RateLimitInfo } from '../../core/models/response.js';
import { RATE_LIMIT_ERROR_MESSAGE } from '../../core/models/response.js';
import type { ProviderType } from '../../shared/types/provider.js';

const RATE_LIMIT_ERROR_PATTERNS = [
  /\bhttp\s+429\b/i,
  /\b429\b/i,
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

const RATE_LIMIT_STREAM_MARKER_PATTERNS = [
  /out of extra usage/i,
  /usage_limit_exceeded/i,
  /resets?\s+\d{1,2}:\d{2}\s*(?:am|pm)?/i,
] as const;

export function containsRateLimitMarker(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_STREAM_MARKER_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsRateLimitError(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildRateLimitInfo(
  provider: ProviderType,
  source: RateLimitInfo['source'],
  text?: string,
): RateLimitInfo {
  const resetAtRaw = text?.match(/resets?\s+([^\n\r]+)/i)?.[1]?.trim();
  return {
    provider,
    detectedAt: new Date(),
    source,
    ...(resetAtRaw ? { resetAtRaw } : {}),
  };
}

export function buildRateLimitedResponseFields(
  provider: ProviderType,
  source: RateLimitInfo['source'],
  text?: string,
): {
  status: 'rate_limited';
  content: '';
  error: string;
  errorKind: 'rate_limit';
  rateLimitInfo: RateLimitInfo;
} {
  return {
    status: 'rate_limited',
    content: '',
    error: RATE_LIMIT_ERROR_MESSAGE,
    errorKind: 'rate_limit',
    rateLimitInfo: buildRateLimitInfo(provider, source, text),
  };
}
