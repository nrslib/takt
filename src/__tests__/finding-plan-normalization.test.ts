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
import {
  canonicalizeReviewerRawFinding,
  computeLineageKey,
  computeReviewerStableKey,
  createReviewerRawFindingCandidates,
  projectReviewerRawStructuredOutputWithEnvelope,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { foldRawFindingEvidence } from '../core/workflow/findings/finding-evidence-fold.js';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { detectClarifiableRawMismatches } from '../core/workflow/findings/relation-coherence.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingManagerDecisions,
  FindingManagerOutput,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { storedRawReconcileProvenance } from './helpers/finding-integrity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { intakeReviewerOutputs } from '../core/workflow/findings/manager-intake.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import { evaluateRawAdmission } from '../core/workflow/findings/manager-admission.js';
import { applyCommitLedgerStates } from '../core/workflow/findings/manager-commit-finalization.js';
import { applyRejectedObservationAttachments } from '../core/workflow/findings/manager-provisional-settlement.js';
import { resolveStopBudgetLimits } from '../core/workflow/findings/stop-budget.js';
import { resolveReviewIntegrityLimits } from '../core/workflow/findings/review-integrity.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  const { location: _location, ...currentOverrides } = overrides as typeof overrides & {
    location?: string;
  };
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '候補にない初期値が確定結果へ混入する',
    evidenceIds: [],
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-old-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...currentOverrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[], overrides: Partial<FindingLedger> = {}): FindingLedger {
  return authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 100,
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    findings,
    ...overrides,
  });
}

function makeConflict(overrides: Partial<FindingLedgerConflict> = {}): FindingLedgerConflict {
  return {
    id: 'C-FA2947446963',
    status: 'active',
    revision: 1,
    findingIds: ['F-0001'],
    rawFindingIds: [],
    description: 'Reviewers disagree.',
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
  const { location = 'src/multi-select.ts:34', ...currentOverrides } = overrides as Partial<RawFinding> & {
    location?: string;
  };
  const match = /^(.*):(\d+)$/u.exec(location);
  const path = match?.[1] ?? location;
  const line = Number(match?.[2] ?? 1);
  return canonicalRawFindingFixture({
    rawFindingId: 'raw-1',
    stepName: 'arch-review',
    reviewer: 'arch-review',
    familyTag: 'bug',
    severity: 'medium',
    title: '候補にない初期値が確定結果へ混入する',
    description: '初期値が候補と照合されないまま確定される。',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: [path] },
    evidence: [{
      kind: 'file_quote',
      path,
      startLine: line,
      endLine: line,
      verbatimExcerpt: `evidence at ${location}`,
      snapshotId: '1'.repeat(64),
    }],
    ...currentOverrides,
  });
}

function reviewerExtraction(
  raw: Record<string, unknown>,
  index: number,
): ReturnType<typeof reviewerRawExtractionFixture> {
  const finding = raw as Partial<RawFinding>;
  return reviewerRawExtractionFixture({
    rawFindingId: typeof finding.rawFindingId === 'string' ? finding.rawFindingId : null,
    familyTag: typeof finding.familyTag === 'string' ? finding.familyTag : null,
    severity: finding.severity ?? null,
    title: typeof finding.title === 'string' ? finding.title : null,
    description: typeof finding.description === 'string' ? finding.description : null,
    suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : null,
    relation: finding.relation ?? 'new',
    targetFindingId: typeof finding.targetFindingId === 'string'
      ? finding.targetFindingId
      : null,
    target: finding.target,
    evidence: finding.evidence,
    rawExcerpt: `[item ${index}] ${finding.description ?? finding.title ?? 'observation'}`,
  });
}

