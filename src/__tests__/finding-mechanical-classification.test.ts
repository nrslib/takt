import { describe, expect, it } from 'vitest';
import {
  classifyRawFindingsMechanically,
  mergeFindingManagerOutputs,
} from '../core/workflow/findings/mechanical-classification.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

function quote(path: string, line: number) {
  return {
    kind: 'file_quote' as const,
    path,
    startLine: line,
    endLine: line,
    verbatimExcerpt: `evidence at ${path}:${line}`,
    snapshotId: '1'.repeat(64),
  };
}

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId: 'raw-current',
    stepName: 'architecture-review',
    reviewer: 'architecture-review',
    familyTag: 'bug',
    severity: 'high',
    title: 'Current issue',
    description: 'The issue is present in the current review.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/a.ts'] },
    evidence: [quote('src/a.ts', 10)],
    ...overrides,
  });
}

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    evidenceIds: [],
    reviewers: ['architecture-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    evidenceRecords: [],
    rawFindings: [makeRawFinding({ rawFindingId: 'raw-existing' })],
    conflicts: [],
    findings: [makeFinding({ revision: 1 })],
    ...overrides,
  });
}

describe('classifyRawFindingsMechanically resolution confirmations (case 3)', () => {
  it('Given a resolution confirmation targeting an open finding When classified Then manager semantic judgment remains required', () => {
    const raw = makeRawFinding({
      rawFindingId: 'raw-confirm',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      description: 'Verified fixed at src/a.ts:10.',
    });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given multiple confirmations for the same finding When classified Then every confirmation remains residual', () => {
    const raws = [
      makeRawFinding({ rawFindingId: 'raw-c1', relation: 'resolution_confirmation', targetFindingId: 'F-0001' }),
      makeRawFinding({ rawFindingId: 'raw-c2', relation: 'resolution_confirmation', targetFindingId: 'F-0001' }),
    ];
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: raws });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual(raws);
  });

  it('Given a confirmation targeting a missing finding When classified Then it goes to residual', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-confirm', relation: 'resolution_confirmation', targetFindingId: 'F-9999' });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given a confirmation targeting an already resolved finding When classified Then it goes to residual', () => {
    const ledger = makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
    });
    const raw = makeRawFinding({ rawFindingId: 'raw-confirm', relation: 'resolution_confirmation', targetFindingId: 'F-0001' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });
});

// item 4 case 2: explicit reference (relation=persists/reopened + targetFindingId).
describe('classifyRawFindingsMechanically explicit reference (case 2)', () => {
  it('Given relation "persists" with targetFindingId pointing at an open finding When classified Then it lands in matches without residual (F-0017-style)', () => {
    // familyTag と行番号は識別に使わない設計の確認: familyTag もタイトルも
    // 台帳の finding と異なるが、明示参照だけで機械 same になる。
    const raw = makeRawFinding({
      rawFindingId: 'raw-persist',
      relation: 'persists',
      targetFindingId: 'F-0001',
      familyTag: 'race-condition',
      evidence: [quote('src/a.ts', 99)],
      title: 'A totally different-sounding title',
      description: 'Still seeing the distributed lock cleanup gap, now at a different line.',
    });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([]);
    expect(result.output.matches).toEqual([{ findingId: 'F-0001', rawFindingIds: ['raw-persist'] }]);
  });

  it('Given relation "persists" with targetFindingId pointing at a non-open finding When classified Then it goes to residual', () => {
    const ledger = makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
    });
    const raw = makeRawFinding({ rawFindingId: 'raw-persist', relation: 'persists', targetFindingId: 'F-0001' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.output.matches).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given relation "persists" with targetFindingId pointing at an unknown finding When classified Then it goes to residual', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-persist', relation: 'persists', targetFindingId: 'F-9999' });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given relation "reopened" with targetFindingId pointing at a resolved finding When classified Then it still goes to residual (reopen always needs manager judgment)', () => {
    // reopen はより重い状態遷移のため、対象状態が「正しく」resolved/waived で
    // あっても機械では確定させない（保守的な原則）。
    const ledger = makeLedger({ findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })] });
    const raw = makeRawFinding({ rawFindingId: 'raw-reopen', relation: 'reopened', targetFindingId: 'F-0001' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([raw]);
  });
});

