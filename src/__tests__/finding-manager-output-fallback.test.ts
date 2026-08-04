import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleCleanManagerDecision } from '../core/workflow/findings/manager-clean-decision.js';
import { classifyRawFindingsMechanically } from '../core/workflow/findings/mechanical-classification.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerDecisions,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type { RawAdmissionEvaluation } from '../core/workflow/findings/manager-admission.js';
import { canonicalRawFindingFixture } from './helpers/finding-lifecycle-fixture.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';

// 正規化（manager-plan-normalization）で既知の排他違反は assembly 段で解消される
// ため、最終検証の失敗は「未知の違反経路」でしか起きない。ここでは検証を部分
// モックしてその経路を再現し、縮退の配線（mechanical 温存・discarded provisional
// の生成・engine バグ時の fail fast）を検証する。
vi.mock('../core/workflow/findings/manager-output-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/manager-output-validation.js')>();
  return {
    ...actual,
    validateFindingManagerOutput: vi.fn(actual.validateFindingManagerOutput),
  };
});

const { validateFindingManagerOutput } = await import('../core/workflow/findings/manager-output-validation.js');
const validateMock = vi.mocked(validateFindingManagerOutput);

function makeFinding(
  overrides: Pick<FindingLedgerEntry, 'revision'> & Partial<Omit<FindingLedgerEntry, 'revision'>>,
): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '既存の指摘',
    location: 'src/a.ts:10',
    evidenceIds: [],
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-old-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[]): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
  };
}

const CONFIRMATION_RAW: RawFinding = canonicalRawFindingFixture({
  rawFindingId: 'raw-confirm',
  stepName: 'arch-review',
  reviewer: 'arch-review',
  familyTag: 'bug',
  severity: 'medium',
  title: '解消を確認',
  description: '修正を確認した。',
  suggestion: null,
  relation: 'resolution_confirmation',
  targetFindingId: 'F-0001',
  target: { kind: 'code', paths: ['src/a.ts'] },
  evidence: [],
});

const ISSUE_RAW: RawFinding = canonicalRawFindingFixture({
  rawFindingId: 'raw-issue',
  stepName: 'arch-review',
  reviewer: 'arch-review',
  familyTag: 'bug',
  severity: 'medium',
  title: '新しい指摘',
  description: '別の問題。',
  suggestion: '直す。',
  relation: 'new',
  targetFindingId: null,
  target: { kind: 'code', paths: ['src/b.ts'] },
  evidence: [],
});

const PERSISTS_RAW: RawFinding = canonicalRawFindingFixture({
  ...CONFIRMATION_RAW,
  rawFindingId: 'raw-persists',
  relation: 'persists',
  description: 'The prior claim does not hold.',
});