function reviewerCandidates(
  items: readonly unknown[],
  context: Record<string, unknown>,
) {
  const extractions = items.map((item, index) => (
    reviewerExtraction(item as Record<string, unknown>, index)
  ));
  return createReviewerRawFindingCandidates(extractions, {
    ...context,
    ledger: makeLedger([]),
    reviewReport: extractions.map((item) => item.rawExcerpt).join('\n'),
    issueEvidenceRequests: ({ requests }: {
      requests: Array<Record<string, unknown>>;
    }) => ({
      evidence: requests.flatMap((request) => (
        request.kind === 'file_quote'
          ? [{ ...request, snapshotId: '1'.repeat(64) }]
          : []
      )),
      engineProofRecords: [],
      coverageGaps: [],
    }),
  } as never).candidates;
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

describe('normalizer source binding review integrity', () => {
  function intakeWithReport(
    report: string,
    stepIteration: number,
    previousLedger = makeLedger([]),
  ) {
    const extraction = reviewerRawExtractionFixture({
      rawFindingId: 'F-0016',
      familyTag: 'correctness',
      severity: 'high',
      title: 'F-0016 remains unresolved',
      description: 'The same target still has the F-0016 defect.',
      suggestion: 'Repair the target.',
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/f-0016.ts'] },
      rawExcerpt: 'F-0016 remains unresolved.',
    });
    return intakeReviewerOutputs({
      subResults: [{
        subStep: {
          kind: 'agent',
          name: 'arch-review',
          persona: 'arch-review',
          edit: false,
        },
        publication: findingReviewPublicationFixture({
          scopeIdentity: '/test/normalizer-source-binding/ledger.json',
          parentStepName: 'reviewers',
          stepIteration,
          reviewerStepName: 'arch-review',
          reportContent: report,
          rawFindings: [extraction],
        }),
      }],
      previousLedger,
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration,
      runId: 'run-normalizer',
      workflowTask: 'Review.',
      cwd: process.cwd(),
      scopeIdentity: '/test/normalizer-source-binding/ledger.json',
      issuedAt: '2026-07-30T00:00:00.000Z',
      reviewScopeSnapshot: {
        reviewScopeSnapshotId: 'a'.repeat(64),
        trackedDiff: undefined,
        untrackedEvidence: [],
        queryInventory: [],
      },
    });
  }

  it.each([
    ['zero', 'No matching excerpt is present.'],
    ['multiple', 'F-0016 remains unresolved.\nF-0016 remains unresolved.'],
  ])(
    'rejects a %s-match rawExcerpt before canonical publication',
    (_caseName, report) => {
      expect(() => intakeWithReport(report, 1))
        .toThrow(/rawExcerpt must occur exactly once/);
    },
  );

});

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
        dismissedFindings: [{
          findingId: 'F-0002',
          basis: 'out_of_scope',
          reason: '管轄外',
          evidence: '品質ゲートの実行記録だけを対象にしている',
          authority: 'standard',
        }],
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
    const conflictId = formatConflictId({ findingIds: ['F-0001'], rawFindingIds: ['raw-old'] });
    const conflict = makeConflict({ id: conflictId, findingIds: ['F-0001'], rawFindingIds: ['raw-old'] });
    const freshLedger = makeLedger(
      [makeFinding({ revision: 1, id: 'F-0001' })],
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
        anchorAdjudications: [createAnchorAdjudication({
          rawFindingId: 'raw-ladder',
          decision: 'conflict',
          findingId: 'F-0001',
          anchorRelevance: 'not_applicable',
          evidence: 'Ladder evidence disagrees again.',
        })],
        // manager は canonical conflict を resolve したが、ladder マージが同じ署名の
        // conflict（F-0001）を後着させた
        resolvedConflicts: [{ conflictId, evidence: 'adjudicated' }],
        conflicts: [{
          findingIds: ['F-0001'],
          rawFindingIds: ['raw-ladder'],
          description: 'Ladder evidence disagrees again.',
        }],
      }),
      provisionalSpecs: [],
      entityProvisionalMutations: [],
      anomalySpecs: [],
      pendingRejectedObservations: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      rawProvenanceByRawFindingId: new Map([[ladderRaw.rawFindingId,
        storedRawReconcileProvenance(
          ladderRaw,
          computeReviewerStableKey({
          workflowName: 'peer-review',
          callNamespace: '',
          parentStepName: 'reviewers',
          reviewerPersonaKey: ladderRaw.reviewer,
          }),
          computeLineageKey({
          claimIdentityHash: computeClaimIdentityHash(ladderRaw),
          }),
        ),
      ]]),
      cleanWire: [],
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      recoveryProvisionalRawFindingIds: new Set(),
      staleRawFindingIds: new Set(),
      deferredRawFindingIds: new Set(),
      resolutionRenotifications: [],
      unsupportedRawFindingReports: [],
      healthyReviewerStableKeys: new Set(),
    });

    expect(result.normalizationRejections.some((rejection) => (
      rejection.includes('C-FA2947446963') && rejection.includes('regenerated')
    ))).toBe(true);
    const savedConflict = result.ledger.conflicts.find((entry) => entry.id === 'C-FA2947446963')!;
    expect(savedConflict.status).toBe('active');
  });
});

