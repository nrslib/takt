import { describe, it, expect } from 'vitest';
import { isValidRuleIndex, buildJudgeConditions } from '../agents/judge-utils.js';
import type { WorkflowRule } from '../core/models/types.js';

function rule(condition: string): WorkflowRule {
  return { condition, next: 'COMPLETE' } as WorkflowRule;
}

describe('deterministic conditions are not model-selectable', () => {
  const rules = [
    rule('approved'),
    rule('needs_fix'),
    rule('when(findings.open.count > 0)'),
    rule('when(findings.conflicts.count > 0)'),
  ];

  it('should reject a judged index that points at a deterministic rule', () => {
    // 実走事例: final-gate の判定が findings.conflicts.count > 0 を「選択」し、
    // 実際には conflict ゼロなのに ABORT した
    expect(isValidRuleIndex(3, rules, false)).toBe(false);
    expect(isValidRuleIndex(2, rules, false)).toBe(false);
    expect(isValidRuleIndex(0, rules, false)).toBe(true);
    expect(isValidRuleIndex(1, rules, false)).toBe(true);
  });

  it('should exclude deterministic rules from the judge condition list', () => {
    const conditions = buildJudgeConditions(rules, false);

    expect(conditions.map((c) => c.text)).toEqual(['approved', 'needs_fix']);
    // 元のルール index を保持する（番号の付け替えで誤採用しない）
    expect(conditions.map((c) => c.index)).toEqual([0, 1]);
  });
});
