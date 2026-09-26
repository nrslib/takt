import { describe, it, expect } from 'vitest';
import {
  boundPersistedFailureText,
  MAX_PERSISTED_FAILURE_ERROR_BYTES,
} from '../shared/utils/persistedFailureText.js';

describe('boundPersistedFailureText', () => {
  it('should leave short text untouched', () => {
    expect(boundPersistedFailureText('boom')).toBe('boom');
  });

  it('should not touch text exactly at the byte limit', () => {
    const exact = 'a'.repeat(MAX_PERSISTED_FAILURE_ERROR_BYTES);
    expect(boundPersistedFailureText(exact)).toBe(exact);
  });

  it('should truncate oversized text and append a byte-count marker', () => {
    const huge = 'a'.repeat(MAX_PERSISTED_FAILURE_ERROR_BYTES * 10);

    const result = boundPersistedFailureText(huge);

    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(MAX_PERSISTED_FAILURE_ERROR_BYTES);
    expect(result).toMatch(/\[TRUNCATED: \d+ bytes\]$/);
  });

  it('should be idempotent when re-applied to an already-bounded value', () => {
    const huge = 'e'.repeat(500_000);
    const once = boundPersistedFailureText(huge);

    const twice = boundPersistedFailureText(once);

    expect(twice).toBe(once);
  });

  it('should not split a multi-byte character across the truncation boundary', () => {
    const huge = '\u{1F600}'.repeat(500_000); // 4-byte emoji, well over the cap

    const result = boundPersistedFailureText(huge);

    expect(() => Buffer.from(result, 'utf-8').toString('utf-8')).not.toThrow();
    expect(result.includes('�')).toBe(false);
  });
});
