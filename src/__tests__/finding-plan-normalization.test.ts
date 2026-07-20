import { describe, expect, it } from 'vitest';
import { assembleManagerOutput } from '../core/workflow/findings/decision-assembly.js';
import {
  normalizeMergedManagerPlan,
  rejectConflictTouchedDuplicates,
  transferSupersededMatches,
} from '../core/workflow/findings/manager-plan-normalization.js';
import { validateFindingManagerOutput } from '../core/workflow/findings/manager-output-validation.js';
import { reconcileCommitPlan } from '../core/workflow/findings/manager-commit-finalization.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { createReviewerRawFindingCandidates } from '../core/workflow/findings/raw-canonicalization.js';
import { detectClarifiableRawMismatches } from '../core/workflow/findings/relation-coherence.js';
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
    nextId: 100,
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

describe('transferSupersededMatches', () => {
  it('superseded 対象への match を canonical へ付け替え、既存の canonical match と統合する', () => {
    const transferred = transferSupersededMatches(outputWith({
      matches: [
        { findingId: 'F-0001', rawFindingIds: ['raw-1'] },
        { findingId: 'F-0006', rawFindingIds: ['raw-6'] },
        { findingId: 'F-0008', rawFindingIds: ['raw-8', 'raw-1'] },
      ],
      duplicateFindings: [
        { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006', 'F-0008'], evidence: '同一問題の言い換え' },
      ],
    }));

    expect(transferred.matches).toEqual([
      { findingId: 'F-0001', rawFindingIds: ['raw-1', 'raw-6', 'raw-8'] },
    ]);
    // 冪等: 再適用しても変化しない
    expect(transferSupersededMatches(transferred)).toEqual(transferred);
  });
});

describe('rejectConflictTouchedDuplicates', () => {
  it('出力内の conflict が duplicate に触れる統合は不採用にする', () => {
    const result = rejectConflictTouchedDuplicates({
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

    expect(result.output.duplicateFindings).toEqual([]);
    // 転写はしない — match は元の finding のまま
    expect(result.output.matches).toEqual([{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }]);
    expect(result.rejectedDuplicateDecisions).toHaveLength(1);
  });

  it('台帳の active conflict が canonical に触れる統合も不採用にする', () => {
    const result = rejectConflictTouchedDuplicates({
      output: outputWith({
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006'], evidence: '言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(['F-0001']),
    });

    expect(result.output.duplicateFindings).toEqual([]);
    expect(result.rejectedDuplicateDecisions).toHaveLength(1);
  });
});

describe('normalizeMergedManagerPlan（保存直前のフル正規化）', () => {
  it('後着 conflict が duplicate に触れたら統合を不採用にし、match は元の finding に残す', () => {
    // codex #3 のケース: assembly 段では conflict なし → 統合受理（未転写）、
    // ladder マージが F-0006 への conflict を後着させる。
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        matches: [{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }],
        conflicts: [{
          findingIds: ['F-0006'],
          rawFindingIds: ['raw-ladder'],
          description: 'Ladder interpretation conflicts with F-0006.',
        }],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006'], evidence: '言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.duplicateFindings).toEqual([]);
    // 転写されていない: F-0006 の観測は F-0006 に残り、F-0001 は汚れない
    expect(result.output.matches).toEqual([{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }]);
    expect(result.rejections.some((rejection) => rejection.includes('duplicateDecisions'))).toBe(true);
  });

  it('conflict が無ければ統合を受理し、match をこの1回で canonical へ転写する', () => {
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        matches: [{ findingId: 'F-0006', rawFindingIds: ['raw-6'] }],
        duplicateFindings: [
          { canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0006'], evidence: '言い換え' },
        ],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.duplicateFindings).toHaveLength(1);
    expect(result.output.matches).toEqual([{ findingId: 'F-0001', rawFindingIds: ['raw-6'] }]);
    expect(result.rejections).toEqual([]);
  });

  it('resolved と後着 conflict の併存は canonicalize 規則で conflict へ畳む', () => {
    // codex #1 のケース: clean confirmation が resolvedFindings、ladder が同じ
    // finding へ conflict — 排他違反のまま reconciler へ渡すと保存が throw する。
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        resolvedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-confirm'], evidence: 'fixed' }],
        conflicts: [{
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-ladder'],
          description: 'Ladder evidence says it persists.',
        }],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.resolvedFindings).toEqual([]);
    expect(result.output.conflicts).toHaveLength(1);
    expect(result.output.conflicts[0]!.rawFindingIds).toEqual(
      expect.arrayContaining(['raw-ladder', 'raw-confirm']),
    );
  });

  it('後着 match が触れた invalidate / dismiss は項目単位で不採用にする', () => {
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        matches: [
          { findingId: 'F-0001', rawFindingIds: ['raw-ladder-1'] },
          { findingId: 'F-0002', rawFindingIds: ['raw-ladder-2'] },
        ],
        invalidatedFindings: [{ findingId: 'F-0001', evidence: 'location unresolvable' }],
        dismissedFindings: [{ findingId: 'F-0002', basis: 'out_of_scope', reason: '管轄外' }],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.invalidatedFindings).toEqual([]);
    expect(result.output.dismissedFindings).toEqual([]);
    expect(result.rejections).toHaveLength(2);
  });

  it('後着証拠が触れた waive は disputeNote へ降格し finding を open に保つ', () => {
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-ladder'] }],
        waivedFindings: [{ findingId: 'F-0001', reason: '修正不能', evidence: 'src/a.ts:10' }],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.waivedFindings).toEqual([]);
    expect(result.output.disputeNotes).toEqual([
      { findingId: 'F-0001', reason: '修正不能', evidence: 'src/a.ts:10' },
    ]);
  });

  it('同一 finding 集合の conflict は統合し、部分重複する後着 conflict は不採用にする', () => {
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        conflicts: [
          { findingIds: ['F-0001'], rawFindingIds: ['raw-a'], description: 'Disagreement A.' },
          { findingIds: ['F-0001'], rawFindingIds: ['raw-b'], description: 'Disagreement A again.' },
          { findingIds: ['F-0001', 'F-0002'], rawFindingIds: [], description: 'Partial overlap.' },
        ],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.conflicts).toHaveLength(1);
    expect(result.output.conflicts[0]!.rawFindingIds.sort()).toEqual(['raw-a', 'raw-b']);
    expect(result.rejections.some((rejection) => rejection.includes('already referenced by another conflict'))).toBe(true);
  });

  it('reopened と同じ finding への後着 match は reopened の観測へ畳む', () => {
    const result = normalizeMergedManagerPlan({
      output: outputWith({
        matches: [{ findingId: 'F-0001', rawFindingIds: ['raw-ladder'] }],
        reopenedFindings: [{ findingId: 'F-0001', rawFindingIds: ['raw-reopen'], evidence: 'waive 前提が崩れた' }],
      }),
      activeConflictFindingIds: new Set(),
    });

    expect(result.output.matches).toEqual([]);
    expect(result.output.reopenedFindings).toEqual([
      { findingId: 'F-0001', rawFindingIds: ['raw-reopen', 'raw-ladder'], evidence: 'waive 前提が崩れた' },
    ]);
  });
});

