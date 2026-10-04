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

// Claude CLI が rate limit 到達を assistant text や result 本文として返すときの通知文。
// 通知は単独の 1 行メッセージとして届くので、本文全体がその形をしているときだけ一致させる。
// 部分一致にすると、ファイル内容や tool 出力、エージェントの引用（例: この定義を含む diff）
// に同じ語が現れただけで rate limit と誤検知する (#1674)。
// 後続は CLI が実際に付ける形（`· resets <時刻>` / `. Please retry later.` / `: resets <時刻>`）だけを許す。
const RATE_LIMIT_STREAM_MARKER_PATTERNS = [
  /^(?:you['’]re )?out of extra usage(?:\s*[·.]\s*(?:resets?\b[^\n]*|please retry later\.?))?$/i,
  /^usage_limit_exceeded(?::\s*resets?\b[^\n]*)?$/i,
] as const;

// Match the complete final agent_message item against known Codex notices.
// Arbitrary promo_message text is excluded because it can also be an ordinary reply.
// Templates follow UsageLimitReachedError::fmt in codex-rs/protocol/src/error.rs.
const RETRY_MONTH_DAYS: Readonly<Record<string, number>> = {
  jan: 31, feb: 28, mar: 31, apr: 30, may: 31, jun: 30,
  jul: 31, aug: 31, sep: 30, oct: 31, nov: 30, dec: 31,
};
const RETRY_TIMESTAMP =
  `(?:(?<month>${Object.keys(RETRY_MONTH_DAYS).join('|')}) (?<day>[1-9]|[12]\\d|3[01])(?<ordinal>st|nd|rd|th), (?<year>\\d{4}) )?(?:[1-9]|1[0-2]):[0-5]\\d (?:AM|PM)`;
const RETRY_SUFFIX = `try again(?: later| at ${RETRY_TIMESTAMP})`;

const RATE_LIMIT_NOTICE_PATTERNS = [
  // limit_name branch (non-codex/gpt-reserve model). limit_name can itself
  // contain a period (e.g. "gpt-5.1-codex"), so it's matched lazily rather
  // than excluding ".".
  new RegExp(
    `^you['’]ve hit your usage limit for [^\\n]+?\\. switch to another model now, or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Plus plan
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to pro \\(https://chatgpt\\.com/explore/pro\\), visit https://chatgpt\\.com/codex/settings/usage to purchase more credits(?: or ${RETRY_SUFFIX})?\\.?$`,
    'i',
  ),
  // Team / business / enterprise-admin plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. to get more access now, send a request to your admin or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Free / Go plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. upgrade to plus to continue using codex \\(https://chatgpt\\.com/explore/plus\\), or ${RETRY_SUFFIX}\\.?$`,
    'i',
  ),
  // Pro / ProLite / ProMax plans
  new RegExp(
    `^you['’]ve hit your usage limit\\. visit https://chatgpt\\.com/codex/settings/usage to purchase more credits(?: or ${RETRY_SUFFIX})?\\.?$`,
    'i',
  ),
  // Enterprise / Edu / Unknown / None plans (retry_suffix, not _after_or)
  new RegExp(`^you['’]ve hit your usage limit\\. ${RETRY_SUFFIX}\\.?$`, 'i'),
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

function matchesRateLimitNotice(pattern: RegExp, text: string): boolean {
  const match = pattern.exec(text);
  if (!match) {
    return false;
  }
  const date = match.groups;
  if (!date?.month) {
    return true;
  }
  const day = Number(date.day);
  const year = Number(date.year);
  const month = date.month.toLowerCase();
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 'feb' && isLeapYear ? 29 : RETRY_MONTH_DAYS[month];
  let ordinal = 'th';
  if (day < 11 || day > 13) {
    if (day % 10 === 1) ordinal = 'st';
    if (day % 10 === 2) ordinal = 'nd';
    if (day % 10 === 3) ordinal = 'rd';
  }
  return daysInMonth !== undefined && day <= daysInMonth && date.ordinal?.toLowerCase() === ordinal;
}

/**
 * text 全体が Claude CLI の rate limit 通知文かどうか。
 * 通知が本文の一部に含まれているだけでは一致しない。
 */
export function isRateLimitMarkerNotice(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return RATE_LIMIT_STREAM_MARKER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * 複数行テキスト（CLI の stderr 等）から、1 行全体が rate limit 通知文になっている行を返す。
 */
export function findRateLimitMarkerNoticeLine(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (isRateLimitMarkerNotice(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

export function isRateLimitNoticeResponse(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return RATE_LIMIT_NOTICE_PATTERNS.some((pattern) => matchesRateLimitNotice(pattern, trimmed))
    || RATE_LIMIT_WORKSPACE_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function containsRateLimitError(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text))
    || isRateLimitNoticeResponse(text);
}

export function resolveRateLimitTextSource(text: string | undefined): 'stream_marker' | undefined {
  if (isRateLimitMarkerNotice(text)) {
    return 'stream_marker';
  }
  return undefined;
}

export function buildRateLimitInfo(
  provider: ProviderType,
  source: RateLimitInfo['source'],
  text?: string,
): RateLimitInfo {
  const resetAtRaw = text?.match(/resets?\s+([^\n\r]+)/i)?.[1]?.trim()
    ?? text?.match(/\btry\s+again\s+at\s+((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th),\s+\d{4}\s+)?\d{1,2}:\d{2}\s*[ap]m(?:\s*\([^)\r\n]+\))?)/i)?.[1]?.trim();
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
