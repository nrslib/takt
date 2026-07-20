import { describe, expect, it, vi } from 'vitest';
import { assembleCleanManagerDecision } from '../core/workflow/findings/manager-clean-decision.js';
import { classifyRawFindingsMechanically } from '../core/workflow/findings/mechanical-classification.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingManagerDecisions,
  RawFinding,
} from '../core/workflow/findings/types.js';
import type { RawAdmissionEvaluation } from '../core/workflow/findings/manager-admission.js';

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

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: '既存の指摘',
    location: 'src/a.ts:10',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-old-1'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(findings: FindingLedgerEntry[]): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: findings.length + 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    rawFindings: [],
    conflicts: [],
    findings,
  };
}

const CONFIRMATION_RAW: RawFinding = {
  rawFindingId: 'raw-confirm',
  stepName: 'arch-review',
  reviewer: 'arch-review',
  familyTag: 'bug',
  severity: 'medium',
  title: '解消を確認',
  description: '修正を確認した。',
  relation: 'resolution_confirmation',
  targetFindingId: 'F-0001',
};

const ISSUE_RAW: RawFinding = {
  rawFindingId: 'raw-issue',
  stepName: 'arch-review',
  reviewer: 'arch-review',
  familyTag: 'bug',
  severity: 'medium',
  title: '新しい指摘',
  location: 'src/b.ts:5',
  description: '別の問題。',
  suggestion: '直す。',
  relation: 'new',
};

function makeAdmission(cleanWire: RawFinding[]): RawAdmissionEvaluation {
  return {
    admissionRejections: [],
    admissionAnomalySpecs: [],
    admissionRejectedItems: [],
    locationlessProvisionalItems: [],
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

describe('assembleCleanManagerDecision の mechanical フォールバック', () => {
  it('最終検証に落ちたら empty ではなく mechanical 出力へ縮退し、残余 raw を manager-output-discarded で保持する', () => {
    const previousLedger = makeLedger([makeFinding()]);
    const cleanWire = [CONFIRMATION_RAW, ISSUE_RAW];
    const mechanical = classifyRawFindingsMechanically({ previousLedger, rawFindings: cleanWire });
    expect(mechanical.output.resolvedFindings.map((resolved) => resolved.findingId)).toEqual(['F-0001']);
    expect(mechanical.residualRawFindings.map((raw) => raw.rawFindingId)).toEqual(['raw-issue']);

    // 未知の違反経路の再現: マージ済み出力への最終検証だけを落とす
    validateMock.mockReturnValueOnce({ ok: false, errors: ['synthetic invariant violation'] });

    const result = assembleCleanManagerDecision({
      previousLedger,
      admission: makeAdmission(cleanWire),
      mechanical,
      decisions: makeDecisions({
        rawDecisions: [{ rawFindingId: 'raw-issue', decision: 'new', evidence: '' }],
      }),
      initialInvalidAttempts: [],
      invalidLocationCandidateFindingIds: new Set(),
      dismissCandidateFindingIds: new Set(),
      priorStepResponseText: undefined,
    });

    // mechanical 確定分（resolution confirmation）は失われない
    expect(result.managerOutput).toEqual(mechanical.output);
    // LLM 判断の残余 raw は discarded kind の provisional として保持
    expect(result.cleanProvisionalSpecs).toHaveLength(1);
    expect(result.cleanProvisionalSpecs[0]).toMatchObject({
      kind: 'manager-output-discarded',
      sourceRawFindingIds: ['raw-issue'],
    });
    // 破棄された LLM 出力の unsupported を採用済み判断として残さない
    expect(result.unsupportedRawFindingReports).toEqual([]);
    // invalid attempt は監査記録として残る
    expect(result.invalidAttempts).toHaveLength(1);
    expect(result.invalidAttempts[0]!.validationErrors).toEqual(['synthetic invariant violation']);
  });

  it('mechanical 出力自体が最終検証に落ちる場合は fail fast（engine バグ）', () => {
    const previousLedger = makeLedger([makeFinding()]);
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
});
