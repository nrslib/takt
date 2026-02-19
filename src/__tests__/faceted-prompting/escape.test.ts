/**
 * Unit tests for faceted-prompting escape module.
 */

import { describe, it, expect } from 'vitest';
import { escapeTemplateChars } from '../../faceted-prompting/index.js';

describe('escapeTemplateChars', () => {
  it('should replace curly braces with full-width equivalents', () => {
    expect(escapeTemplateChars('{hello}')).toBe('\uff5bhello\uff5d');
  });

  it('should handle multiple braces', () => {
    expect(escapeTemplateChars('{{nested}}')).toBe('\uff5b\uff5bnested\uff5d\uff5d');
  });

  it('should return unchanged string when no braces', () => {
    expect(escapeTemplateChars('no braces here')).toBe('no braces here');
  });

  it('should handle empty string', () => {
    expect(escapeTemplateChars('')).toBe('');
  });

  it('should handle braces in code snippets', () => {
    const input = 'function foo() { return { a: 1 }; }';
    const expected = 'function foo() \uff5b return \uff5b a: 1 \uff5d; \uff5d';
    expect(escapeTemplateChars(input)).toBe(expected);
  });
});
