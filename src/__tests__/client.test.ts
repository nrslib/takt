/**
 * Tests for Claude client utilities
 */

import { describe, it, expect } from 'vitest';
import {
  detectRuleIndex,
  isRegexSafe,
} from '../claude/client.js';

describe('isRegexSafe', () => {
  it('should accept simple patterns', () => {
    expect(isRegexSafe('\\[DONE\\]')).toBe(true);
    expect(isRegexSafe('hello')).toBe(true);
    expect(isRegexSafe('^start')).toBe(true);
  });

  it('should reject patterns that are too long', () => {
    const longPattern = 'a'.repeat(201);
    expect(isRegexSafe(longPattern)).toBe(false);
  });

  it('should reject ReDoS patterns', () => {
    expect(isRegexSafe('(.*)*')).toBe(false);
    expect(isRegexSafe('(.+)+')).toBe(false);
    expect(isRegexSafe('(a|b)+')).toBe(false);
  });
});

describe('detectRuleIndex', () => {
  it('should detect [PLAN:1] as index 0', () => {
    expect(detectRuleIndex('Analysis complete.\n[PLAN:1]', 'plan')).toBe(0);
  });

  it('should detect [PLAN:2] as index 1', () => {
    expect(detectRuleIndex('Question answered.\n[PLAN:2]', 'plan')).toBe(1);
  });

  it('should detect [PLAN:3] as index 2', () => {
    expect(detectRuleIndex('[PLAN:3]\n\nBlocked.', 'plan')).toBe(2);
  });

  it('should be case insensitive', () => {
    expect(detectRuleIndex('[plan:1]', 'plan')).toBe(0);
    expect(detectRuleIndex('[Plan:2]', 'plan')).toBe(1);
  });

  it('should match step name case-insensitively', () => {
    expect(detectRuleIndex('[IMPLEMENT:1]', 'implement')).toBe(0);
    expect(detectRuleIndex('[REVIEW:2]', 'review')).toBe(1);
  });

  it('should return -1 when no match', () => {
    expect(detectRuleIndex('No tags here.', 'plan')).toBe(-1);
  });

  it('should return -1 for [PLAN:0] (invalid)', () => {
    expect(detectRuleIndex('[PLAN:0]', 'plan')).toBe(-1);
  });

  it('should return -1 for wrong step name', () => {
    expect(detectRuleIndex('[REVIEW:1]', 'plan')).toBe(-1);
  });

  it('should handle step names with hyphens', () => {
    expect(detectRuleIndex('[AI_REVIEW:1]', 'ai_review')).toBe(0);
    expect(detectRuleIndex('[SECURITY_FIX:2]', 'security_fix')).toBe(1);
  });

  it('should detect last occurrence when multiple tags exist', () => {
    const content = 'Previous: [AI_REVIEW:1]\n\nActual result:\n[AI_REVIEW:2]';
    expect(detectRuleIndex(content, 'ai_review')).toBe(1);
  });

  it('should detect last match with multiple occurrences', () => {
    expect(detectRuleIndex('[PLAN:1] then [PLAN:2] finally [PLAN:3]', 'plan')).toBe(2);
  });
});
