import type { RateLimitInfo } from '../../core/models/response.js';
import { RATE_LIMIT_ERROR_MESSAGE } from '../../core/models/response.js';
import type { ProviderType } from '../../shared/types/provider.js';

const RATE_LIMIT_ERROR_PATTERNS = [
  /\bhttp\s+(?:status\s+)?(?:code\s+)?429\b/i,
  /\bstatus\s+code\s+429\b/i,
  /\b429\b[^\n\r]{0,40}\btoo many requests\b/i,
  /\brate[_\s-]?limit(?:ed|[_\s-]+exceeded)\b/i,
  /\brate[_\s-]?limit[_\s-]?error\b/i,
  /\b(?:exceeded|hit|reached)\s+(?:a\s+|the\s+)?rate[_\s-]?limit\b/i,
  /too many requests/i,
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

const RATE_LIMIT_STREAM_MARKER_PATTERNS = [
  /out of extra usage/i,
  /usage_limit_exceeded/i,
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

export function resolveRateLimitTextSource(text: string | undefined): 'stream_marker' | undefined {
  if (containsRateLimitMarker(text)) {
    return 'stream_marker';
  }
  return undefined;
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

export function resolveRateLimitErrorMessage(text?: string): string {
  const message = text?.trim();
  return message && message.length > 0 ? message : RATE_LIMIT_ERROR_MESSAGE;
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
    error: resolveRateLimitErrorMessage(text),
    errorKind: 'rate_limit',
    rateLimitInfo: buildRateLimitInfo(provider, source, text),
  };
}
