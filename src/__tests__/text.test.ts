/**
 * Unit tests for text display width utilities
 *
 * Tests full-width character detection, display width calculation,
 * ANSI stripping, and text truncation.
 */

import { describe, it, expect } from 'vitest';
import {
  isFullWidth,
  getDisplayWidth,
  stripAnsi,
  truncateText,
} from '../shared/utils/text.js';

describe('isFullWidth', () => {
  it('should return false for ASCII characters', () => {
    expect(isFullWidth('A'.codePointAt(0)!)).toBe(false);
    expect(isFullWidth('z'.codePointAt(0)!)).toBe(false);
    expect(isFullWidth('0'.codePointAt(0)!)).toBe(false);
    expect(isFullWidth(' '.codePointAt(0)!)).toBe(false);
  });

  it('should return true for CJK ideographs', () => {
    expect(isFullWidth('漢'.codePointAt(0)!)).toBe(true);
    expect(isFullWidth('字'.codePointAt(0)!)).toBe(true);
  });

  it('should return true for Hangul syllables', () => {
    expect(isFullWidth('한'.codePointAt(0)!)).toBe(true);
  });

  it('should return true for fullwidth ASCII variants', () => {
    expect(isFullWidth('Ａ'.codePointAt(0)!)).toBe(true);
  });

  it('should return true for Hangul Jamo', () => {
    // U+1100 (ᄀ) is in Hangul Jamo range
    expect(isFullWidth(0x1100)).toBe(true);
  });

  it('should return true for CJK radicals', () => {
    // U+2E80 is in CJK radicals range
    expect(isFullWidth(0x2E80)).toBe(true);
  });
});

describe('getDisplayWidth', () => {
  it('should return 0 for empty string', () => {
    expect(getDisplayWidth('')).toBe(0);
  });

  it('should count ASCII characters as width 1', () => {
    expect(getDisplayWidth('hello')).toBe(5);
    expect(getDisplayWidth('abc123')).toBe(6);
  });

  it('should count CJK characters as width 2', () => {
    expect(getDisplayWidth('漢字')).toBe(4);
    expect(getDisplayWidth('テスト')).toBe(6);
  });

  it('should handle mixed ASCII and CJK', () => {
    expect(getDisplayWidth('hello漢字')).toBe(9); // 5 + 4
    expect(getDisplayWidth('AB漢C')).toBe(5); // 1+1+2+1
  });
});

describe('stripAnsi', () => {
  it('should strip CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('should strip multiple CSI sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m')).toBe('bold green');
  });

  it('should strip cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Amove up')).toBe('move up');
  });

  it('should strip OSC sequences (BEL terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('should strip OSC sequences (ST terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\rest')).toBe('rest');
  });

  it('should return unchanged string with no escapes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('should handle empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('truncateText', () => {
  it('should return empty string for maxWidth 0', () => {
    expect(truncateText('hello', 0)).toBe('');
  });

  it('should not truncate text shorter than maxWidth', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('should truncate and add ellipsis for long text', () => {
    const result = truncateText('hello world', 6);
    expect(result).toBe('hello…');
    expect(getDisplayWidth(result)).toBeLessThanOrEqual(6);
  });

  it('should handle CJK characters correctly when truncating', () => {
    // Each CJK char is width 2, so "漢字テスト" = 10 width
    const result = truncateText('漢字テスト', 5);
    // Should fit within 5 columns including ellipsis
    expect(getDisplayWidth(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith('…')).toBe(true);
  });

  it('should handle mixed content', () => {
    const result = truncateText('AB漢字CD', 5);
    expect(getDisplayWidth(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith('…')).toBe(true);
  });

  it('should truncate text at exact maxWidth since ellipsis space is reserved', () => {
    // truncateText always reserves 1 column for ellipsis
    expect(truncateText('abcde', 5)).toBe('abcd…');
  });

  it('should return text as-is when shorter than maxWidth', () => {
    expect(truncateText('abcd', 5)).toBe('abcd');
  });
});
