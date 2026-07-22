import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { normalizeArpeggio } from '../infra/config/loaders/workflowStepFeaturesNormalizer.js';
import { formatWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';

describe('workflow rule normalization', () => {
  it('rejects the removed when alias instead of translating it into a condition', () => {
    expect(() => normalizeRule({
      when: 'findings.open.count == 0',
      next: 'COMPLETE',
    })).toThrow(/condition/i);
  });

  it('rejects workflow rule ai() expressions', () => {
    expect(() => normalizeRule({
      condition: 'ai("all reviewers approved")',
      next: 'COMPLETE',
    })).toThrow(/ai\(\)|workflow rule/i);
  });

  it.each([
    'needs_fix && when(findings.provisional.count > 0)',
    'all("approved") && when(findings.conflicts.count == 0)',
    'any("needs_fix") && when(findings.open.count > 0)',
  ])('keeps %s in the single condition AST without hidden guard fields', (condition) => {
    const normalized = normalizeRule({ condition, next: 'next-step' });

    expect(typeof normalized.condition).not.toBe('string');
    expect(normalized).not.toHaveProperty('guardCondition');
    expect(normalized).not.toHaveProperty('aggregateGuardCondition');
    expect(normalized).not.toHaveProperty('isAggregateCondition');
  });

  it('formats normalized condition ASTs for observability output', () => {
    const normalized = normalizeRule({
      condition: 'all("approved", "needs_fix") && when(findings.open.count == 0)',
      next: 'next-step',
    });

    expect(formatWorkflowRuleCondition(normalized.condition))
      .toBe('all("approved", "needs_fix") && when(findings.open.count == 0)');
  });

  it('omits next when normalizing a return-only rule', () => {
    const normalized = normalizeRule({ condition: 'needs_fix', return: 'need_replan' });

    expect(normalized).not.toHaveProperty('next');
    expect(normalized.returnValue).toBe('need_replan');
  });

  it.each([
    'all("x") extra',
    'approved && && when(findings.open.count == 0)',
    'when(findings.open.count == 0) && when(findings.conflicts.count == 0)',
  ])('rejects malformed reserved condition %s without treating it as a semantic label', (condition) => {
    expect(() => normalizeRule({ condition, next: 'COMPLETE' })).toThrow();
  });

  it('should reject an invalid when predicate before creating the condition AST', () => {
    expect(() => normalizeRule({
      condition: 'when(findings.open.count ==)',
      next: 'COMPLETE',
    })).toThrow('Invalid when operand');
  });
});

describe('workflow step feature normalization', () => {
  it('normalizes arpeggio paths in the extracted helper', () => {
    const workflowDir = join(process.cwd(), 'src', '__tests__');
    const normalized = normalizeArpeggio(
      {
        source: 'files',
        source_path: 'fixtures/input.txt',
        batch_size: 5,
        concurrency: 2,
        template: 'fixtures/template.md',
        merge: {
          strategy: 'concat',
          separator: '\n',
        },
      },
      workflowDir,
    );

    expect(normalized).toMatchObject({
      source: 'files',
      batchSize: 5,
      concurrency: 2,
      sourcePath: join(workflowDir, 'fixtures/input.txt'),
      templatePath: join(workflowDir, 'fixtures/template.md'),
    });
  });
});
