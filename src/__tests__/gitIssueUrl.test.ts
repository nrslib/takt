import { describe, expect, it } from 'vitest';
import { normalizePublicIssueUrl } from '../infra/git/types.js';

describe('normalizePublicIssueUrl', () => {
  it('keeps only the public origin and path for a valid HTTP(S) URL', () => {
    expect(normalizePublicIssueUrl(
      'https://user:secret@example.test/issues/42?token=secret#fragment',
    )).toBe('https://example.test/issues/42');
  });

  it.each([
    ['an absent URL', undefined],
    ['control characters', 'https://example.test/issues/42\ninjected'],
    ['a non-HTTP(S) protocol', 'ftp://example.test/issues/42'],
    ['a URL parsing failure', 'not a URL'],
    ['an empty hostname', 'file:///issues/42'],
  ] as const)('rejects %s', (_case, url) => {
    expect(normalizePublicIssueUrl(url)).toBeUndefined();
  });
});
