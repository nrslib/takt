import { describe, expect, it } from 'vitest';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeStep } from './test-helpers.js';

describe('Finding Contract instruction context', () => {
  it('report phase instruction should include inline ledger ids without raw findings schema', () => {
    const step = makeStep({
      name: 'review',
      instruction: 'Review.',
      outputContracts: [{ name: 'review.md', format: 'Write the report.' }],
    });

    const instruction = new ReportInstructionBuilder(step, {
      cwd: '/tmp/project',
      reportDir: '/tmp/project/.takt/runs/run/reports',
      stepIteration: 1,
      targetFile: 'review.md',
      findingContract: {
        ledgerCopyPath: '/tmp/project/.takt/runs/run/reports/findings-ledger.json',
        ledgerSummary: JSON.stringify({
          open: [{ id: 'F-0001', severity: 'high', title: 'Still open' }],
          resolved: [{ id: 'F-0002', severity: 'low', title: 'Already fixed' }],
        }, null, 2),
      },
    }).build();

    expect(instruction).toContain('## Finding Contract');
    expect(instruction).toContain('F-0001');
    expect(instruction).toContain('F-0002');
    expect(instruction).not.toContain('raw findings schema');
  });
});