// item 4 case 1: exact duplicate raw content (normalized title/description/path/suggestion).
describe('classifyRawFindingsMechanically exact duplicate content (case 1)', () => {
  it('Given a relation "new" raw whose title/description/path/suggestion exactly match an open finding\'s existing raw When classified Then it lands in matches', () => {
    const existingRaw = makeRawFinding({
      rawFindingId: 'raw-existing',
      evidence: [quote('src/a.ts', 10)],
      title: 'Handle is never closed',
      description: 'The file handle opened at line 10 is never released.',
      suggestion: 'Add a finally block that calls close().',
    });
    const ledger = makeLedger({ rawFindings: [existingRaw] });
    const raw = makeRawFinding({
      rawFindingId: 'raw-dup',
      relation: 'new',
      familyTag: 'style', // familyTag differs — not part of the identity key.
      evidence: [quote('src/a.ts', 10)],
      title: 'Handle is never closed',
      description: 'The file handle opened at line 10 is never released.',
      suggestion: 'Add a finally block that calls close().',
    });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([]);
    expect(result.output.matches).toEqual([{ findingId: 'F-0001', rawFindingIds: ['raw-dup'] }]);
  });

  // F-0016 の再現: 同じ familyTag・同じ行だが意味の異なる raw は、旧設計
  // （familyTag + exact location の自動 same）では壊れた混成 finding に畳まれて
  // いた。新設計は内容の完全一致でしか機械 same にしないため、意味が違う
  // （description が異なる）raw は residual に落ちて manager へ送られる。
  it('Given two raws with the same familyTag and location but different meaning When classified Then neither auto-merges and both go to residual (F-0016 regression guard)', () => {
    const existingRaw = makeRawFinding({
      rawFindingId: 'raw-existing',
      familyTag: 'resource-leak',
      evidence: [quote('src/a.ts', 10)],
      title: 'Handle is never closed',
      description: 'A specific file descriptor leak on the error path.',
    });
    const ledger = makeLedger({ rawFindings: [existingRaw] });
    const raw = makeRawFinding({
      rawFindingId: 'raw-different-meaning',
      relation: 'new',
      familyTag: 'resource-leak',
      evidence: [quote('src/a.ts', 10)],
      title: 'Handle is never closed',
      description: 'A distinct concern about goroutine cleanup, unrelated to the file descriptor leak.',
    });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.output.matches).toEqual([]);
    expect(result.output.newFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given a raw whose content matches a RESOLVED finding\'s raw (not open) When classified Then it goes to residual as a reopen candidate', () => {
    const existingRaw = makeRawFinding({ rawFindingId: 'raw-existing' });
    const ledger = makeLedger({
      rawFindings: [existingRaw],
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
    });
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', relation: 'new' });
    const result = classifyRawFindingsMechanically({ previousLedger: ledger, rawFindings: [raw] });
    expect(result.output.matches).toEqual([]);
    expect(result.residualRawFindings).toEqual([raw]);
  });

  it('Given an issue without evidence location but the same claim identity When classified Then it still matches', () => {
    const raw = makeRawFinding({ rawFindingId: 'raw-issue', relation: 'new', evidence: [] });
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: [raw] });
    expect(result.residualRawFindings).toEqual([]);
    expect(result.output.matches).toEqual([{
      findingId: 'F-0001',
      rawFindingIds: ['raw-issue'],
    }]);
  });

  it('Given only a resolution confirmation When classified Then no mechanical output is emitted', () => {
    const raws = [
      makeRawFinding({ rawFindingId: 'raw-confirm', relation: 'resolution_confirmation', targetFindingId: 'F-0001', description: 'Verified.' }),
    ];
    const result = classifyRawFindingsMechanically({ previousLedger: makeLedger(), rawFindings: raws });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.residualRawFindings).toEqual(raws);
  });
});

describe('mergeFindingManagerOutputs', () => {
  function makeOutput(overrides: Partial<FindingManagerOutput> = {}): FindingManagerOutput {
    return {
      anchorAdjudications: [],
      matches: [],
      newFindings: [],
      resolvedFindings: [],
      reopenedFindings: [],
      conflicts: [],
      resolvedConflicts: [],
      waivedFindings: [],
      disputeNotes: [],
      invalidatedFindings: [],
      duplicateFindings: [],
      dismissedFindings: [],
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

  it('Given a mechanical persists match and a manager resolution for the same finding When merged Then it stays open with a conflict', () => {
    const base = makeOutput({
      matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-persists'] }],
    });
    const extra = makeOutput({
      resolvedFindings: [{
        findingId: 'F-0001',
        rawFindingIds: ['raw-confirm'],
        evidence: 'Manager judged the confirmation semantically sufficient.',
      }],
    });

    const merged = mergeFindingManagerOutputs(base, extra);

    expect(merged.matches).toEqual(base.matches);
    expect(merged.resolvedFindings).toEqual([]);
    expect(merged.conflicts).toEqual([{
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-confirm'],
      description: 'Resolution confirmation conflicts with evidence that finding "F-0001" still persists in the same round',
    }]);
  });

  it('Given the base output When merged Then the base arrays are not mutated', () => {
    const base = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-a'] }] });
    const extra = makeOutput({ matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-b'] }] });
    mergeFindingManagerOutputs(base, extra);
    expect(base.matches[0]?.rawFindingIds).toEqual(['raw-a']);
  });
});

describe('classifyRawFindingsMechanically conflicting signals', () => {
  it('Given a confirmation and a re-reported issue for the same finding When classified Then the confirmation remains residual and persists stays mechanically open', () => {
    const confirmation = makeRawFinding({
      rawFindingId: 'raw-confirm',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    });
    const reReport = makeRawFinding({
      rawFindingId: 'raw-issue',
      relation: 'persists',
      targetFindingId: 'F-0001',
    });
    const result = classifyRawFindingsMechanically({
      previousLedger: makeLedger(),
      rawFindings: [confirmation, reReport],
    });
    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.output.matches).toEqual([{
      findingId: 'F-0001',
      rawFindingIds: ['raw-issue'],
    }]);
    expect(result.residualRawFindings).toEqual([confirmation]);
  });
});
