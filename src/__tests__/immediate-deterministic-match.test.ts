import { describe, it, expect } from 'vitest';
import { findImmediateDeterministicMatch } from '../core/workflow/evaluation/rule-utils.js';
import type { WorkflowRule, WorkflowState } from '../core/models/types.js';

function rule(condition: string, overrides: Partial<WorkflowRule> = {}): WorkflowRule {
  return { condition, next: 'COMPLETE', ...overrides } as WorkflowRule;
}

function stateWithFindings(open: number, conflicts: number): WorkflowState {
  return {
    findings: {
      open: { count: open, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, items: [] },
      resolved: { count: 0 },
      waived: { count: 0 },
      conflicts: { count: conflicts, items: [] },
    },
  } as unknown as WorkflowState;
}

describe('findImmediateDeterministicMatch', () => {
  const rules = [
    rule('approved'),
    rule('needs_fix', { next: 'fix' }),
    rule('when(findings.conflicts.count > 0)', { next: 'ABORT' }),
  ];

  it('should return the deterministic rule index when its condition holds', () => {
    expect(findImmediateDeterministicMatch(rules, stateWithFindings(0, 1), false, 0, rules.length)).toBe(2);
  });

  it('should return -1 when no deterministic condition holds', () => {
    expect(findImmediateDeterministicMatch(rules, stateWithFindings(0, 0), false, 0, rules.length)).toBe(-1);
  });

  it('should not scan past endExclusive (positional first-match alignment)', () => {
    // 判定が index 0 (approved) を選んだ場合、後方の決定的ルールは先行しない
    expect(findImmediateDeterministicMatch(rules, stateWithFindings(0, 1), false, 0, 0)).toBe(-1);
    // 判定 index が決定的ルールより後なら先行する
    expect(findImmediateDeterministicMatch(rules, stateWithFindings(0, 1), false, 0, 3)).toBe(2);
  });

  it('should skip deferred true and non-deterministic rules', () => {
    const mixed = [rule('approved'), rule('when(true)', { next: 'fix' })];
    expect(findImmediateDeterministicMatch(mixed, stateWithFindings(0, 0), false, 0, mixed.length)).toBe(-1);
  });
});
