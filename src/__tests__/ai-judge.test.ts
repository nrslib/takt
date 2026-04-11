/**
 * Tests for AI judge (ai() condition evaluation)
 */

import { describe, it, expect } from 'vitest';
import { detectJudgeIndex, buildJudgePrompt, isValidRuleIndex, buildJudgeConditions } from '../agents/judge-utils.js';

describe('detectJudgeIndex', () => {
  it('should detect [JUDGE:1] as index 0', () => {
    expect(detectJudgeIndex('[JUDGE:1]')).toBe(0);
  });

  it('should detect [JUDGE:3] as index 2', () => {
    expect(detectJudgeIndex('Some output [JUDGE:3] more text')).toBe(2);
  });

  it('should return -1 for no match', () => {
    expect(detectJudgeIndex('No judge tag here')).toBe(-1);
  });

  it('should return -1 for [JUDGE:0]', () => {
    expect(detectJudgeIndex('[JUDGE:0]')).toBe(-1);
  });

  it('should be case-insensitive', () => {
    expect(detectJudgeIndex('[judge:2]')).toBe(1);
  });
});

describe('buildJudgePrompt', () => {
  it('should build a well-structured judge prompt', () => {
    const agentOutput = 'Code implementation complete.\n\nAll tests pass.';
    const conditions = [
      { index: 0, text: 'No issues found' },
      { index: 1, text: 'Issues detected that need fixing' },
    ];

    const prompt = buildJudgePrompt(agentOutput, conditions);

    expect(prompt).toContain('# Judge Task');
    expect(prompt).toContain('Code implementation complete.');
    expect(prompt).toContain('All tests pass.');
    expect(prompt).toContain('| 1 | No issues found |');
    expect(prompt).toContain('| 2 | Issues detected that need fixing |');
    expect(prompt).toContain('[JUDGE:N]');
  });

  it('should handle single condition', () => {
    const prompt = buildJudgePrompt('output', [{ index: 0, text: 'Always true' }]);

    expect(prompt).toContain('| 1 | Always true |');
  });
});

describe('isValidRuleIndex', () => {
  const rules = [
    { condition: 'approved', next: 'done' },
    { condition: 'blocked', next: 'wait', interactiveOnly: true },
  ];

  it('should return false for negative index', () => {
    expect(isValidRuleIndex(-1, rules, false)).toBe(false);
  });

  it('should return false for index >= rules.length', () => {
    expect(isValidRuleIndex(2, rules, false)).toBe(false);
  });

  it('should return true for non-interactiveOnly rule', () => {
    expect(isValidRuleIndex(0, rules, false)).toBe(true);
  });

  it('should return false for interactiveOnly rule when interactive=false', () => {
    expect(isValidRuleIndex(1, rules, false)).toBe(false);
  });

  it('should return true for interactiveOnly rule when interactive=true', () => {
    expect(isValidRuleIndex(1, rules, true)).toBe(true);
  });
});

describe('buildJudgeConditions', () => {
  const rules = [
    { condition: 'approved', next: 'done' },
    { condition: 'blocked', next: 'wait', interactiveOnly: true },
  ];

  it('should include all conditions when interactive=true', () => {
    expect(buildJudgeConditions(rules, true)).toEqual([
      { index: 0, text: 'approved' },
      { index: 1, text: 'blocked' },
    ]);
  });

  it('should exclude interactiveOnly conditions when interactive=false', () => {
    expect(buildJudgeConditions(rules, false)).toEqual([
      { index: 0, text: 'approved' },
    ]);
  });

  it('should return empty array for empty rules', () => {
    expect(buildJudgeConditions([], false)).toEqual([]);
  });

  it('should preserve provided original indexes', () => {
    expect(buildJudgeConditions([rules[0]], true, [2])).toEqual([
      { index: 2, text: 'approved' },
    ]);
  });
});
