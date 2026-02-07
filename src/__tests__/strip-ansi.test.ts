/**
 * Tests for stripAnsi utility function
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../shared/utils/text.js';

describe('stripAnsi', () => {
  it('should return plain text unchanged', () => {
    expect(stripAnsi('Hello World')).toBe('Hello World');
  });

  it('should return empty string unchanged', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('should strip foreground color codes', () => {
    // Red text: ESC[31m ... ESC[0m
    expect(stripAnsi('\x1b[31mError\x1b[0m')).toBe('Error');
  });

  it('should strip background color codes', () => {
    // Red background: ESC[41m ... ESC[0m
    expect(stripAnsi('\x1b[41mHighlighted\x1b[0m')).toBe('Highlighted');
  });

  it('should strip combined foreground and background codes', () => {
    // White text on red background: ESC[37;41m
    expect(stripAnsi('\x1b[37;41mAlert\x1b[0m')).toBe('Alert');
  });

  it('should strip multiple SGR sequences in one string', () => {
    const input = '\x1b[1mBold\x1b[0m normal \x1b[32mGreen\x1b[0m';
    expect(stripAnsi(input)).toBe('Bold normal Green');
  });

  it('should strip 256-color sequences', () => {
    // ESC[38;5;196m (foreground 256-color red)
    expect(stripAnsi('\x1b[38;5;196mRed256\x1b[0m')).toBe('Red256');
  });

  it('should strip cursor movement sequences', () => {
    // Cursor up: ESC[1A, Cursor right: ESC[5C
    expect(stripAnsi('\x1b[1AUp\x1b[5CRight')).toBe('UpRight');
  });

  it('should strip erase sequences', () => {
    // Clear line: ESC[2K
    expect(stripAnsi('\x1b[2KCleared')).toBe('Cleared');
  });

  it('should strip OSC sequences terminated by BEL', () => {
    // Set terminal title: ESC]0;Title BEL
    expect(stripAnsi('\x1b]0;My Title\x07Text')).toBe('Text');
  });

  it('should strip OSC sequences terminated by ST', () => {
    // Set terminal title: ESC]0;Title ESC\
    expect(stripAnsi('\x1b]0;My Title\x1b\\Text')).toBe('Text');
  });

  it('should strip other single-character escape codes', () => {
    // ESC followed by a single char (e.g., ESC M = reverse line feed)
    expect(stripAnsi('\x1bMText')).toBe('Text');
  });

  it('should preserve newlines and whitespace', () => {
    expect(stripAnsi('\x1b[31mLine1\n\x1b[32mLine2\n')).toBe('Line1\nLine2\n');
  });

  it('should strip sequences without a reset at the end', () => {
    // Simulates the reported bug: background color set without reset
    expect(stripAnsi('\x1b[41mRed background text')).toBe('Red background text');
  });

  it('should handle text with only ANSI sequences', () => {
    expect(stripAnsi('\x1b[31m\x1b[0m')).toBe('');
  });

  it('should handle consecutive ANSI sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[31m\x1b[42mStyled\x1b[0m')).toBe('Styled');
  });
});
