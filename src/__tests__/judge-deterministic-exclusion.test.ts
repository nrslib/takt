import { describe, expect, it } from 'vitest';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('semantic rule candidate selection', () => {
  it('excludes machine conditions and deduplicates semantic labels in YAML order', () => {
    const rules = [
      normalizeRule({ condition: 'needs_fix && when(findings.provisional.count > 0)', next: 'replan' }),
      normalizeRule({ condition: 'when(findings.conflicts.count > 0)', next: 'ABORT' }),
      normalizeRule({ condition: 'needs_fix && when(findings.conflicts.count == 0)', next: 'fix' }),
      normalizeRule({ condition: 'approved && when(findings.open.count == 0)', next: 'COMPLETE' }),
    ];

    expect(semanticRuleCandidatesOf(rules, false)).toEqual([
      { label: 'needs_fix' },
      { label: 'approved' },
    ]);
  });
});
