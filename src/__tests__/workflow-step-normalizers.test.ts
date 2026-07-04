import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { normalizeLoopMonitors } from '../infra/config/loaders/workflowLoopMonitorNormalizer.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { normalizeArpeggio } from '../infra/config/loaders/workflowStepFeaturesNormalizer.js';

describe('workflow step normalizer helpers', () => {
  it('normalizes aggregate rules in the extracted rule helper', () => {
    const normalized = normalizeRule({
      condition: 'all("done", "approved")',
      next: 'COMPLETE',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateType).toBe('all');
    expect(normalized.aggregateConditionText).toEqual(['done', 'approved']);
  });

  it('normalizes aggregate rules whose argument quotes are backslash-escaped', () => {
    const normalized = normalizeRule({
      condition: String.raw`all(\"approved\")`,
      next: 'COMPLETE',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateType).toBe('all');
    expect(normalized.aggregateConditionText).toBe('approved');
  });

  it('normalizes aggregate rules with deterministic guards', () => {
    const normalized = normalizeRule({
      condition: 'any("needs_fix") && findings.conflicts.count == 0',
      next: 'fix',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateType).toBe('any');
    expect(normalized.aggregateConditionText).toBe('needs_fix');
    expect(normalized.aggregateGuardCondition).toBe('findings.conflicts.count == 0');
  });

  it('rejects whitespace-only quoted aggregate rules through the rule helper', () => {
    expect(() => normalizeRule({
      condition: 'all("   ")',
      next: 'COMPLETE',
    })).toThrow('Invalid aggregate condition format');
    expect(() => normalizeRule({
      condition: String.raw`any(\"   \")`,
      next: 'fix',
    })).toThrow('Invalid aggregate condition format');
  });

  it('normalizes aggregate arguments with escaped quotes through the rule helper', () => {
    const targetCondition = String.raw`condition == "test\"inner"`;
    const normalized = normalizeRule({
      condition: String.raw`all("condition == \"test\\\"inner\"") && findings.open.count == 0`,
      next: 'COMPLETE',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateConditionText).toBe(targetCondition);
    expect(normalized.aggregateGuardCondition).toBe('findings.open.count == 0');
  });

  it('normalizes unquoted aggregate condition expressions as matched rule text', () => {
    const targetCondition = String.raw`condition == "test\"inner"`;
    const normalized = normalizeRule({
      condition: String.raw`all(condition == "test\"inner") && findings.open.count == 0`,
      next: 'COMPLETE',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateType).toBe('all');
    expect(normalized.aggregateConditionText).toBe(targetCondition);
    expect(normalized.aggregateGuardCondition).toBe('findings.open.count == 0');
  });

  it('normalizes aggregate arguments when an even backslash run closes the quote', () => {
    const normalized = normalizeRule({
      condition: String.raw`any("path ends with \\") && findings.conflicts.count == 0`,
      next: 'fix',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.aggregateConditionText).toBe('path ends with \\');
    expect(normalized.aggregateGuardCondition).toBe('findings.conflicts.count == 0');
  });

  it('normalizes loop monitor judges in the extracted helper', () => {
    const normalized = normalizeLoopMonitors(
      [
        {
          cycle: ['review', 'fix'],
          threshold: 2,
          judge: {
            persona: 'supervisor',
            instruction: '{task}',
            rules: [{ condition: 'continue', next: 'review' }],
          },
        },
      ],
      process.cwd(),
      {
        personas: {},
        resolvedPolicies: undefined,
        resolvedKnowledge: undefined,
        resolvedInstructions: undefined,
        resolvedReportFormats: undefined,
      },
    );

    expect(normalized).toEqual([
      {
        cycle: ['review', 'fix'],
        threshold: 2,
        judge: {
          sessionKey: undefined,
          persona: 'supervisor',
          personaPath: undefined,
          provider: undefined,
          model: undefined,
          modelSpecified: false,
          providerOptions: undefined,
          instruction: '{task}',
          rules: [{ condition: 'continue', next: 'review' }],
        },
      },
    ]);
  });

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

describe('normalizeRule tag-and-findings compound conditions', () => {
  it('should split a tag condition with a findings guard', () => {
    const normalized = normalizeRule({ condition: 'approved && findings.open.count == 0', next: 'COMPLETE' });

    expect(normalized.condition).toBe('approved');
    expect(normalized.guardCondition).toBe('findings.open.count == 0');
    expect(normalized.isAggregateCondition).toBeUndefined();
  });

  it('should join multiple findings clauses into one guard', () => {
    const normalized = normalizeRule({
      condition: 'approved && findings.open.count == 0 && findings.conflicts.count == 0',
      next: 'COMPLETE',
    });

    expect(normalized.condition).toBe('approved');
    expect(normalized.guardCondition).toBe('findings.open.count == 0 && findings.conflicts.count == 0');
  });

  it('should not split pure findings conditions', () => {
    const normalized = normalizeRule({ condition: 'findings.open.count > 0', next: 'fix' });

    expect(normalized.condition).toBe('findings.open.count > 0');
    expect(normalized.guardCondition).toBeUndefined();
  });

  it('should not split plain tag conditions or non-findings compounds', () => {
    expect(normalizeRule({ condition: 'approved', next: 'COMPLETE' }).guardCondition).toBeUndefined();
    expect(normalizeRule({ condition: 'approved && rejected', next: 'COMPLETE' }).guardCondition).toBeUndefined();
  });

  it('should keep aggregate guard splitting on the aggregate path', () => {
    const normalized = normalizeRule({
      condition: 'all("approved") && findings.open.count == 0',
      next: 'COMPLETE',
    });

    expect(normalized.isAggregateCondition).toBe(true);
    expect(normalized.guardCondition).toBeUndefined();
  });
});