describe('reconcileCommitPlan の resolvedConflicts 再生成不採用', () => {
  it('後着証拠が同じ conflict を再生成する場合、その resolve を不採用にして active を保つ', () => {
    const conflict = makeConflict({ id: 'C-0001', findingIds: ['F-0001'], rawFindingIds: ['raw-old'] });
    const freshLedger = makeLedger(
      [makeFinding({ id: 'F-0001' })],
      { conflicts: [conflict] },
    );
    const ladderRaw = makeRaw({ rawFindingId: 'raw-ladder' });

    const result = reconcileCommitPlan({
      runInput: {
        workflowName: 'peer-review',
        callNamespace: '',
        runId: 'run-2',
        timestamp: '2026-07-02T00:00:00.000Z',
        cwd: process.cwd(),
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false },
      } as never,
      freshLedger,
      rawFindings: [ladderRaw],
      managerOutput: outputWith({
        // manager は C-0001 を resolve したが、ladder マージが同じ署名の
        // conflict（F-0001）を後着させた
        resolvedConflicts: [{ conflictId: 'C-0001', evidence: 'adjudicated' }],
        conflicts: [{
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-ladder'],
          description: 'Ladder evidence disagrees again.',
        }],
      }),
      provisionalSpecs: [],
      anomalySpecs: [],
      pendingRejectedObservations: [],
      rawProvenanceByRawFindingId: new Map(),
      cleanWire: [],
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      recoveryProvisionalRawFindingIds: new Set(),
      deferredRawFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
    });

    expect(result.normalizationRejections.some((rejection) => (
      rejection.includes('C-0001') && rejection.includes('regenerated')
    ))).toBe(true);
    const savedConflict = result.ledger.conflicts.find((entry) => entry.id === 'C-0001')!;
    expect(savedConflict.status).toBe('active');
  });
});

