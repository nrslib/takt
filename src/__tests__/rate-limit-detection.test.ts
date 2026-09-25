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
  containsRateLimitMarker,
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
});

describe('containsRateLimitMarker', () => {
  it.each([
    "You're out of extra usage · resets 2:30pm (Asia/Tokyo)",
    'usage_limit_exceeded: resets 12:30pm',
    'out of extra usage',
  ])('stream text %j is detected as a rate limit marker', (text) => {
    expect(containsRateLimitMarker(text)).toBe(true);
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
    expect(containsRateLimitMarker(text)).toBe(false);
    expect(resolveRateLimitTextSource(text)).toBeUndefined();
  });

  it('returns false for undefined and empty text', () => {
    expect(containsRateLimitMarker(undefined)).toBe(false);
    expect(containsRateLimitMarker('')).toBe(false);
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
    // promo_message branch
    "You've hit your usage limit. 50% off your next month, or try again later.",
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
    // CodexClient joins multiple agent_message items with "\n" (src/infra/codex/client.ts),
    // so the notice can arrive as the final line of a longer reply.
    "Sure, let me check that.\nYou've hit your usage limit. Try again later.",
    "Let me look into your account.\nOne moment please.\nYou've hit your usage limit. Try again at 3:45 PM.",
    // Trailing blank lines shouldn't hide the notice line.
    "Sure, let me check that.\nYou've hit your usage limit. Try again later.\n\n",
    // rate_limit_reached_type workspace-credit / spend-cap branches
    // (UsageLimitReachedError::fmt, codex-rs error.rs) — exact full-line strings.
    'Your workspace is out of credits. Add credits to continue.',
    'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
    // Workspace variant as the last line of a multi-item joined reply.
    "Checking your account now.\nYour workspace is out of credits. Add credits to continue.",
  ])('response text %j is detected as a rate limit notice', (text) => {
    expect(isRateLimitNoticeResponse(text)).toBe(true);
  });

  it.each([
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
