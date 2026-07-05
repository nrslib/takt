import { describe, it, expect } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import type { WorkflowStep } from '../core/models/types.js';

function makeStep(): WorkflowStep {
  return {
    kind: 'agent',
    name: 'fix',
    persona: 'bench-coder',
    instruction: 'Fix the findings.',
    edit: true,
  } as WorkflowStep;
}

function makeContext(ledgerSummary: string): InstructionContext {
  return {
    task: 'task',
    iteration: 1,
    maxSteps: 10,
    stepIteration: 1,
    cwd: '/tmp',
    projectCwd: '/tmp',
    userInputs: [],
    language: 'en',
    findingContract: {
      ledgerCopyPath: '/tmp/.takt/findings/ledger.json',
      ledgerSummary,
      reportLedgerSummary: '{}',
    },
  } as unknown as InstructionContext;
}

describe('dispute guidance injection', () => {
  it('should omit the dispute guidance when the ledger has no open findings', () => {
    const instruction = new InstructionBuilder(makeStep(), makeContext(JSON.stringify({ open: [], resolved: [], waived: [] }))).build();

    expect(instruction).not.toContain('Disputed Findings');
  });

  it('should inject the dispute guidance when open findings exist', () => {
    const summary = JSON.stringify({
      open: [{ id: 'F-0001', severity: 'high', title: 'Issue' }],
      resolved: [],
      waived: [],
    });
    const instruction = new InstructionBuilder(makeStep(), makeContext(summary)).build();

    expect(instruction).toContain('Disputed Findings');
  });

  it('should not inject coder guidance into reviewer instructions even with open findings', () => {
    const summary = JSON.stringify({ open: [{ id: 'F-0001', severity: 'high', title: 'Issue' }], resolved: [] });
    const context = makeContext(summary);
    (context.findingContract as { rawFindingsJsonSchema?: object }).rawFindingsJsonSchema = { type: 'object' };
    const instruction = new InstructionBuilder(makeStep(), context).build();

    expect(instruction).not.toContain('## Disputed Findings');
  });
});
