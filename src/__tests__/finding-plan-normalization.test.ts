import { describe, expect, it } from 'vitest';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import { normalizeManagerPlan } from '../core/workflow/findings/manager-plan-normalization.js';
import { validateFindingManagerOutput } from '../core/workflow/findings/manager-output-validation.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { createReviewerRawFindingCandidates } from '../core/workflow/findings/raw-canonicalization.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingManagerDecisions,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '候補にない初期値が確定結果へ混入する',
    location: 'src/multi-select.ts:34',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-old-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[], overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
    ...overrides,
  };
}

function makeConflict(overrides: Partial<FindingLedgerConflict> = {}): FindingLedgerConflict {
  return {
    id: 'C-0001',
    status: 'active',
    findingIds: ['F-0001'],
    rawFindingIds: [],
    description: 'Reviewers disagree.',
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    rawFindingId: 'raw-1',
    stepName: 'arch-review',
    reviewer: 'arch-review',
    familyTag: 'bug',
    severity: 'medium',
    title: '候補にない初期値が確定結果へ混入する',
    location: 'src/multi-select.ts:34',
    description: '初期値が候補と照合されないまま確定される。',
    ...overrides,
  };
}

function makeDecisions(overrides: Partial<FindingManagerDecisions> = {}): FindingManagerDecisions {
  return {
    rawDecisions: [],
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
    ...overrides,
  };
}

function outputWith(overrides: Partial<FindingManagerOutput>): FindingManagerOutput {
  return { ...createEmptyManagerOutput(), ...overrides };
}

describe('normalizeManagerPlan', () => {
  it('superseded 対象への match を canonical へ付け替え、既存の canonical match と統合する', () => {
    const normalized = normalizeManagerPlan({
      output: outputWith({
        matches: [
          { findingId: 'F-0001', rawFindingIds: ['raw-1'] },
          { findingId: 'F-0006', rawFindingIds: ['raw-6'] },
          { findingId: 'F-0008', rawFindingIds: ['raw-8', 'raw-1'] },
        ],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006', 'F-0008'], evidence: '同一問題の言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(normalized.rejectedDuplicateDecisions).toEqual([]);
    expect(normalized.output.matches).toEqual([
      { findingId: 'F-0001', rawFindingIds: ['raw-1', 'raw-6', 'raw-8'] },
    ]);
    expect(normalized.output.duplicateFindings).toHaveLength(1);

    // 冪等: 付け替え後の出力に再適用しても変化しない
    const again = normalizeManagerPlan({
      output: normalized.output,
      activeConflictFindingIds: new Set(),
    });
    expect(again.output).toEqual(normalized.output);
    expect(again.rejectedDuplicateDecisions).toEqual([]);
  });

  it('出力内の conflict が duplicate に触れる統合は不採用にし、match は付け替えない', () => {
    const normalized = normalizeManagerPlan({
      output: outputWith({
        matches: [{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }],
        conflicts: [{
          findingIds: ['F-0006'],
          rawFindingIds: ['raw-6'],
          description: 'Reviewers disagree about F-0006.',
        }],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006'], evidence: '言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(normalized.output.duplicateFindings).toEqual([]);
    expect(normalized.output.matches).toEqual([{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }]);
    expect(normalized.rejectedDuplicateDecisions).toHaveLength(1);
    expect(normalized.rejectedDuplicateDecisions[0]).toMatchObject({
      canonicalFindingId: 'F-0001',
      duplicateFindingIds: ['F-0006'],
    });
  });

  it('台帳の active conflict が canonical に触れる統合も不採用にする', () => {
    const normalized = normalizeManagerPlan({
      output: outputWith({
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006'], evidence: '言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(['F-0001']),
    });

    expect(normalized.output.duplicateFindings).toEqual([]);
    expect(normalized.rejectedDuplicateDecisions).toHaveLength(1);
  });
});

describe('assembleManagerOutput の統合正規化（ラウンド2事故の再現形）', () => {
  const ledger = makeLedger([
    makeFinding({ id: 'F-0001', rawFindingIds: ['raw-old-1'] }),
    makeFinding({ id: 'F-0006', rawFindingIds: ['raw-old-6'], title: '候補に存在しない初期値が非表示のまま確定結果へ混入する' }),
    makeFinding({ id: 'F-0008', rawFindingIds: ['raw-old-8'], title: '候補にない初期選択が非表示のまま確定・実行される' }),
  ], { nextId: 9 });
  const persistsRaws = [
    makeRaw({ rawFindingId: 'raw-6', relation: 'persists', targetFindingId: 'F-0006' }),
    makeRaw({ rawFindingId: 'raw-8', relation: 'persists', targetFindingId: 'F-0008' }),
  ];

  it('same + duplicateDecisions の併記を受理し、最終検証を通る出力に正規化する', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: persistsRaws,
      decisions: makeDecisions({
        rawDecisions: [
          { rawFindingId: 'raw-6', decision: 'same', findingId: 'F-0006', evidence: '同一問題' },
          { rawFindingId: 'raw-8', decision: 'same', findingId: 'F-0008', evidence: '同一問題' },
        ],
        duplicateDecisions: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006', 'F-0008'], evidence: '同一問題の言い換え' },
        ],
      }),
      checkMissingDecisions: true,
    });

    expect(result.rejectedDuplicateDecisions).toEqual([]);
    expect(result.output.duplicateFindings).toHaveLength(1);
    expect(result.output.matches.map((match) => match.findingId)).toEqual(['F-0001']);
    expect(result.output.matches[0]!.rawFindingIds.sort()).toEqual(['raw-6', 'raw-8']);

    const validation = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: result.output,
    });
    expect(validation.ok).toBe(true);

    const reconciled = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: result.output,
      context: { workflowName: 'peer-review', stepName: 'reviewers', runId: 'run-2', timestamp: '2026-07-02T00:00:00.000Z' },
    });
    const statusById = new Map(reconciled.findings.map((finding) => [finding.id, finding.status]));
    expect(statusById.get('F-0001')).toBe('open');
    expect(statusById.get('F-0006')).toBe('superseded');
    expect(statusById.get('F-0008')).toBe('superseded');
    const canonical = reconciled.findings.find((finding) => finding.id === 'F-0001')!;
    expect(canonical.rawFindingIds).toEqual(
      expect.arrayContaining(['raw-old-1', 'raw-old-6', 'raw-old-8', 'raw-6', 'raw-8']),
    );
  });

  it('conflict 判断が duplicate に触れる場合は統合だけを不採用にし、出力全体は有効に保つ', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: persistsRaws,
      decisions: makeDecisions({
        rawDecisions: [
          { rawFindingId: 'raw-6', decision: 'conflict', findingId: 'F-0006', evidence: '解消済みとの主張と矛盾' },
          { rawFindingId: 'raw-8', decision: 'same', findingId: 'F-0008', evidence: '同一問題' },
        ],
        duplicateDecisions: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006', 'F-0008'], evidence: '同一問題の言い換え' },
        ],
      }),
      checkMissingDecisions: true,
    });

    expect(result.output.duplicateFindings).toEqual([]);
    expect(result.rejectedDuplicateDecisions).toHaveLength(1);
    const validation = validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: result.output,
    });
    expect(validation.ok).toBe(true);
  });
});

