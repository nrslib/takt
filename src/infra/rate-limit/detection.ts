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
  /\bhit\s+your\s+(?:weekly|5-hour|session)\s+limit\b/i,
  /too many requests/i,
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

const RATE_LIMIT_STREAM_MARKER_PATTERNS = [
  /out of extra usage/i,
  /usage_limit_exceeded/i,
] as const;

// Codex returns its usage-limit notice as a normal, successful response body
// rather than an error, so we can't match "usage limit" anywhere in the text
// like the patterns above (that misclassified ordinary answers merely
// mentioning "usage limit ... try again later" elsewhere in the sentence).
// CodexClient joins multiple agent_message items with "\n", so the notice
// can also land as the final line of a longer reply (e.g. "Sure, let me
// check that.\nYou've hit your usage limit. Try again later."). We evaluate
// only the last non-empty line, and require it to fully match one of the
// closed set of templates produced by UsageLimitReachedError::fmt
// (codex-rs/protocol/src/error.rs). Each pattern below mirrors one branch of
// that fmt impl, in source order; only the genuinely variable parts
// ({limit_name}, {promo_message}, the retry_suffix time) are wildcards —
// everything else, including the URLs, is matched literally.
// The retry_suffix time itself is not free-form: format_retry_timestamp
// (codex-rs/protocol/src/error.rs) only ever emits "%-I:%M %p" (e.g.
// "3:45 PM") or, when the reset date differs from today,
// "%b %-d{suffix}, %Y %-I:%M %p" (e.g. "Jan 5th, 2026 3:45 PM").
const RETRY_TIMESTAMP =
  '(?:[A-Za-z]{3} \\d{1,2}(?:st|nd|rd|th), \\d{4} \\d{1,2}:\\d{2} (?:AM|PM)|\\d{1,2}:\\d{2} (?:AM|PM))';
const RETRY_SUFFIX_AFTER_OR = new RegExp(` or try again(?: later| at ${RETRY_TIMESTAMP})\\.$`, 'i');
const RETRY_SUFFIX = new RegExp(` try again(?: later| at ${RETRY_TIMESTAMP})\\.$`, 'i');

const RATE_LIMIT_NOTICE_PATTERNS = [
  // limit_name branch (non-codex/gpt-reserve model). limit_name can itself
  // contain a period (e.g. "gpt-5.1-codex"), so it's matched lazily rather
  // than excluding ".".
  new RegExp(
    `^you['’]ve hit your usage limit for [^\\n]+?\\. switch to another model now,${RETRY_SUFFIX_AFTER_OR.source}`,
    'i',
  ),
  // promo_message branch
  new RegExp(`^you['’]ve hit your usage limit\\. .+,${RETRY_SUFFIX_AFTER_OR.source}`, 'i'),
  // Plus plan
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to pro \\(https://chatgpt\\.com/explore/pro\\), visit https://chatgpt\\.com/codex/settings/usage to purchase more credits${RETRY_SUFFIX_AFTER_OR.source}`,
    'i',
  ),
  // Team / business / enterprise-admin plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. to get more access now, send a request to your admin${RETRY_SUFFIX_AFTER_OR.source}`,
    'i',
  ),
  // Free / Go plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to plus to continue using codex \\(https://chatgpt\\.com/explore/plus\\),${RETRY_SUFFIX_AFTER_OR.source}`,
    'i',
  ),
  // Pro / ProLite / ProMax plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. visit https://chatgpt\\.com/codex/settings/usage to purchase more credits${RETRY_SUFFIX_AFTER_OR.source}`,
    'i',
  ),
  // Enterprise / Edu / Unknown / None plans (retry_suffix, not _after_or)
  new RegExp(`^you['’]ve hit your usage limit\\.${RETRY_SUFFIX.source}`, 'i'),
] as const;

// Same source (UsageLimitReachedError::fmt, rate_limit_reached_type branch)
// but these workspace-credit / spend-cap variants don't share the "You've
// hit your usage limit" / "try again" shape, so they're matched as their own
// exact full-line strings.
const RATE_LIMIT_WORKSPACE_NOTICE_PATTERNS = [
  /^your workspace is out of credits\. add credits to continue\.$/i,
  /^your workspace is out of credits\. ask your workspace owner to refill in order to continue\.$/i,
  /^you hit your spend cap set in your workspace\. increase your spend cap to continue\.$/i,
  /^you hit your spend cap set by the owner of your workspace\. ask an owner to increase your spend cap to continue\.$/i,
] as const;

export function containsRateLimitMarker(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_STREAM_MARKER_PATTERNS.some((pattern) => pattern.test(text));
}

export function isRateLimitNoticeResponse(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const lines = trimmed.split(/\r?\n/);
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]?.trim() ?? '';
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
  }
  if (!lastLine) {
    return false;
  }
  if (RATE_LIMIT_NOTICE_PATTERNS.some((pattern) => pattern.test(lastLine))) {
    return true;
  }
  return RATE_LIMIT_WORKSPACE_NOTICE_PATTERNS.some((pattern) => pattern.test(lastLine));
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
