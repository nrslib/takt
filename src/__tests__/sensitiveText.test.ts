import { describe, expect, it } from 'vitest';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

describe('sanitizeSensitiveText', () => {
  it('Given complete private key blocks, When sanitizing, Then every block is replaced and surrounding text remains', () => {
    const input = [
      'before',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'openssh-secret',
      '-----END OPENSSH PRIVATE KEY-----',
      'between',
      '-----BEGIN RSA PRIVATE KEY-----',
      'rsa-secret',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n');

    const sanitized = sanitizeSensitiveText(input);

    expect(sanitized).toBe('before\n[REDACTED]\nbetween\n[REDACTED]\nafter');
    expect(sanitized).not.toContain('openssh-secret');
    expect(sanitized).not.toContain('rsa-secret');
  });

  it('Given an unterminated private key block, When sanitizing, Then the remaining key material is discarded', () => {
    const input = 'before\n-----BEGIN PRIVATE KEY-----\nunterminated-secret\ntrailing-material';

    expect(sanitizeSensitiveText(input)).toBe('before\n[REDACTED]');
  });

  it('Given consecutive calls contain private keys, When sanitizing, Then global regex state does not leak', () => {
    const first = '-----BEGIN PRIVATE KEY-----\nfirst-secret\n-----END PRIVATE KEY-----';
    const second = '-----BEGIN PRIVATE KEY-----\nsecond-secret\n-----END PRIVATE KEY-----';

    expect(sanitizeSensitiveText(first)).toBe('[REDACTED]');
    expect(sanitizeSensitiveText(second)).toBe('[REDACTED]');
  });

  it.each([64, 65])(
    'Given a sensitive assignment has a %i-character key prefix, When sanitizing, Then its value is redacted',
    (prefixLength) => {
      const secret = `boundary-secret-${prefixLength}`;
      const input = `${'a'.repeat(prefixLength)}_api_key=${secret}`;

      const sanitized = sanitizeSensitiveText(input);

      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain('[REDACTED]');
    },
  );
});
