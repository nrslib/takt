import { describe, expect, it } from 'vitest';
import { detectJudgeIndex } from '../agents/judge-utils.js';
import {
  needsSemanticStatusJudgment,
  semanticRuleCandidatesOf,
} from '../core/models/workflow-rule-condition.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('detectJudgeIndex', () => {
  it('converts a one-based judge tag to a candidate index', () => {
    expect(detectJudgeIndex('Some output [JUDGE:3] more text')).toBe(2);
  });

  it('rejects missing and zero judge tags', () => {
    expect(detectJudgeIndex('No judge tag here')).toBe(-1);
    expect(detectJudgeIndex('[JUDGE:0]')).toBe(-1);
  });
});

describe('semanticRuleCandidatesOf', () => {
  it('keeps the first YAML occurrence of each interactive candidate', () => {
    const rules = [
      normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      normalizeRule({ condition: 'needs_fix && when(findings.open.count > 0)', next: 'fix' }),
      normalizeRule({ condition: 'approved && when(findings.open.count == 0)', next: 'COMPLETE' }),
      normalizeRule({ condition: 'when(findings.conflicts.count > 0)', next: 'ABORT' }),
      normalizeRule({ condition: 'blocked', next: 'wait', interactive_only: true }),
    ];

    expect(semanticRuleCandidatesOf(rules, false)).toEqual([
      { label: 'approved' },
      { label: 'needs_fix' },
    ]);
    expect(semanticRuleCandidatesOf(rules, true)).toEqual([
      { label: 'approved' },
      { label: 'needs_fix' },
      { label: 'blocked' },
    ]);
  });

  it('requires status judgment only for multiple active semantic candidates', () => {
    const rules = [
      normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      normalizeRule({ condition: 'blocked', next: 'wait', interactive_only: true }),
    ];

    expect(needsSemanticStatusJudgment(rules, false)).toBe(false);
    expect(needsSemanticStatusJudgment(rules, true)).toBe(true);
  });
});