describe('assembleManagerOutput → 保存正規化 → reconciler（ラウンド2事故の再現形）', () => {
  const ledger = makeLedger([
    makeFinding({ id: 'F-0001', rawFindingIds: ['raw-old-1'] }),
    makeFinding({ id: 'F-0006', rawFindingIds: ['raw-old-6'], title: '候補に存在しない初期値が非表示のまま確定結果へ混入する' }),
    makeFinding({ id: 'F-0008', rawFindingIds: ['raw-old-8'], title: '候補にない初期選択が非表示のまま確定・実行される' }),
  ]);
  const persistsRaws = [
    makeRaw({ rawFindingId: 'raw-6', relation: 'persists', targetFindingId: 'F-0006' }),
    makeRaw({ rawFindingId: 'raw-8', relation: 'persists', targetFindingId: 'F-0008' }),
  ];

  it('same + duplicateDecisions の併記が全経路を通って superseded と観測統合に着地する', () => {
    const assembly = assembleManagerOutput({
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

    expect(assembly.rejectedDuplicateDecisions).toEqual([]);
    // assembly 段では未転写（保存直前の1回だけ転写する）
    expect(assembly.output.matches.map((match) => match.findingId).sort()).toEqual(['F-0006', 'F-0008']);
    // 決定段の最終検証は転写ビューで通る
    expect(validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: transferSupersededMatches(assembly.output),
    }).ok).toBe(true);

    const normalized = normalizeMergedManagerPlan({
      output: assembly.output,
      activeConflictFindingIds: new Set(),
    });
    expect(normalized.output.matches.map((match) => match.findingId)).toEqual(['F-0001']);

    const reconciled = reconcileFindingLedger({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: normalized.output,
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
    expect(validateFindingManagerOutput({
      previousLedger: ledger,
      rawFindings: persistsRaws,
      managerOutput: transferSupersededMatches(result.output),
    }).ok).toBe(true);
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

  it('内部採番は明示 ID を避け、一意な明示 ID は元の文字列のまま保持する', () => {
    // 明示 ID の改名は clarification の priorAmbiguityCodesByRawId 相関を壊し、
    // 訂正済み raw の taint（ambiguityOrigin）が外れて clean 権限を得てしまう。
    // ずれるのは常に内部採番の側でなければならない。
    const candidates = createReviewerRawFindingCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'item-1', title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates[0]!.reviewerRawFindingId).toBeUndefined();
    expect(candidates[1]!.reviewerRawFindingId).toBe('item-1');
    expect(candidates[0]!.intakeId).toContain('item-1-dup2');
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
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

describe('detectClarifiableRawMismatches の重複 ID 除外', () => {
  it('同一 ID が複数回現れる場合は clarification 対象から外す（素の ID で相関できない）', () => {
    const ledger = makeLedger([makeFinding({ id: 'F-0001', status: 'resolved', lifecycle: 'resolved' })]);
    // resolved な finding への persists 主張は clarifiable なミスマッチになる形
    const item = {
      rawFindingId: 'x',
      relation: 'persists',
      targetFindingId: 'F-0001',
      title: 'まだ残っている',
      severity: 'medium',
      description: 'まだ残っている',
    };

    const unique = detectClarifiableRawMismatches([item], ledger);
    const duplicated = detectClarifiableRawMismatches([item, { ...item, description: '別内容' }], ledger);

    expect(unique.length).toBeGreaterThan(0);
    expect(duplicated).toEqual([]);
  });
});
