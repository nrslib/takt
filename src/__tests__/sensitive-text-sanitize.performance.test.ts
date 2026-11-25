import { describe, expect, it } from 'vitest';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

describe('sanitizeSensitiveText performance', () => {
  it('sanitizes a 64KiB uniform alphanumeric run without quadratic blowup', () => {
    // Command quality gates route up to 64KiB of command output through
    // sanitizeSensitiveText. A single uninterrupted [A-Za-z0-9_.-] run used to
    // trigger O(n^2) backtracking in the sensitive-key patterns (~4-5s for
    // this input); the linear-safe patterns finish in around a millisecond.
    // The 200ms budget leaves two orders of magnitude of headroom for slow
    // CI machines while still failing fast on any quadratic regression.
    const input = 'a1'.repeat(32 * 1024);
    sanitizeSensitiveText(input.slice(0, 1024)); // warm up regexes and JIT

    const start = performance.now();
    const sanitized = sanitizeSensitiveText(input);
    const elapsedMs = performance.now() - start;

    expect(sanitized).toBe(input);
    expect(elapsedMs).toBeLessThan(200);
  });

  // Each input is a long run that looks like the start of a URL with credentials but never
  // completes one. A URL userinfo pattern that restarts at every letter after a `-`, or tries
  // every colon as the user/password separator, rescans the rest of the run each time and
  // takes seconds at 256KiB.
  it.each([
    ['a scheme-like run of letters and hyphens without ://', '', 'abc-', ''],
    ['a run of digits and hyphens before a scheme', '', '1-', 'x://user:pass@host'],
    ['colon-separated words without an @', 'https://', 'a:', ''],
    ['colons only without an @', 'https://', ':', ''],
    ['a password of @-separated words', 'https://user:pass', '@a', ''],
    ['a password of @ only', 'https://user:pass', '@', ''],
  ])('stays linear on %s', (_name, head, unit, tail) => {
    const elapsed = (bytes: number): number => {
      const input = head + unit.repeat(Math.ceil(bytes / unit.length)) + tail;
      const start = performance.now();
      sanitizeSensitiveText(input);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});
