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
          persona: 'supervisor',
          personaPath: undefined,
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
