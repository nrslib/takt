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
    "You've hit your usage limit",
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:04 PM",
    'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 7:04 PM.',
    'You’ve hit your usage limit. Try again at Sep 27th, 2026 7:04 PM.',
    'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.',
    'You’ve hit your usage limit. Try again later.',
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
    'Network error loading the purchase more credits page',
    'Failed to render the purchase more credits page',
    'Visit https://chatgpt.com/codex/settings/usage to purchase more credits',
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
