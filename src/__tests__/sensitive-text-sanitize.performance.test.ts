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

  // Each unit starts a URL scheme-like run or a `user:password` run and never completes it.
  // A pattern that restarts at every letter after a `-`, or at every colon, rescans the rest
  // of the run each time (8s and 18s at 256KiB before the URL userinfo pattern was anchored
  // to `://` and the user/password separator was fixed to the first colon).
  it.each([
    ['a scheme-like run of letters and hyphens', 'abc-'],
    ['an OpenAI key prefix in a hyphenated run', 'sk-'],
    ['a JSON web token prefix in a hyphenated run', 'eyJ-'],
    ['an AWS access key prefix in a hyphenated run', 'AKIA-'],
  ])('stays linear on %s without a ://', (_name, unit) => {
    const elapsed = (bytes: number): number => {
      const input = unit.repeat(Math.ceil(bytes / unit.length));
      const start = performance.now();
      sanitizeSensitiveText(input);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  // One URL whose userinfo is a long run of colons and never reaches an `@`. Trying every
  // colon as the user/password separator rescans the rest of the run each time.
  it.each([
    ['colon-separated words', 'a:'],
    ['colons only', ':'],
  ])('stays linear on a URL followed by %s without an @', (_name, unit) => {
    const elapsed = (bytes: number): number => {
      const input = 'https://' + unit.repeat(Math.ceil(bytes / unit.length));
      const start = performance.now();
      sanitizeSensitiveText(input);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  // The worst shape for a variable-length lookbehind: each `://` starts a userinfo run that
  // never reaches an `@`, and the scheme-like run behind it is made of long alphanumeric or
  // hash words joined by `-` (a `1-http://user:pass@host`-style prefix). Restarting the
  // scheme match at every letter after a `-` rescans the rest of the run each time, so the
  // old `(\b[A-Za-z][A-Za-z0-9+.-]*://)` pattern took quadratic time on these inputs
  // (448ms at 64KiB, 6.9s at 256KiB for the `abcd-` scheme), while the `://`-anchored
  // pattern stays linear. A run without a `-` is only scanned once even by the old pattern,
  // so the prefixes keep the `-`.
  it.each([
    // A bare `://` userinfo: the old pattern restarts the scheme at every word boundary.
    ['hyphenated hash words before ://', (bytes: number) => 'deadbeef-'.repeat(Math.ceil(bytes / 9)) + '://'],
    // A userinfo that has a colon but no `@`: the old pattern also retried every colon.
    ['hyphenated words with an incomplete userinfo', (bytes: number) => 'abcd-'.repeat(Math.ceil(bytes / 5)) + '://u:p'],
  ])('stays linear on %s', (_name, build) => {
    const elapsed = (bytes: number): number => {
      const start = performance.now();
      sanitizeSensitiveText(build(bytes));
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });

  // Long runs that keep a scheme-like or key-like tail open on every repetition. The times
  // grow with the input rather than with its square on the `://`-anchored pattern.
  it.each([
    ['repeated 1000-letter runs before ://', 'a'.repeat(1000) + '://'],
    ['repeated sk- prefixed 2000-letter runs', 'sk-' + 'a'.repeat(2000)],
    ['repeated eyJ- prefixed 4000-letter runs', 'eyJ-' + 'a'.repeat(4000)],
  ])('stays linear on %s', (_name, unit) => {
    const elapsed = (bytes: number): number => {
      const start = performance.now();
      sanitizeSensitiveText(unit.repeat(Math.ceil(bytes / unit.length)));
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});