describe('assembleManagerOutput → 保存正規化 → reconciler（ラウンド2事故の再現形）', () => {
  const ledger = makeLedger([
    makeFinding({ revision: 1, id: 'F-0001', rawFindingIds: ['raw-old-1'] }),
    makeFinding({ revision: 1, id: 'F-0006', rawFindingIds: ['raw-old-6'], title: '候補に存在しない初期値が非表示のまま確定結果へ混入する' }),
    makeFinding({ revision: 1, id: 'F-0008', rawFindingIds: ['raw-old-8'], title: '候補にない初期選択が非表示のまま確定・実行される' }),
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
          { rawFindingId: 'raw-6', decision: 'same', findingId: 'F-0006', anchorRelevance: 'not_applicable', evidence: '同一問題' },
          { rawFindingId: 'raw-8', decision: 'same', findingId: 'F-0008', anchorRelevance: 'not_applicable', evidence: '同一問題' },
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
      entityProvisionalMutations: [],
      terminalEntityAttachmentFindingIds: new Set(),
      provisionalFindings: [],
      rawFindingDispositions: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      rawProvenanceByRawFindingId: new Map(persistsRaws.map((rawFinding) => [
        rawFinding.rawFindingId,
        storedRawReconcileProvenance(
          rawFinding,
          computeReviewerStableKey({
            workflowName: 'peer-review',
            callNamespace: '',
            parentStepName: 'reviewers',
            reviewerPersonaKey: rawFinding.reviewer,
          }),
          computeLineageKey({
            targetFindingId: rawFinding.targetFindingId,
            claimIdentityHash: computeClaimIdentityHash(rawFinding),
          }),
        ),
      ])),
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
          { rawFindingId: 'raw-6', decision: 'conflict', findingId: 'F-0006', anchorRelevance: 'not_applicable', evidence: '解消済みとの主張と矛盾' },
          { rawFindingId: 'raw-8', decision: 'same', findingId: 'F-0008', anchorRelevance: 'not_applicable', evidence: '同一問題' },
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
    const ledger = makeLedger([makeFinding({ revision: 1, id: 'F-0001' })]);
    const raw = makeRaw({ rawFindingId: 'raw-1', relation: 'persists', targetFindingId: 'F-0001' });
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: makeDecisions({
        rawDecisions: [{ rawFindingId: 'raw-1', decision: 'same', findingId: 'F-0001', anchorRelevance: 'not_applicable', evidence: '再観測' }],
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
      [makeFinding({ revision: 1, id: 'F-0001' })],
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
    makeFinding({ revision: 1, id: 'F-0001' }),
    makeFinding({ revision: 1, id: 'F-0002' }),
  ]);
  const raw = makeRaw({ rawFindingId: 'raw-1', relation: 'persists', targetFindingId: 'F-0001' });

  it('出力済み conflict と finding を共有するだけの carried は項目単位で不採用にする', () => {
    const result = assembleManagerOutput({
      previousLedger: ledger,
      residualRawFindings: [raw],
      decisions: makeDecisions({
        rawDecisions: [{ rawFindingId: 'raw-1', decision: 'conflict', findingId: 'F-0001', anchorRelevance: 'not_applicable', evidence: '矛盾' }],
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
    const candidates = reviewerCandidates([
      { rawFindingId: 'x', title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'x', title: 'b', severity: 'low', description: 'b' },
      { rawFindingId: 'x-dup2', title: 'c', severity: 'low', description: 'c' },
    ], context);

    const reviewerIds = candidates.map((candidate) => candidate.reviewerRawFindingId);
    expect(new Set(reviewerIds).size).toBe(3);
    expect(reviewerIds).toContain('x');
    expect(candidates.find((candidate) => candidate.title === 'c')?.reviewerRawFindingId)
      .toBe('x-dup2');
    const intakeIds = candidates.map((candidate) => candidate.intakeId);
    expect(new Set(intakeIds).size).toBe(3);
  });

  it('内容の異なる重複明示 ID は入力順を反転しても同じ canonical projection を作る', () => {
    const rawA = {
      rawFindingId: 'x',
      title: 'A',
      severity: 'low',
      description: 'A evidence',
      relation: 'new',
    };
    const rawB = {
      rawFindingId: 'x',
      title: 'B',
      severity: 'low',
      description: 'B evidence',
      relation: 'new',
    };
    const project = (items: readonly unknown[]) => {
      const candidates = reviewerCandidates(items, context);
      const rawFindings = candidates
        .map((candidate) => canonicalizeReviewerRawFinding(candidate, {
          ledger: makeLedger([]),
        }).canonical)
        .map(toLedgerRawFinding);
      return {
        titlesInInputOrder: candidates.map((candidate) => candidate.title),
        idsByTitle: Object.fromEntries(
          candidates.map((candidate) => [
            candidate.title,
            candidate.reviewerRawFindingId,
          ]),
        ),
        evidence: foldRawFindingEvidence(rawFindings),
      };
    };

    const forward = project([rawA, rawB]);
    const reversed = project([rawB, rawA]);
    expect(forward.titlesInInputOrder).toEqual(['A', 'B']);
    expect(reversed.titlesInInputOrder).toEqual(['B', 'A']);
    expect(forward.idsByTitle).toEqual(reversed.idsByTitle);
    expect(forward.evidence).toEqual(reversed.evidence);
  });

  it('内容が完全に同じ重複明示 ID も出力順を保ったまま一意化する', () => {
    const item = {
      rawFindingId: 'x',
      title: 'same',
      severity: 'low',
      description: 'same',
    };
    const candidates = reviewerCandidates([
      { ...item },
      { ...item },
    ], context);

    expect(candidates.map((candidate) => candidate.title)).toEqual(['same', 'same']);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('内容安定の内部 ID と一意な明示 ID をそれぞれ保持する', () => {
    // 明示 ID の改名は clarification の priorAmbiguityCodesByRawId 相関を壊し、
    // 訂正済み raw の taint（ambiguityOrigin）が外れて clean 権限を得てしまう。
    // ずれるのは常に内部採番の側でなければならない。
    const candidates = reviewerCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { rawFindingId: 'item-1', title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates[0]!.reviewerRawFindingId).toBeUndefined();
    expect(candidates[1]!.reviewerRawFindingId).toBe('item-1');
    expect(candidates[0]!.intakeId).toMatch(/:item-[0-9a-f]{64}$/);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('ID 未指定の項目は従来どおり reviewerRawFindingId を持たない', () => {
    const candidates = reviewerCandidates([
      { title: 'a', severity: 'low', description: 'a' },
      { title: 'b', severity: 'low', description: 'b' },
    ], context);

    expect(candidates.every((candidate) => candidate.reviewerRawFindingId === undefined)).toBe(true);
    expect(new Set(candidates.map((candidate) => candidate.intakeId)).size).toBe(2);
  });

  it('未信頼 provider item の実行コードを呼ばず、unsafe な reviewer 出力全体を単一 overflow に置換する', () => {
    let getterReads = 0;
    let toJsonCalls = 0;
    let proxyReads = 0;
    const getterItem = Object.defineProperty({
      rawFindingId: 'getter',
    }, 'title', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'getter title';
      },
    });
    const toJsonItem = {
      rawFindingId: 'to-json',
      toJSON() {
        toJsonCalls += 1;
        return { rawFindingId: 'forged' };
      },
    };
    const proxyItem = new Proxy({ rawFindingId: 'proxy' }, {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const symbolItem = { rawFindingId: 'symbol' };
    Object.defineProperty(symbolItem, Symbol('hidden'), {
      enumerable: true,
      value: 'hidden',
    });
    const nonEnumerableItem = { rawFindingId: 'non-enumerable' };
    Object.defineProperty(nonEnumerableItem, 'hidden', {
      enumerable: false,
      value: 'hidden',
    });
    const extraItem = { rawFindingId: 'extra', unexpected: 'value' };
    const cyclicItem: Record<string, unknown> = { rawFindingId: 'cycle' };
    cyclicItem.description = cyclicItem;
    const sharedValue = { nested: 'shared' };
    const sharedReferenceItem = {
      rawFindingId: 'shared-reference',
      title: sharedValue,
      description: sharedValue,
    };
    const validItem = reviewerExtraction({
      rawFindingId: 'valid',
      relation: 'new',
      familyTag: 'bug',
      severity: 'low',
      title: 'valid title',
      description: 'valid description',
      evidence: [{
        kind: 'file_quote',
        path: 'src/valid.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'valid evidence',
        snapshotId: '1'.repeat(64),
      }],
    }, 99);

    const projected = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: [
        getterItem,
        toJsonItem,
        proxyItem,
        symbolItem,
        nonEnumerableItem,
        extraItem,
        cyclicItem,
        sharedReferenceItem,
        validItem,
      ],
    });

    expect(getterReads).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(proxyReads).toBe(0);
    expect(() => findingReviewPublicationFixture({
      scopeIdentity: '/test/provider-items/ledger.json',
      parentStepName: 'reviewers',
      stepIteration: 1,
      reviewerStepName: 'arch-review',
      reportContent: String(validItem.rawExcerpt),
      rawFindings: projected.structuredOutput.rawFindings as unknown[],
    })).toThrow(/requires rawExcerpt/);
  });
});

describe('detectClarifiableRawMismatches の重複 ID 除外', () => {
  it('同一 ID が複数回現れる場合は clarification 対象から外す（素の ID で相関できない）', () => {
    const ledger = makeLedger([makeFinding({ revision: 1, id: 'F-0001', status: 'resolved', lifecycle: 'resolved' })]);
    // resolved な finding への persists 主張は clarifiable なミスマッチになる形
    const item = {
      rawFindingId: 'x',
      relation: 'persists',
      targetFindingId: 'F-0001',
      title: 'まだ残っている',
      severity: 'medium',
      description: 'まだ残っている',
    };

    const unique = detectClarifiableRawMismatches([
      reviewerExtraction(item, 0),
    ], ledger);
    const duplicated = detectClarifiableRawMismatches([
      reviewerExtraction(item, 0),
      reviewerExtraction({ ...item, description: '別内容' }, 1),
    ], ledger);

    expect(unique.length).toBeGreaterThan(0);
    expect(duplicated).toEqual([]);
  });
});

describe('relation 別 intake と target atomization', () => {
  function lifecycleLedger(): FindingLedger {
    const source = makeRaw({
      rawFindingId: 'source',
      target: { kind: 'code', paths: ['src/lifecycle.ts'] },
    });
    return makeLedger([
      makeFinding({
        revision: 1,
        id: 'F-0001',
        target: source.target,
        targetIdentityHash: source.targetIdentityHash,
        claimIdentityHash: source.claimIdentityHash,
        semanticClaimIdentityHash: source.semanticClaimIdentityHash,
        description: source.description ?? undefined,
      }),
      makeFinding({
        revision: 1,
        id: 'F-0006',
        target: source.target,
        targetIdentityHash: source.targetIdentityHash,
        claimIdentityHash: source.claimIdentityHash,
        semanticClaimIdentityHash: source.semanticClaimIdentityHash,
        description: source.description ?? undefined,
      }),
    ]);
  }

  function candidateContext(report: string) {
    return {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-lifecycle',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch-review',
      reviewReport: report,
      ledger: lifecycleLedger(),
      issueEvidenceRequests: () => ({
        evidence: [],
        engineProofRecords: [],
        coverageGaps: [],
      }),
    };
  }

  it('deduplicates and atomizes targetFindingIds before canonical matching', () => {
    const extraction = reviewerRawExtractionFixture({
      rawFindingId: 'confirmation',
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      target: { kind: 'code', paths: ['src/lifecycle.ts'] },
      rawExcerpt: 'Relation: resolution_confirmation; Target Finding ID: F-0001, F-0006',
    });
    extraction.candidate!.targetFindingIds = ['F-0006', 'F-0001', 'F-0006'];
    const batch = createReviewerRawFindingCandidates(
      [extraction],
      candidateContext(extraction.rawExcerpt),
    );

    expect(batch.rejections).toEqual([]);
    expect(batch.candidates.map((candidate) => candidate.targetFindingId)).toEqual([
      'F-0001',
      'F-0006',
    ]);
    const canonical = batch.candidates.map((candidate) => (
      canonicalizeReviewerRawFinding(candidate, { ledger: lifecycleLedger() }).canonical
    ));
    expect(canonical.map((item) => item.coherence)).toEqual(['coherent', 'coherent']);
    expect(canonical.map(toLedgerRawFinding).map((wire) => wire.targetFindingId)).toEqual([
      'F-0001',
      'F-0006',
    ]);
  });

  it('inherits clarification taint from the source raw id across every atom', () => {
    const intakeFor = (targetFindingIds: string[]) => {
      const extraction = reviewerRawExtractionFixture({
        rawFindingId: 'multi-target',
        familyTag: null,
        severity: null,
        title: null,
        description: null,
        suggestion: null,
        relation: 'persists',
        targetFindingId: 'F-0001',
        target: { kind: 'code', paths: ['src/lifecycle.ts'] },
        rawExcerpt: 'Relation: persists; Target Finding IDs: F-0001, F-9999',
      });
      extraction.candidate!.targetFindingIds = targetFindingIds;
      return intakeReviewerOutputs({
        subResults: [{
          subStep: {
            kind: 'agent',
            name: 'arch-review',
            persona: 'arch-review',
            edit: false,
          } as never,
          publication: findingReviewPublicationFixture({
            scopeIdentity: '/test/multi-target-taint/ledger.json',
            parentStepName: 'reviewers',
            stepIteration: 1,
            reviewerStepName: 'arch-review',
            rawFindings: [extraction],
          }),
          relationClarification: {
            attempted: true,
            flaggedRawFindingIds: ['multi-target'],
            priorAmbiguityCodesByRawId: {
              'multi-target': ['persists-target-unknown'],
            },
          },
        }],
        previousLedger: lifecycleLedger(),
        workflowName: 'peer-review',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        runId: 'run-1',
        workflowTask: 'Review.',
        cwd: process.cwd(),
        scopeIdentity: '/test/multi-target-taint/ledger.json',
        issuedAt: '2026-07-30T00:00:00.000Z',
        reviewScopeSnapshot: {
          reviewScopeSnapshotId: 'a'.repeat(64),
          trackedDiff: undefined,
          untrackedEvidence: [],
          queryInventory: [],
        },
      });
    };

    const correctionSucceeded = intakeFor(['F-9999', 'F-0001']);
    const correctionFailed = intakeFor(['F-0001', 'F-9999']);
    for (const intake of [correctionSucceeded, correctionFailed]) {
      expect(intake.items).toHaveLength(2);
      expect(intake.items.map(({ canonical }) => canonical.targetFindingId)).toEqual([
        'F-0001',
        'F-9999',
      ]);
      expect(intake.items.every(({ canonical }) => (
        canonical.provenance.ambiguityOrigin
        && canonical.provenance.ambiguityCodes.includes('persists-target-unknown')
      ))).toBe(true);
      expect(intake.items.map(({ canonical }) => canonical.rawFindingId)).toEqual([
        expect.stringMatching(/:multi-target$/),
        expect.stringMatching(/:multi-target-dup2$/),
      ]);
    }
    expect(correctionSucceeded.items.map(({ canonical }) => canonical.rawFindingId))
      .toEqual(correctionFailed.items.map(({ canonical }) => canonical.rawFindingId));
    expect(correctionSucceeded.items.map(({ canonical }) => canonical.claimIdentityHash))
      .toEqual(correctionFailed.items.map(({ canonical }) => canonical.claimIdentityHash));
  });

  it('keeps a lifecycle raw coherent without product finding fields', () => {
    const extraction = reviewerRawExtractionFixture({
      rawFindingId: 'confirmation',
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      target: { kind: 'code', paths: ['src/lifecycle.ts'] },
      rawExcerpt: 'Relation: resolution_confirmation; Target Finding ID: F-0001',
    });
    const [candidate] = createReviewerRawFindingCandidates(
      [extraction],
      candidateContext(extraction.rawExcerpt),
    ).candidates;
    const canonical = canonicalizeReviewerRawFinding(candidate!, {
      ledger: lifecycleLedger(),
    }).canonical;

    expect(canonical).toMatchObject({
      coherence: 'coherent',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    });
    expect(canonical.provenance.ambiguityCodes).not.toContain('missing-required-field');
    expect(toLedgerRawFinding(canonical)).toMatchObject({
      familyTag: null,
      severity: null,
      title: null,
      description: null,
    });
  });

  it.each(['persists', 'resolution_confirmation'] as const)(
    'hydrates target:null %s observations and keeps Finding allocation unchanged across rounds',
    (relation) => {
      let ledger = lifecycleLedger();
      for (let round = 0; round < 3; round += 1) {
        const extraction = reviewerRawExtractionFixture({
          rawFindingId: `${relation}-${round}`,
          familyTag: null,
          severity: null,
          title: null,
          description: null,
          suggestion: null,
          relation,
          targetFindingId: 'F-0001',
          target: { kind: 'code', paths: ['src/lifecycle.ts'] },
          rawExcerpt: `Relation: ${relation}; Target Finding ID: F-0001; round ${round}`,
        });
        extraction.candidate!.target = null;
        const intake = intakeReviewerOutputs({
          subResults: [{
            subStep: {
              kind: 'agent',
              name: 'arch-review',
              persona: 'arch-review',
              edit: false,
            } as never,
            publication: findingReviewPublicationFixture({
              scopeIdentity: '/test/lifecycle-target-hydration/ledger.json',
              parentStepName: 'reviewers',
              stepIteration: round + 1,
              reviewerStepName: 'arch-review',
              rawFindings: [extraction],
            }),
          }],
          previousLedger: ledger,
          workflowName: 'peer-review',
          callNamespace: '',
          parentStepName: 'reviewers',
          stepIteration: round + 1,
          runId: `run-${round}`,
          workflowTask: 'Review.',
          cwd: process.cwd(),
          scopeIdentity: '/test/lifecycle-target-hydration/ledger.json',
          issuedAt: `2026-07-30T00:00:0${round}.000Z`,
          reviewScopeSnapshot: {
            reviewScopeSnapshotId: 'a'.repeat(64),
            trackedDiff: undefined,
            untrackedEvidence: [],
            queryInventory: [],
          },
        });
        expect(intake.intakeProvisionalSpecs).toEqual([]);
        expect(intake.items).toHaveLength(1);
        expect(intake.items[0]?.canonical).toMatchObject({
          coherence: 'coherent',
          relation,
          targetFindingId: 'F-0001',
          target: { kind: 'code', paths: ['src/lifecycle.ts'] },
        });
        const admission = evaluateRawAdmission({
          cwd: process.cwd(),
          reviewScopeSnapshotId: 'a'.repeat(64),
          runId: `run-${round}`,
          scopeIdentity: 'scope',
          previousLedger: ledger,
          intake,
          reviewScopeSnapshot: {
            reviewScopeSnapshotId: 'a'.repeat(64),
            trackedDiff: undefined,
            untrackedEvidence: [],
            queryInventory: [],
          },
          workflowTask: 'Review.',
        });
        expect(admission.admissionProvisionalSpecs).toEqual([]);
        expect(admission.pendingRejectedObservations).toHaveLength(1);
        expect(admission.pendingRejectedObservations[0]?.anomalyKind)
          .toBe('lifecycle-admission-failure');
        expect(admission.pendingRejectedObservations[0]?.destination)
          .toBe('target_audit');
        expect(admission.pendingRejectedObservations[0]?.targetFindingId)
          .toBe('F-0001');
        expect(admission.admissionRejectedItems).toHaveLength(1);
        expect(admission.admissionAnomalySpecs).toEqual([]);
        const observation = {
          runId: `run-${round}`,
          stepName: 'reviewers',
          timestamp: `2026-07-30T00:00:0${round}.000Z`,
        };
        const wire = intake.items[0]!.wire;
        const committed = applyCommitLedgerStates({
          runInput: {
            workflowName: 'peer-review',
            parentStep: { name: 'reviewers' },
            runId: observation.runId,
            timestamp: observation.timestamp,
          } as never,
          freshLedger: ledger,
          settledLedger: {
            ...ledger,
            rawFindings: [...ledger.rawFindings, wire],
          },
          baseAnomalySpecs: [],
          pendingRejectedObservations: admission.pendingRejectedObservations,
          interpretationResults: new Map(),
          interpretationReservations: new Map(),
          interpretationIntegrityDigests: new Map(),
          observation,
          verifiedEvidenceCandidates: [],
          stopBudgetLimits: resolveStopBudgetLimits(undefined),
          stopBudgetRoundMarker: `round-${round}`,
          reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
        });
        expect(committed.reviewerAnomalyLandings).toEqual([]);
        expect(committed.rejectedObservationAttachments).toHaveLength(1);
        ledger = applyRejectedObservationAttachments(
          committed.ledger,
          committed.rejectedObservationAttachments,
          observation,
        );
      }
      expect(ledger.nextId).toBe(100);
      expect(ledger.findings.map((finding) => finding.id)).toEqual(['F-0001', 'F-0006']);
      expect(ledger.findings[0]?.status).toBe('open');
      expect(ledger.findings[0]?.rejectedObservations).toHaveLength(3);
    },
  );
});
