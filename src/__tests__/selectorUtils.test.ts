/**
 * Tests for selector shared utilities
 */

import { describe, it, expect } from 'vitest';
import { truncateForLabel, formatDateForSelector } from '../features/interactive/selectorUtils.js';

describe('truncateForLabel', () => {
  it('should return text as-is when within max length', () => {
    const result = truncateForLabel('Short text', 20);

    expect(result).toBe('Short text');
  });

  it('should truncate text exceeding max length with ellipsis', () => {
    const longText = 'A'.repeat(100);

    const result = truncateForLabel(longText, 60);

    expect(result).toHaveLength(61); // 60 + '…'
    expect(result).toBe('A'.repeat(60) + '…');
  });

  it('should replace newlines with spaces', () => {
    const result = truncateForLabel('Line one\nLine two\nLine three', 50);

    expect(result).toBe('Line one Line two Line three');
    expect(result).not.toContain('\n');
  });

  it('should trim surrounding whitespace', () => {
    const result = truncateForLabel('  padded text  ', 50);

    expect(result).toBe('padded text');
  });

  it('should handle text exactly at max length', () => {
    const exactText = 'A'.repeat(60);

    const result = truncateForLabel(exactText, 60);

    expect(result).toBe(exactText);
  });
});

describe('formatDateForSelector', () => {
  it('should format date for English locale', () => {
    const result = formatDateForSelector('2026-02-01T10:30:00Z', 'en');

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should format date for Japanese locale', () => {
    const result = formatDateForSelector('2026-02-01T10:30:00Z', 'ja');

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});
