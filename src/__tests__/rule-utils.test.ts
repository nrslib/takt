/**
 * Unit tests for rule-utils
 *
 * Tests tag-based rule detection, single-branch auto-selection,
 * and report file extraction from output contracts.
 */

import { describe, it, expect } from 'vitest';
import { unwrapWhenCondition,
  hasTagBasedRules,
  hasOnlyOneBranch,
  getAutoSelectedTag,
  getReportFiles,
  hasUnquotedFindingsReference,
  hasUnquotedIdentifierReference,
  isDeterministicCondition,
} from '../core/workflow/evaluation/rule-utils.js';
import type { WorkflowRule, OutputContractEntry } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

describe('hasTagBasedRules', () => {
  it('should return false when step has no rules', () => {
    const step = makeStep({ rules: undefined });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return false when rules array is empty', () => {
    const step = makeStep({ rules: [] });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return true when rules contain tag-based conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved' },
        { condition: 'rejected' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(true);
  });

  it('should return false when all rules are ai() conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', isAiCondition: true, aiConditionText: 'is it approved?' },
        { condition: 'rejected', isAiCondition: true, aiConditionText: 'is it rejected?' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return false when all rules are aggregate conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'all approved', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'approved' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return true when mixed rules include tag-based ones', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', isAiCondition: true, aiConditionText: 'approved?' },
        { condition: 'manual check' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(true);
  });

  it('should return false when all rules are deterministic when expressions', () => {
    const step = makeStep({
      rules: [
        { condition: 'when(structured.plan.action == "noop")', next: 'COMPLETE' },
        { condition: 'when(context.route.task.exists == true)', next: 'ABORT' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(false);
  });
});

describe('unwrapWhenCondition', () => {
  it('should throw on non-when input (caller contract violation)', () => {
    expect(() => unwrapWhenCondition('approved')).toThrow('requires a when(...) condition');
  });
});

describe('isDeterministicCondition', () => {
  it('should return true for structured when expressions', () => {
    expect(isDeterministicCondition('when(structured.plan_followup.action == "noop")')).toBe(true);
    // 裸の式はもう決定的扱いしない（when() 明示構文のみ）
    expect(isDeterministicCondition('structured.plan_followup.action == "noop"')).toBe(false);
  });

  it('should return false for plain tag conditions', () => {
    expect(isDeterministicCondition('approved')).toBe(false);
  });
});

describe('hasUnquotedFindingsReference', () => {
  it('ignores findings references inside escaped quoted strings', () => {
    expect(hasUnquotedFindingsReference(String.raw`structured.message == "ignore \"findings.open.count\" here"`)).toBe(false);
  });

  it('detects findings references after a closed quoted string', () => {
    expect(hasUnquotedFindingsReference(String.raw`structured.message == "path \\" && findings.open.count == 0`)).toBe(true);
  });
});

describe('hasUnquotedIdentifierReference', () => {
  it('detects a real, unquoted, complete identifier reference', () => {
    expect(hasUnquotedIdentifierReference('findings.rounds.budgetExhausted == true', 'findings.rounds.budgetExhausted')).toBe(true);
    expect(hasUnquotedIdentifierReference('findings.provisional.fixpoint == true && findings.conflicts.count == 0', 'findings.provisional.fixpoint')).toBe(true);
  });

  it('ignores an identifier that only appears inside a quoted string literal (codex 3rd-pass counter-example)', () => {
    const condition = 'findings.rounds.budgetExhausted == true && structured.meta.label != "findings.provisional.fixpoint"';
    // The quoted occurrence is a string literal, not a reference — must not be detected.
    expect(hasUnquotedIdentifierReference(condition, 'findings.provisional.fixpoint')).toBe(false);
    // The real, unquoted reference IS detected.
    expect(hasUnquotedIdentifierReference(condition, 'findings.rounds.budgetExhausted')).toBe(true);
  });

  it('does not match an identifier that is only a substring of a longer identifier', () => {
    // trailing boundary: "findings.provisional.fixpointish" must not count as the fixpoint signal
    expect(hasUnquotedIdentifierReference('findings.provisional.fixpointish == true', 'findings.provisional.fixpoint')).toBe(false);
    // leading boundary: a different dotted path that ends with the same tail
    expect(hasUnquotedIdentifierReference('other.findings.rounds.budgetExhausted == true', 'findings.rounds.budgetExhausted')).toBe(false);
  });

  it('ignores an identifier hidden inside an escaped-quote string literal', () => {
    expect(hasUnquotedIdentifierReference(String.raw`structured.message == "ignore \"findings.provisional.fixpoint\" here"`, 'findings.provisional.fixpoint')).toBe(false);
  });
});

describe('hasOnlyOneBranch', () => {
  it('should return false when rules is undefined', () => {
    const step = makeStep({ rules: undefined });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });

  it('should return false when rules array is empty', () => {
    const step = makeStep({ rules: [] });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });

  it('should return true when exactly one rule exists', () => {
    const step = makeStep({
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    expect(hasOnlyOneBranch(step)).toBe(true);
  });

  it('should return false when multiple rules exist', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', next: 'implement' },
        { condition: 'rejected', next: 'review' },
      ],
    });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });
});

describe('getAutoSelectedTag', () => {
  it('should return uppercase tag for single-branch step', () => {
    const step = makeStep({
      name: 'ai-review',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    expect(getAutoSelectedTag(step)).toBe('[AI-REVIEW:1]');
  });

  it('should throw when multiple branches exist', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', next: 'implement' },
        { condition: 'rejected', next: 'review' },
      ],
    });
    expect(() => getAutoSelectedTag(step)).toThrow('Cannot auto-select tag when multiple branches exist');
  });

  it('should throw when no rules exist', () => {
    const step = makeStep({ rules: undefined });
    expect(() => getAutoSelectedTag(step)).toThrow('Cannot auto-select tag when multiple branches exist');
  });
});

describe('getReportFiles', () => {
  it('should return empty array when outputContracts is undefined', () => {
    expect(getReportFiles(undefined)).toEqual([]);
  });

  it('should return empty array when outputContracts is empty', () => {
    expect(getReportFiles([])).toEqual([]);
  });

  it('should extract name from OutputContractItem entries', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md', format: '00-plan', useJudge: true },
      { name: '01-review.md', format: '01-review', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['00-plan.md', '01-review.md']);
  });

  it('should extract path from OutputContractLabelPath entries', () => {
    const contracts: OutputContractEntry[] = [
      { name: 'scope.md', format: 'scope', useJudge: true },
      { name: 'decisions.md', format: 'decisions', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['scope.md', 'decisions.md']);
  });

  it('should handle mixed entry types', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md', format: '00-plan', useJudge: true },
      { name: 'review.md', format: 'review', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['00-plan.md', 'review.md']);
  });
});

describe('generateStatusRulesComponents interactive default', () => {
  const rules = [
    { condition: 'approved', next: 'COMPLETE' },
    { condition: 'ユーザー入力が必要', next: 'ask', interactiveOnly: true },
  ] as WorkflowRule[];

  it('should exclude interactive-only rules from the criteria table when interactive is unspecified', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', rules, 'ja');

    expect(components.criteriaTable).toContain('approved');
    expect(components.criteriaTable).not.toContain('ユーザー入力が必要');
  });

  it('should include interactive-only rules in the criteria table when interactive is true', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', rules, 'ja', { interactive: true });

    expect(components.criteriaTable).toContain('ユーザー入力が必要');
  });
});
