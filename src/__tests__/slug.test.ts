/**
 * Unit tests for slugify utility
 *
 * Tests URL/filename-safe slug generation (a-z 0-9 hyphen, max 30 chars).
 */

import { describe, it, expect } from 'vitest';
import { slugify } from '../shared/utils/slug.js';

describe('slugify', () => {
  it('should convert to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('should replace non-alphanumeric characters with hyphens', () => {
    expect(slugify('foo bar_baz')).toBe('foo-bar-baz');
  });

  it('should collapse consecutive special characters into single hyphen', () => {
    expect(slugify('foo---bar   baz')).toBe('foo-bar-baz');
  });

  it('should strip leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
    expect(slugify('   hello   ')).toBe('hello');
  });

  it('should truncate to 30 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(30);
  });

  it('should strip CJK characters', () => {
    expect(slugify('タスク指示書')).toBe('');
  });

  it('should handle mixed ASCII and CJK', () => {
    expect(slugify('Add タスク Feature')).toBe('add-feature');
  });

  it('should handle numbers', () => {
    expect(slugify('issue 123')).toBe('issue-123');
  });

  it('should handle empty result after stripping', () => {
    expect(slugify('!@#$%')).toBe('');
  });

  it('should handle typical GitHub issue titles', () => {
    expect(slugify('Fix: login not working (#42)')).toBe('fix-login-not-working-42');
  });

  it('should strip trailing hyphen after truncation', () => {
    // 30 chars of slug that ends with a hyphen after slice
    const input = 'abcdefghijklmnopqrstuvwxyz-abc-xyz';
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).not.toMatch(/-$/);
  });
});
