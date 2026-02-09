/**
 * Unit tests for task naming utilities
 *
 * Tests nowIso, firstLine, and sanitizeTaskName functions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { nowIso, firstLine, sanitizeTaskName } from '../infra/task/naming.js';

describe('nowIso', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return a valid ISO 8601 string', () => {
    const result = nowIso();
    expect(() => new Date(result)).not.toThrow();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should return current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T14:30:00.000Z'));

    expect(nowIso()).toBe('2025-06-15T14:30:00.000Z');

    vi.useRealTimers();
  });
});

describe('firstLine', () => {
  it('should return the first line of text', () => {
    expect(firstLine('first line\nsecond line\nthird line')).toBe('first line');
  });

  it('should trim leading whitespace from content', () => {
    expect(firstLine('  hello world\nsecond')).toBe('hello world');
  });

  it('should truncate to 80 characters', () => {
    const longLine = 'a'.repeat(100);
    expect(firstLine(longLine)).toBe('a'.repeat(80));
  });

  it('should handle empty string', () => {
    expect(firstLine('')).toBe('');
  });

  it('should handle single line', () => {
    expect(firstLine('just one line')).toBe('just one line');
  });

  it('should handle whitespace-only input', () => {
    expect(firstLine('   \n  ')).toBe('');
  });
});

describe('sanitizeTaskName', () => {
  it('should lowercase the input', () => {
    expect(sanitizeTaskName('Hello World')).toBe('hello-world');
  });

  it('should replace special characters with spaces then hyphens', () => {
    expect(sanitizeTaskName('task@name#123')).toBe('task-name-123');
  });

  it('should collapse multiple hyphens', () => {
    expect(sanitizeTaskName('a---b')).toBe('a-b');
  });

  it('should trim leading/trailing whitespace', () => {
    expect(sanitizeTaskName('  hello  ')).toBe('hello');
  });

  it('should handle typical task names', () => {
    expect(sanitizeTaskName('Fix: login bug (#42)')).toBe('fix-login-bug-42');
  });

  it('should generate fallback name for empty result', () => {
    const result = sanitizeTaskName('!@#$%');
    expect(result).toMatch(/^task-\d+$/);
  });

  it('should preserve numbers and lowercase letters', () => {
    expect(sanitizeTaskName('abc123def')).toBe('abc123def');
  });
});