function makeAdmission(cleanWire: RawFinding[]): RawAdmissionEvaluation {
  return {
    admissionRejections: [],
    admissionAnomalySpecs: [],
    admissionRejectedItems: [],
    pendingRejectedObservations: [],
    cleanAdmitted: cleanWire.map((wire) => ({
      wire,
      canonical: {
        rawFindingId: wire.rawFindingId,
        reviewerStableKey: 'reviewer-stable',
        lineageKey: `lineage-${wire.rawFindingId}`,
      },
    })) as never,
    tainted: [],
    taintedAdmitted: [],
    ladderAnomalySpecs: [],
    verifiedEvidenceCandidates: [],
    provisionalOnlyLadderRawIds: new Set(),
    verifiedEvidenceRecordsByRawFindingId: new Map(),
    cleanWire,
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

function makeActiveConflictDuplicateScenario() {
  const observedAt = { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' };
  const previousLedger = makeLedger([
    makeFinding({ revision: 1 }),
    makeFinding({ revision: 1, id: 'F-0002', rawFindingIds: ['raw-old-2'] }),
  ]);
  previousLedger.conflicts = [{
    id: 'C-2BF240CC0BEC',
    status: 'active',
    findingIds: ['F-0002'],
    rawFindingIds: ['raw-conflict'],
    description: 'F-0002 is disputed.',
    firstSeen: observedAt,
    lastSeen: observedAt,
  }];
  return {
    previousLedger,
    output: {
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
      duplicateFindings: [{
        canonicalFindingId: 'F-0001',
        duplicateFindingIds: ['F-0002'],
        evidence: 'Same underlying issue.',
      }],
      dismissedFindings: [],
    },
  };
}

describe('assembleCleanManagerDecision の mechanical フォールバック', () => {
  beforeEach(() => {
    validateMock.mockReset();
  });

  it('最終検証は active conflict に触れる duplicate を除いた保存時ビューを使う', () => {
    const { previousLedger, output } = makeActiveConflictDuplicateScenario();
    validateMock.mockReturnValue({ ok: true });

    const result = assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission([]),
      mechanical: {
        output,
        residualRawFindings: [],
      } as ReturnType<typeof classifyRawFindingsMechanically>,
      decisions: undefined,
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    });

    expect(result.managerOutput.duplicateFindings).toHaveLength(1);
    expect(validateMock).toHaveBeenCalledWith(expect.objectContaining({
      managerOutput: expect.objectContaining({ duplicateFindings: [] }),
    }));
  });

  it('mechanical フォールバックも active conflict に触れる duplicate を除いた保存時ビューで検証する', () => {
    const { previousLedger, output } = makeActiveConflictDuplicateScenario();
    validateMock
      .mockReturnValueOnce({ ok: false, errors: ['synthetic invariant violation'] })
      .mockReturnValueOnce({ ok: true });

    const result = assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission([]),
      mechanical: {
        output,
        residualRawFindings: [],
      } as ReturnType<typeof classifyRawFindingsMechanically>,
      decisions: undefined,
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    });

    expect(result.managerOutput.duplicateFindings).toEqual(output.duplicateFindings);
    expect(validateMock).toHaveBeenCalledTimes(2);
    for (const call of validateMock.mock.calls) {
      expect(call[0].managerOutput.duplicateFindings).toEqual([]);
    }
  });

  it('最終検証に落ちたら empty ではなく mechanical 出力へ縮退し、残余 raw を manager-output-discarded で保持する', () => {
    const previousLedger = makeLedger([makeFinding({ revision: 1 })]);
    const cleanWire = [{
      ...CONFIRMATION_RAW,
      targetPrecondition: captureFindingMutationPrecondition(previousLedger, 'F-0001')!,
    }, ISSUE_RAW];
    const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });
    expect(mechanical.output.resolvedFindings).toEqual([]);
    expect(mechanical.residualRawFindings.map((raw) => raw.rawFindingId)).toEqual([
      'raw-confirm',
      'raw-issue',
    ]);

    // 未知の違反経路の再現: マージ済み出力への最終検証だけを落とす
    validateMock.mockReturnValueOnce({ ok: false, errors: ['synthetic invariant violation'] });

    const result = assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission(cleanWire),
      mechanical,
      decisions: makeDecisions({
        rawDecisions: [
          {
            rawFindingId: 'raw-confirm',
            decision: 'resolved',
            findingId: 'F-0001',
            evidence: 'The original failure mode is fixed.',
            anchorRelevance: 'not_applicable',
          },
          {
            rawFindingId: 'raw-issue',
            decision: 'new',
            evidence: '',
            anchorRelevance: 'not_applicable',
          },
        ],
      }),
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    });

    // semantic manager 出力は破棄され、空の mechanical 確定分だけが残る
    expect(result.managerOutput).toEqual(mechanical.output);
    // LLM 判断の残余 raw はすべて discarded kind の provisional として保持
    expect(result.cleanProvisionalSpecs).toHaveLength(1);
    expect(result.cleanProvisionalSpecs).toEqual([expect.objectContaining({
      kind: 'manager-output-discarded',
      sourceRawFindingIds: ['raw-issue'],
    })]);
    expect(result.unsupportedRawFindingReports).toEqual([expect.objectContaining({
      rawFindingId: 'raw-confirm',
      targetFindingId: 'F-0001',
    })]);
    // lifecycle raw は product finding にせず audit-only で保持する
    expect(result.unsupportedRawFindingReports).toEqual([{
      rawFindingId: 'raw-confirm',
      targetFindingId: 'F-0001',
      evidence: 'Manager output violated ledger invariants and was discarded',
    }]);
    // invalid attempt は監査記録として残る
    expect(result.invalidAttempts).toHaveLength(1);
    expect(result.invalidAttempts[0]!.validationErrors).toEqual(['synthetic invariant violation']);
  });

  it('mechanical 出力自体が最終検証に落ちる場合は fail fast（engine バグ）', () => {
    const previousLedger = makeLedger([makeFinding({ revision: 1 })]);
    const cleanWire = [CONFIRMATION_RAW];
    const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });

    validateMock.mockReturnValue({ ok: false, errors: ['synthetic invariant violation'] });

    expect(() => assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission(cleanWire),
      mechanical,
      decisions: undefined,
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    })).toThrow(/engine bug/);
  });

  it('mechanical persists と semantic confirmation が同時なら対象を open のまま維持する', () => {
    const previousLedger = makeLedger([makeFinding({ revision: 1 })]);
    const targetPrecondition = captureFindingMutationPrecondition(previousLedger, 'F-0001')!;
    const cleanWire = [
      { ...PERSISTS_RAW, targetPrecondition },
      { ...CONFIRMATION_RAW, targetPrecondition },
    ];
    const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });
    expect(mechanical.residualRawFindings.map((raw) => raw.rawFindingId)).toEqual(['raw-confirm']);
    validateMock.mockReturnValue({ ok: true });

    const result = assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission(cleanWire),
      mechanical,
      decisions: makeDecisions({
        rawDecisions: [
          {
            rawFindingId: 'raw-confirm',
            decision: 'resolved',
            findingId: 'F-0001',
            evidence: 'The fix is present.',
            anchorRelevance: 'not_applicable',
          },
        ],
      }),
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    });

    expect(result.managerOutput.resolvedFindings).toEqual([]);
    expect(result.managerOutput.matches).toEqual([
      expect.objectContaining({ findingId: 'F-0001', rawFindingIds: ['raw-persists'] }),
    ]);
    expect(result.cleanProvisionalSpecs).toEqual([]);
    expect(result.unsupportedRawFindingReports).toEqual([]);
  });
});
