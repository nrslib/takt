/**
 * Rate limit detection matrix.
 *
 * Single source of truth for text-based 429 / rate-limit detection.
 * Provider suites (claude-executor, claude-headless-client,
 * claude-terminal-response-normalizer, opencode-client-retry,
 * codex-client-retry) keep only one positive and one negative wiring test
 * each; the full true/false-positive matrix lives here against
 * src/infra/rate-limit/detection.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRateLimitInfo,
  containsRateLimitError,
  findRateLimitMarkerNoticeLine,
  isRateLimitMarkerNotice,
  isRateLimitNoticeResponse,
  resolveRateLimitTextSource,
} from '../infra/rate-limit/detection.js';

describe('containsRateLimitError', () => {
  it.each([
    'HTTP 429: rate limit exceeded',
    'HTTP 429: Too many requests',
    'Status code 429 is Too Many Requests.',
    'The reviewed code handles HTTP status code 429 with retry fallback.',
    'Rate limit exceeded. Please try again later.',
    'rate_limit_error',
    'The request exceeded the rate limit',
    'The report says too many requests should trigger fallback only on provider errors.',
    "You're out of extra usage. Please retry later.",
    'usage_limit_exceeded',
    "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)",
    "You've hit your 5-hour limit · resets Aug 16 at 1am (Asia/Tokyo)",
    "You've hit your session limit · resets Aug 16 at 1am (Asia/Tokyo)",
  ])('error text %j is detected as a rate limit error', (text) => {
    expect(containsRateLimitError(text)).toBe(true);
  });

  it.each([
    'hoge_spec.rb:418-429',
    '| 42 | issue unresolved | `hoge_spec.rb:418-429` |',
    'Documented rate limit fallback behavior for issue 429.',
    'issue 429',
    'Fixed 429 handling in tests',
    'The cache resets 5:00 after the scheduled maintenance window.',
    'rate limit',
    'The documentation mentions a weekly limit.',
  ])('ordinary text %j is not detected as a rate limit error', (text) => {
    expect(containsRateLimitError(text)).toBe(false);
  });

  it('returns false for undefined and empty text', () => {
    expect(containsRateLimitError(undefined)).toBe(false);
    expect(containsRateLimitError('')).toBe(false);
  });

  it('preserves the reset expression from a subscription limit message', () => {
    const text = "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)";

    const info = buildRateLimitInfo('claude', 'error_text', text);

    expect(info.resetAtRaw).toBe('Aug 16 at 1am (Asia/Tokyo)');
  });
  it.each([
    '7:04 PM',
    'Sep 1st, 2026 7:04 PM',
    'Sep 2nd, 2026 7:04 PM',
    'Sep 3rd, 2026 7:04 PM',
    'Sep 11th, 2026 7:04 PM',
  ])('preserves the Codex retry timestamp %j without converting it', (retryTimestamp) => {
    const text = `You’ve hit your usage limit. Try again at ${retryTimestamp}.`;

    const info = buildRateLimitInfo('codex', 'error_text', text);

    expect(info.resetAtRaw).toBe(retryTimestamp);
  });

  it.each([
    'You’ve hit your usage limit. Try again later.',
    'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.',
  ])('leaves the Codex reset time unknown for %j', (text) => {
    const info = buildRateLimitInfo('codex', 'error_text', text);

    expect(info.resetAtRaw).toBeUndefined();
  });
});

describe('isRateLimitMarkerNotice', () => {
  it.each([
    "You're out of extra usage · resets 2:30pm (Asia/Tokyo)",
    'usage_limit_exceeded: resets 12:30pm',
    'out of extra usage',
  ])('stream text %j is detected as a rate limit marker', (text) => {
    expect(isRateLimitMarkerNotice(text)).toBe(true);
    expect(resolveRateLimitTextSource(text)).toBe('stream_marker');
  });

  it.each([
    'HTTP 429: rate limit exceeded',
    'HTTP 429: Too many requests',
    '| 42 | issue unresolved | `hoge_spec.rb:418-429` |',
    'Documented rate limit fallback behavior for issue 429.',
    'Documented HTTP 429 Too Many Requests response handling.',
    'HTTP 429 means Too Many Requests in the docs.',
    'Status code 429 is Too Many Requests.',
    'The reviewed code handles HTTP status code 429 with retry fallback.',
    'The report says too many requests should trigger fallback only on provider errors.',
    'The cache resets 5:00 after the scheduled maintenance window.',
    'Rate limit exceeded. Please try again later.',
  ])('stream text %j is not treated as a rate limit marker', (text) => {
    expect(isRateLimitMarkerNotice(text)).toBe(false);
    expect(resolveRateLimitTextSource(text)).toBeUndefined();
  });

  // 通知文と同じ語を本文の一部に含むだけのテキスト (#1674)。
  // ファイル内容の報告、diff の 1 行、通知文を引用した複数行の説明は通知ではない。
  it.each([
    'このリポジトリの検出パターンは usage_limit_exceeded です。',
    '+  /usage_limit_exceeded/i,',
    "const patterns = [/out of extra usage/i, /usage_limit_exceeded/i];",
    "Claude CLI は上限到達時に You're out of extra usage · resets 2:30pm (Asia/Tokyo) と返します。",
    "説明:\nYou're out of extra usage · resets 2:30pm (Asia/Tokyo)\nこの文面を検出対象に追加してください。",
    'usage_limit_exceeded_count = 0',
    'usage_limit_exceeded: this is a configuration key',
    'out of extra usage occurs in this documentation',
    "You're out of extra usage is the notice Claude CLI prints.",
  ])('text that merely contains the notice wording %j is not treated as a rate limit marker', (text) => {
    expect(isRateLimitMarkerNotice(text)).toBe(false);
    expect(resolveRateLimitTextSource(text)).toBeUndefined();
  });

  it('accepts surrounding whitespace around a standalone notice', () => {
    expect(isRateLimitMarkerNotice("  You're out of extra usage · resets 2:30pm (Asia/Tokyo)\n")).toBe(true);
  });

  it('returns false for undefined and empty text', () => {
    expect(isRateLimitMarkerNotice(undefined)).toBe(false);
    expect(isRateLimitMarkerNotice('')).toBe(false);
  });
});

describe('findRateLimitMarkerNoticeLine', () => {
  it('returns the line that is a standalone notice from multi-line stderr', () => {
    const stderr = [
      'Loading tools...',
      "You're out of extra usage · resets 2:30pm (Asia/Tokyo)",
      '',
    ].join('\n');

    expect(findRateLimitMarkerNoticeLine(stderr)).toBe("You're out of extra usage · resets 2:30pm (Asia/Tokyo)");
  });

  it('ignores lines that only mention the notice wording', () => {
    const stderr = [
      'warning: pattern usage_limit_exceeded is deprecated',
      'note: see out of extra usage handling in docs',
    ].join('\n');

    expect(findRateLimitMarkerNoticeLine(stderr)).toBeUndefined();
  });

  it('returns undefined for undefined and empty text', () => {
    expect(findRateLimitMarkerNoticeLine(undefined)).toBeUndefined();
    expect(findRateLimitMarkerNoticeLine('')).toBeUndefined();
  });
});

describe('isRateLimitNoticeResponse', () => {
  // Every variant below is transcribed by hand from openai/codex
  // codex-rs/protocol/src/error.rs (UsageLimitReachedError::fmt), one per
  // plan/branch, covering both the retry_suffix and retry_suffix_after_or
  // endings.
  it.each([
    // limit_name branch (non-codex/gpt-reserve model)
    "You've hit your usage limit for gpt-5.1-codex. Switch to another model now, or try again later.",
    // Plus plan
    'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.',
    // Team / business / enterprise-admin plans
    "You've hit your usage limit. To get more access now, send a request to your admin or try again later.",
    // Free / Go plans
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again later.",
    // Pro / ProLite / ProMax plans
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
    // Enterprise / Edu / Unknown / None plans (retry_suffix, not _after_or)
    "You've hit your usage limit. Try again later.",
    // retry_suffix with a resets_at timestamp — format_retry_timestamp's
    // same-day branch ("%-I:%M %p", codex-rs/protocol/src/error.rs)
    "You've hit your usage limit. Try again at 3:45 PM.",
    // retry_suffix_after_or with a resets_at timestamp
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:45 PM.",
    // retry_suffix with a resets_at timestamp on a different day —
    // format_retry_timestamp's other-day branch ("%b %-d{suffix}, %Y %-I:%M %p")
    "You've hit your usage limit. Try again at Jan 5th, 2026 3:45 PM.",
    "You've hit your usage limit. Try again at Feb 22nd, 2026 12:00 AM.",
    // retry_suffix_after_or with the other-day timestamp format
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Jan 5th, 2026 3:45 PM.",
    "  You've hit your usage limit. Try again later.  ",
    // rate_limit_reached_type workspace-credit / spend-cap branches
    // (UsageLimitReachedError::fmt, codex-rs error.rs) — exact full-line strings.
    'Your workspace is out of credits. Add credits to continue.',
    'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
  ])('response text %j is detected as a rate limit notice', (text) => {
    expect(isRateLimitNoticeResponse(text)).toBe(true);
  });

  it.each([
    '1:00 AM',
    '12:59 PM',
    'Jan 31st, 2026 1:00 AM',
    'Feb 28th, 2026 12:59 PM',
    'Feb 29th, 2028 3:45 PM',
    'Feb 29th, 2000 3:45 PM',
    'Mar 31st, 2026 3:45 PM',
    'Apr 30th, 2026 3:45 PM',
    'May 31st, 2026 3:45 PM',
    'Jun 30th, 2026 3:45 PM',
    'Jul 31st, 2026 3:45 PM',
    'Aug 31st, 2026 3:45 PM',
    'Sep 30th, 2026 3:45 PM',
    'Oct 31st, 2026 3:45 PM',
    'Nov 30th, 2026 3:45 PM',
    'Dec 31st, 2026 3:45 PM',
    'Sep 1st, 2026 3:45 PM',
    'Sep 2nd, 2026 3:45 PM',
    'Sep 3rd, 2026 3:45 PM',
    'Sep 11th, 2026 3:45 PM',
    'Sep 12th, 2026 3:45 PM',
    'Sep 13th, 2026 3:45 PM',
    'Sep 21st, 2026 3:45 PM',
    'Sep 22nd, 2026 3:45 PM',
    'Sep 23rd, 2026 3:45 PM',
  ])('accepts a valid Codex retry timestamp: %s', (timestamp) => {
    expect(isRateLimitNoticeResponse(`You've hit your usage limit. Try again at ${timestamp}.`)).toBe(true);
  });

  it.each([
    'Xxx 99th, 2026 99:99 AM',
    'Xxx 1st, 2026 3:45 PM',
    '0:00 AM',
    '13:00 PM',
    '12:60 PM',
    '01:00 AM',
    'Sep 0th, 2026 3:45 PM',
    'Sep 01st, 2026 3:45 PM',
    'Jan 32nd, 2026 3:45 PM',
    'Feb 29th, 2026 3:45 PM',
    'Feb 29th, 2100 3:45 PM',
    'Feb 30th, 2028 3:45 PM',
    'Apr 31st, 2026 3:45 PM',
    'Jun 31st, 2026 3:45 PM',
    'Sep 31st, 2026 3:45 PM',
    'Nov 31st, 2026 3:45 PM',
    'Sep 1th, 2026 3:45 PM',
    'Sep 2th, 2026 3:45 PM',
    'Sep 3th, 2026 3:45 PM',
    'Sep 11st, 2026 3:45 PM',
    'Sep 12nd, 2026 3:45 PM',
    'Sep 13rd, 2026 3:45 PM',
    'Sep 21th, 2026 3:45 PM',
    'Sep 22th, 2026 3:45 PM',
    'Sep 23th, 2026 3:45 PM',
    'Jan 31th, 2026 3:45 PM',
  ])('rejects an impossible or non-formatter retry timestamp: %s', (timestamp) => {
    const text = `You've hit your usage limit. Try again at ${timestamp}.`;
    expect(isRateLimitNoticeResponse(text)).toBe(false);
    expect(containsRateLimitError(text)).toBe(false);
  });

  it.each([
    "You've hit your usage limit. Here's how to fix the code, or try again later.",
    "You've hit your usage limit. 50% off your next month, or try again later.",
    "The exact error is:\nYou've hit your usage limit. Try again later.",
    "The exact error is:\nYour workspace is out of credits. Add credits to continue.",
    "> You have hit your usage limit. Let me explain why you saw this error message and how to work around it.",
    "**You've hit your usage limit.** Try again later.",
    'The API returns a 429 when you hit your usage limit for the day. Try again later.',
    'Note: some providers report "usage limit" errors differently than others.',
    'Earlier today you hit your usage limit, but it has since reset.',
    "You've hit your weekly limit · resets Aug 16 at 1am (Asia/Tokyo)",
    "You've hit your usage limit. Here's how to fix the code you asked about: change line 42 to use a let binding instead of const.",
    // Starts with the notice and contains "try again" somewhere, but is an
    // ordinary answer, not the notice itself (its trailing text isn't the
    // retry suffix).
    "You've hit your usage limit for this database plan. You could try again with a smaller batch size to avoid the quota.",
    "You've hit your usage limit is a message users sometimes see; ask them to try again in an hour.",
    "You've hit your usage limit. Try again later. is the exact message Codex shows.",
    // Multi-line answer whose last line is an ordinary sentence that merely
    // mentions usage limits, not the notice itself.
    "Here's the situation.\nSome users hit their usage limit occasionally, and that's expected.",
    // Multi-line answer whose last line starts with the notice shape but
    // continues with unrelated text (not the retry suffix).
    "Let me explain the error you saw.\nYou've hit your usage limit for this database plan, which resets nightly.",
    // Workspace phrasing that isn't an exact match (extra trailing text).
    'Your workspace is out of credits. Add credits to continue using the assistant.',
    // Ordinary answers that share the notice's start and end anchors (start
    // "You've hit your usage limit", end "try again later.") but have
    // unrelated content in between, none of which matches a real error.rs
    // template.
    "You've hit your usage limit for uploads today. Please clear some space and try again later.",
    "You've hit your usage limit on this feature; it's a known bug we're tracking, but you can try again later.",
    "You've hit your usage limit — this endpoint is deprecated. Please migrate to v2 and try again later.",
    // Two timestamps: the retry_suffix time is not free-form ([^.\n]+ was
    // too loose and would previously accept this), so anything beyond the
    // exact format_retry_timestamp output must be rejected.
    "You've hit your usage limit. Try again at 3:45 PM and also at 4:00 PM.",
  ])('a success response that merely mentions the notice, %j, is not detected', (text) => {
    expect(isRateLimitNoticeResponse(text)).toBe(false);
  });

  it('returns false for undefined and empty text', () => {
    expect(isRateLimitNoticeResponse(undefined)).toBe(false);
    expect(isRateLimitNoticeResponse('')).toBe(false);
  });
});
