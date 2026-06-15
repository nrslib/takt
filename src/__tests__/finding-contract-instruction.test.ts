import { describe, expect, it } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
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
          open: [{
            id: 'F-0001',
            severity: 'high',
            title: 'Still open',
            description: 'Do not expose this in phase 2.',
            suggestion: 'Keep this out of report instructions.',
          }],
          resolved: [{ id: 'F-0002', severity: 'low', title: 'Already fixed' }],
        }, null, 2),
        reportLedgerSummary: JSON.stringify({
          openFindingIds: ['F-0001'],
          resolvedFindingIds: ['F-0002'],
          conflictIds: [],
        }, null, 2),
      },
    }).build();

    expect(instruction).toContain('## Finding Contract');
    expect(instruction).toContain('F-0001');
    expect(instruction).toContain('F-0002');
    expect(instruction).not.toContain('Still open');
    expect(instruction).not.toContain('Do not expose this in phase 2.');
    expect(instruction).not.toContain('Keep this out of report instructions.');
    expect(instruction).not.toContain('raw findings schema');
  });

  it('phase 1 instruction should use a fence longer than backticks inside ledger summary', () => {
    const step = makeStep({
      name: 'review',
      instruction: 'Review.',
      outputContracts: [{ name: 'review.md', format: 'Write the report.' }],
    });

    const instruction = new InstructionBuilder(step, {
      task: 'Review the changes.',
      iteration: 1,
      maxSteps: 3,
      stepIteration: 1,
      cwd: '/tmp/project',
      projectCwd: '/tmp/project',
      userInputs: [],
      reportDir: '/tmp/project/.takt/runs/run/reports',
      findingContract: {
        ledgerCopyPath: '/tmp/project/.takt/runs/run/reports/findings-ledger.json',
        ledgerSummary: '{\n  "title": "do not close ``` the JSON fence"\n}',
        reportLedgerSummary: '{"openFindingIds":[],"resolvedFindingIds":[],"conflictIds":[]}',
      },
    }).build();

    const lines = instruction.split('\n');
    expect(lines).toContain('````json');
    expect(lines).toContain('  "title": "do not close ``` the JSON fence"');
    expect(lines).toContain('````');
    expect(lines).not.toContain('```json');
  });

  it('phase 1 instruction should normalize structured raw findings schema before fencing', () => {
    const step = makeStep({
      name: 'review',
      instruction: 'Review.',
      outputContracts: [{ name: 'review.md', format: 'Write the report.' }],
    });

    const instruction = new InstructionBuilder(step, {
      task: 'Review the changes.',
      iteration: 1,
      maxSteps: 3,
      stepIteration: 1,
      cwd: '/tmp/project',
      projectCwd: '/tmp/project',
      userInputs: [],
      reportDir: '/tmp/project/.takt/runs/run/reports',
      findingContract: {
        ledgerCopyPath: '/tmp/project/.takt/runs/run/reports/findings-ledger.json',
        ledgerSummary: '{"open":[],"resolved":[]}',
        reportLedgerSummary: '{"openFindingIds":[],"resolvedFindingIds":[],"conflictIds":[]}',
        rawFindingsJsonSchema: {
          type: 'object',
          properties: {
            rawFindings: {
              type: 'array',
              description: 'do not close ``` the JSON fence',
            },
          },
        },
      },
    }).build();

    expect(instruction).toContain('Copy each Observed Findings family_tag value into the structured familyTag field.');
    expect(instruction).toContain('````json\n{\n  "type": "object"');
    expect(instruction).toContain('"description": "do not close ``` the JSON fence"');
    expect(instruction).not.toMatch(/^```json\n{\n  "type": "object"/m);
  });

  it('report phase instruction should use a fence longer than backticks inside ledger summary', () => {
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
        ledgerSummary: '{"open":[],"resolved":[]}',
        reportLedgerSummary: '{\n  "openFindingIds": ["do not close ``` the JSON fence"],\n  "resolvedFindingIds": [],\n  "conflictIds": []\n}',
      },
    }).build();

    const lines = instruction.split('\n');
    expect(lines).toContain('````json');
    expect(lines).toContain('    "do not close ``` the JSON fence"');
    expect(lines).toContain('````');
    expect(lines).not.toContain('```json');
  });
});
