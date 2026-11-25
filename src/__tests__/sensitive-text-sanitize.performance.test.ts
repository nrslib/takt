import { describe, expect, it } from 'vitest';
import {
  createBoundedSensitiveValues,
  createSensitiveTextStreamRedactor,
  sanitizeSensitiveText,
} from '../shared/utils/sensitiveText.js';

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
    ['a leading-@ password without a closing @', 'https://user:@', 'a', ''],
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

  // 4MiB of `@` characters exceeds V8's regexp stack when a repeated group matches each `@`.
  it('redacts a 4MiB run of @ in a URL password without exhausting the regexp stack', () => {
    const input = 'https://u:p' + '@'.repeat(4 * 1024 * 1024) + 'host';

    expect(sanitizeSensitiveText(input)).toBe('https://[REDACTED]@host');

    const bounded = createBoundedSensitiveValues();
    bounded.collect(input);
    expect(bounded.values.has('p')).toBe(true);

    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write(input + '\n', {}) + redactor.flush({})).toBe('https://[REDACTED]@host\n');
  });
});

describe('sensitive text stream redactor performance', () => {
  // A long tracked value used to be matched against the end of each committed text by trying
  // every prefix of it, which is quadratic in its length.
  it.each([
    ['a URL whose password is a long run of @-separated words',
      (bytes: number) => ({ text: 'https://u:' + 'p@'.repeat(bytes / 2) + 'host\n', source: {} })],
    ['a long known value',
      (bytes: number) => ({ text: 'p@'.repeat(bytes / 2) + '\n', source: { token: 'p@'.repeat(bytes / 2) } })],
  ])('stays linear on %s', (_name, input) => {
    const elapsed = (bytes: number): number => {
      const { text, source } = input(bytes);
      const start = performance.now();
      const redactor = createSensitiveTextStreamRedactor();
      redactor.write(text, source);
      redactor.flush(source);
      return performance.now() - start;
    };
    elapsed(1024); // warm up regexes and JIT

    expect(elapsed(64 * 1024)).toBeLessThan(500);
    expect(elapsed(256 * 1024)).toBeLessThan(2000);
  });
});
