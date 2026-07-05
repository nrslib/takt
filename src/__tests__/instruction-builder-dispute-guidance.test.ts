import { describe, it, expect } from 'vitest';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { ledgerHasOpenFindings } from '../core/workflow/findings/context.js';
import type { FindingLedger } from '../core/models/finding-types.js';
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

function makeContext(options: { hasOpenFindings: boolean; rawFindingsJsonSchema?: Record<string, unknown> }): InstructionContext {
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
      ledgerSummary: '{}',
      reportLedgerSummary: '{}',
      hasOpenFindings: options.hasOpenFindings,
      ...(options.rawFindingsJsonSchema !== undefined ? { rawFindingsJsonSchema: options.rawFindingsJsonSchema } : {}),
    },
  } as unknown as InstructionContext;
}

/** Finding Contract セクション（appendFindingContractInstruction の出力範囲）を切り出す */
function extractFindingContractSection(instruction: string): string {
  const start = instruction.indexOf('## Finding Contract');
  expect(start).toBeGreaterThanOrEqual(0);
  return instruction.slice(start);
}

describe('dispute guidance injection', () => {
  it('should omit the dispute guidance when the ledger has no open findings', () => {
    const instruction = new InstructionBuilder(makeStep(), makeContext({ hasOpenFindings: false })).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('Consolidated ledger copy');
    expect(section).not.toContain('Disputed Findings');
    expect(section).not.toContain('dispute claim');
  });

  it('should inject the dispute guidance when open findings exist', () => {
    const instruction = new InstructionBuilder(makeStep(), makeContext({ hasOpenFindings: true })).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('"## Disputed Findings" heading');
    expect(section).toContain('findingId: the ledger finding id');
    expect(section).toContain('evidence: file:line references backing the reason');
  });

  it('should not inject dispute guidance when rawFindingsJsonSchema is present (reviewer branch wins)', () => {
    const instruction = new InstructionBuilder(
      makeStep(),
      makeContext({ hasOpenFindings: true, rawFindingsJsonSchema: { type: 'object' } }),
    ).build();

    const section = extractFindingContractSection(instruction);
    expect(section).toContain('raw findings schema');
    expect(section).not.toContain('Disputed Findings');
    expect(section).not.toContain('dispute claim');
  });
});

describe('ledgerHasOpenFindings', () => {
  function makeLedger(statuses: Array<'open' | 'resolved' | 'waived'>): FindingLedger {
    return {
      version: 1,
      workflowName: 'w',
      nextId: statuses.length + 1,
      updatedAt: '2026-07-05T00:00:00.000Z',
      rawFindings: [],
      conflicts: [],
      findings: statuses.map((status, index) => ({
        id: `F-000${index + 1}`,
        status,
        lifecycle: status === 'open' ? 'new' : status,
        severity: 'high',
        title: `Finding ${index + 1}`,
        reviewers: ['reviewer'],
        rawFindingIds: [],
        firstSeen: { runId: 'r', stepName: 's', timestamp: '2026-07-05T00:00:00.000Z' },
        lastSeen: { runId: 'r', stepName: 's', timestamp: '2026-07-05T00:00:00.000Z' },
      })),
    };
  }

  it('should be false for an empty ledger', () => {
    expect(ledgerHasOpenFindings(makeLedger([]))).toBe(false);
  });

  it('should be false when all findings are resolved or waived', () => {
    expect(ledgerHasOpenFindings(makeLedger(['resolved', 'waived']))).toBe(false);
  });

  it('should be true when any finding is open', () => {
    expect(ledgerHasOpenFindings(makeLedger(['resolved', 'open', 'waived']))).toBe(true);
  });
});
