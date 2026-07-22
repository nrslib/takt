import { describe, it, expect } from 'vitest';
import {
  formatWorkflowRuleCondition,
  hasFindingsReference,
  hasUnquotedFindingsReference,
  parseWorkflowRuleCondition,
  semanticLabelsOf,
} from '../core/models/workflow-rule-condition.js';
import type { WorkflowRule } from '../core/models/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

function rule(condition: string, interactiveOnly = false): WorkflowRule {
  return normalizeRule({ condition, next: 'COMPLETE', ...(interactiveOnly ? { interactiveOnly } : {}) });
}

describe('hasUnquotedFindingsReference', () => {
  it('condition AST public operations recurse over an and condition directly', () => {
    const condition = parseWorkflowRuleCondition('approved && when(findings.open.count == 0)');

    expect(condition).toEqual({
      kind: 'and',
      left: { kind: 'semantic', label: 'approved' },
      right: { kind: 'when', expression: 'findings.open.count == 0' },
    });
    expect(formatWorkflowRuleCondition(condition)).toBe('approved && when(findings.open.count == 0)');
    expect(semanticLabelsOf(condition)).toEqual(['approved']);
    expect(hasFindingsReference(condition)).toBe(true);
  });

  it('ignores findings references inside escaped quoted strings', () => {
    expect(hasUnquotedFindingsReference(String.raw`structured.message == "ignore \"findings.open.count\" here"`)).toBe(false);
  });

  it('detects findings references after a closed quoted string', () => {
    expect(hasUnquotedFindingsReference(String.raw`structured.message == "path \\" && findings.open.count == 0`)).toBe(true);
  });
  it('classifies only an unquoted findings state access as a findings reference', () => {
    expect(hasFindingsReference(parseWorkflowRuleCondition('when(structured.note == "findings.open.count")'))).toBe(false);
    expect(hasFindingsReference(parseWorkflowRuleCondition('when(findings.open.count == 0)'))).toBe(true);
  });

  it('rejects empty when expressions at the normalization boundary', () => {
    expect(() => parseWorkflowRuleCondition('when()')).toThrow('empty when() expression');
    expect(() => parseWorkflowRuleCondition('approved && when(  )')).toThrow('empty when() expression');
    expect(() => parseWorkflowRuleCondition('all("approved") && when()')).toThrow('empty when() expression');
  });
});

describe('generateStatusRulesComponents interactive default', () => {
  const rules = [rule('approved'), rule('ユーザー入力が必要', true)];

  it('should exclude interactive-only rules from the criteria table when interactive is unspecified', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', [{ label: 'approved' }], 'ja');

    expect(components.criteriaTable).toContain('approved');
    expect(components.criteriaTable).not.toContain('ユーザー入力が必要');
  });

  it('should include interactive-only rules in the criteria table when interactive is true', async () => {
    const { generateStatusRulesComponents } = await import('../core/workflow/instruction/status-rules.js');

    const components = generateStatusRulesComponents('gate', [
      { label: 'approved' },
      { label: 'ユーザー入力が必要' },
    ], 'ja');

    expect(components.criteriaTable).toContain('ユーザー入力が必要');
  });
});
