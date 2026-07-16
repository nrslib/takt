import { describe, expect, it } from 'vitest';
import {
  classifyRawFindingsMechanically,
  mergeFindingManagerOutputs,
} from '../core/workflow/findings/mechanical-classification.js';
import { validateFindingManagerOutput } from '../core/workflow/findings/manager-output-validation.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-current',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Current issue',
    description: 'The issue is present in the current review.',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    location: 'src/a.ts:10',
    reviewers: ['architecture-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing', location: 'src/a.ts:10' })],
    conflicts: [],
    findings: [makeFinding()],
    ...overrides,
  };
}

describe('classifyRawFindingsMechanically', () => {
  it('Given a resolution confirmation targeting an open finding When classified Then it lands in resolvedFindings without residual', () => {
    const raw = makeRawFinding({
      rawFindingId: 'raw-confirm',
      kind: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      description: 'Verified fixed at src/a.ts:10.',
    });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([]);
    expect(result.output.resolvedFindings).toEqual([
      { findingId: 'F-0001', rawFindingIds: ['raw-confirm'], evidence: 'Verified fixed at src/a.ts:10.' },
    ]);
  });

  it('Given multiple confirmations for the same finding When classified Then rawFindingIds are merged into one entry', () => {
    const raws = [
      makeRawFinding({ rawFindingId: 'raw-c1', kind: 'resolution_confirmation', targetFindingId: 'F-0001' }),
      makeRawFinding({ rawFindingId: 'raw-c2', kind: 'resolution_confirmation', targetFindingId: 'F-0001' }),
    ];
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: raws });
    expect(result.output.resolvedFindings).toHaveLength(1);
    expect(result.output.resolvedFindings[0]?.rawFindingIds).toEqual(['raw-c1', 'raw-c2']);
  });

  it('Given a confirmation targeting a missing finding When classified Then it goes to residual', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-confirm', kind: 'resolution_confirmation', targetFindingId: 'F-9999' });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given a confirmation targeting an already resolved finding When classified Then it goes to residual', () => {
    const ledger = makeLedger({ findings: [makeFinding({ status: 'resolved' })] });
    const raw = makeRawFinding({ rawFindingId: 'raw-confirm', kind: 'resolution_confirmation', targetFindingId: 'F-0001' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given an issue with exact location and familyTag match to one open finding When classified Then it lands in matches', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', kind: 'issue', location: 'src/a.ts:10', familyTag: 'bug' });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([]);
    expect(result.output.matches).toEqual([{ findingId: 'F-0001', rawFindingIds: ['raw-issue'] }]);
  });

  it('Given an issue whose location matches but familyTag differs When classified Then it goes to residual', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', kind: 'issue', location: 'src/a.ts:10', familyTag: 'security' });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.output.matches).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given an issue matching a resolved finding location When classified Then it goes to residual as a reopen candidate', () => {
    const ledger = makeLedger({ findings: [makeFinding({ status: 'resolved' })] });
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', kind: 'issue', location: 'src/a.ts:10' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.output.matches).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given an issue matching two open findings at the same location and tag When classified Then it goes to residual', () => {
    const ledger = makeLedger({
      rawFindings: [
        makeRawFinding({ rawFindingId: 'raw-e1', location: 'src/a.ts:10' }),
        makeRawFinding({ rawFindingId: 'raw-e2', location: 'src/a.ts:10' }),
      ],
      findings: [
        makeFinding({ id: 'F-0001', rawFindingIds: ['raw-e1'] }),
        makeFinding({ id: 'F-0002', rawFindingIds: ['raw-e2'] }),
      ],
    });
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', kind: 'issue', location: 'src/a.ts:10' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given an issue without location When classified Then it goes to residual', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', kind: 'issue', location: undefined });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given a fully mechanical round When validated with the real validator Then the output passes', () => {
    const raws = [
      makeRawFinding({ rawFindingId: 'raw-confirm', kind: 'resolution_confirmation', targetFindingId: 'F-0001', description: 'Verified.' }),
    ];
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: raws });
    const validation = validateFindingManagerOutput({
      previousLedger: makeLedger(),
      rawFindings: raws,
      managerOutput: result.output,
    });
    expect(validation.ok).toBe(true);
  });
});

describe('mergeFindingManagerOutputs', () => {
  function makeOutput(overrides: Partial<FindingManagerOutput> = {}): FindingManagerOutput {
    return {
      matches: [],
      newFindings: [],
      resolvedFindings: [],
      reopenedFindings: [],
      conflicts: [],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      ...overrides,
    };
  }

  it('Given both sides matched the same finding When merged Then rawFindingIds are unioned without duplicates', () => {
    const base = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-a', 'raw-b'] }] });
    const extra = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-b', 'raw-c'] }] });
    const merged = mergeFindingManagerOutputs(base, extra);
    expect(merged.matches).toEqual([{ findingId: 'F-0001', rawFindingIds: ['raw-a', 'raw-b', 'raw-c'] }]);
  });

  it('Given disjoint categories When merged Then all entries are preserved', () => {
    const base = makeOutput({ resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-c1'], evidence: 'e1' }] });
    const extra = makeOutput({
      newFindings: [{ rawFindingIds: ['raw-n'], title: 'New issue', severity: 'low' }],
      disputeNotes: [{ findingId: 'F-0002', reason: 'r', evidence: 'e' }],
    });
    const merged = mergeFindingManagerOutputs(base, extra);
    expect(merged.resolvedFindings).toHaveLength(1);
    expect(merged.newFindings).toHaveLength(1);
    expect(merged.disputeNotes).toHaveLength(1);
  });

  it('Given the base output When merged Then the base arrays are not mutated', () => {
    const base = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-a'] }] });
    const extra = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-b'] }] });
    mergeFindingManagerOutputs(base, extra);
    expect(base.matches[0]?.rawFindingIds).toEqual(['raw-a']);
  });
});

describe('classifyRawFindingsMechanically conflicting signals', () => {
  it('Given a confirmation and a re-reported issue for the same finding When classified Then all related raws fall to residual', () => {
    const confirmation = makeRawFinding({
      rawFindingId: 'raw-confirm',
      kind: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    });
    const reReport = makeRawFinding({
      rawFindingId: 'raw-issue',
      kind: 'issue',
      location: 'src/a.ts:10',
      familyTag: 'bug',
    });
    const result = classifyRawFindingsMechanically({
      previousLedger: makeLedger(),
      rawFindings: [confirmation, reReport],
    });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.output.matches).toEqual([]);
    expect(new Set(result.residualRawFindings.map((raw) => raw.rawFindingId)))
      .toEqual(new Set(['raw-confirm', 'raw-issue']));
  });
});