describe('invalidate と同ラウンド証拠の衝突', () => {
  it('このラウンドに match された finding への invalidate は不採用にする', () => {
    const ledger = makeLedger([makeFinding({ id: 'F-0001' })]);
    const raw = makeRaw({ rawFindingId: 'raw-1', relation: 'persists', targetFindingId: 'F-0001' });
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: makeDecisions({
        rawDecisions: [{ rawFindingId: 'raw-1', decision: 'same', findingId: 'F-0001', evidence: '再観測' }],
        invalidateDecisions: [{ findingId: 'F-0001', evidence: 'location が現行コードに無い' }],
      }),
      checkMissingDecisions: true,
      invalidLocationCandidateFindingIds: new Set(['F-0001']),
    });

    expect(result.output.invalidatedFindings).toEqual([]);
    expect(result.rejectedInvalidateDecisions).toHaveLength(1);
    expect(validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [raw],
      managerOutput: result.output,
    }).ok).toBe(true);
  });

  it('active conflict が参照する finding への invalidate は不採用にする', () => {
    const ledger = makeLedger(
      [makeFinding({ id: 'F-0001' })],
      { conflicts: [makeConflict({ findingIds: ['F-0001'] })] },
    );
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [],
      decisions: makeDecisions({
        invalidateDecisions: [{ findingId: 'F-0001', evidence: 'location が現行コードに無い' }],
      }),
      checkMissingDecisions: true,
      invalidLocationCandidateFindingIds: new Set(['F-0001']),
    });

    expect(result.output.invalidatedFindings).toEqual([]);
    expect(result.rejectedInvalidateDecisions).toHaveLength(1);
  });
});

describe('carried conflict の部分重複', () => {
  const ledger = makeLedger([
    makeFinding({ id: 'F-0001' }),
    makeFinding({ id: 'F-0002' }),
  ]);
  const raw = makeRaw({ rawFindingId: 'raw-1', relation: 'persists', targetFindingId: 'F-0001' });

  it('出力済み conflict と finding を共有するだけの carried は項目単位で不採用にする', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: makeDecisions({
        rawDecisions: [{ rawFindingId: 'raw-1', decision: 'conflict', findingId: 'F-0001', evidence: '矛盾' }],
      }),
      checkMissingDecisions: true,
      carriedFindingOnlyConflicts: [{
        findingIds: ['F-0001', 'F-0002'],
        rawFindingIds: [],
        description: '別の切り口の対立（F-0001 を共有）',
      }],
    });

    expect(result.rejectedCarriedConflicts).toHaveLength(1);
    expect(validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: [raw],
      managerOutput: result.output,
    }).ok).toBe(true);
  });
});

describe('createReviewerRawFindingCandidates の rawFindingId 一意性', () => {
  const context = {
    workflowName: 'peer-review',
    callNamespace: '',
    parentStepName: 'reviewers',
    reviewerPersonaKey: 'arch-review',
    reviewerStepName: 'arch-review',
  } as never;

  it('同一 reviewer 内の重複 ID を決定的にサフィックスして一意化する', () => {
    const candidates = createReviewerRawFindingCandidates([
      { rawFindingId: 'x', title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'x', title: 'b', severity: 'low', description: 'b' },
      { rawFindingId: 'x-dup2', title: 'c', severity: 'low', description: 'c' },
    ], context);

    const reviewerIds = candidates.map((candidate) => candidate.reviewerRawFindingId);
    expect(new Set(reviewerIds).size).toBe(3);
    expect(reviewerIds[0]).toBe('x');
    const intakeIds = candidates.map((candidate) => candidate.intakeId);
    expect(new Set(intakeIds).size).toBe(3);
  });

  it('ID 未指定の項目は従来どおり reviewerRawFindingId を持たない', () => {
    const candidates = createReviewerRawFindingCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates.every((candidate) => candidate.reviewerRawFindingId === undefined)).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });
});
