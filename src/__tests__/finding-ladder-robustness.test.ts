/**
 * v2 梯子設計（raw finding 意味矛盾）の堅牢性検証ケース8件の再現回帰テスト
 * （設計書 §13）。検証入力列をそのまま再現し、修正後の挙動 — 権限拒否・
 * provisional 化・CAS 不採用・conflict 化 — を固定する。
 *
 * ケース対応表:
 *   ケース1: 権限の不正遷移（manager が resolve/waive/invalidate/supersede/証明なし same）
 *   ケース2: candidate/canonical 型混同（型 assertion / spread / 手組み object）
 *   ケース3: stale confirmation（prompt 後の persists 保存と競合する確認）
 *   ケース4: persists の不正吸収（ambiguous persists の target 吸収）
 *   ケース5: 永久機関（同一 lineage の ambiguous raw 再発による ID 増殖・解釈無限化）
 *   ケース6: no-op ゲート回避（空配列・不正 decision・unknown id・unsupported）
 *   ケース7: resource exhaustion（435 raw・巨大 description・step 上限超過）
 *   ケース8: crash/replay（WAL 各段でのプロセス停止と resume）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingLedgerStore,
  RawFinding,
} from '../core/workflow/findings/types.js';
import { runFindingManagerForStep } from '../core/workflow/findings/manager-runner.js';
import { createFindingLedgerStore, type FindingManagerValidationReport } from '../core/workflow/findings/store.js';
import {
  canonicalizeReviewerRawFinding,
  candidateFromStoredRawFinding,
  computeBaseInterpretationKey,
  computeInterpretationAttemptKey,
  computeLineageKey,
  computeProvisionalStableKey,
  computeRawEvidenceHash,
  computeReviewerStableKey,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { AmbiguousInterpretationsOutputJsonSchema } from '../core/workflow/findings/schemas.js';
import { issueDeterministicSameProofs, verifySameProofAgainstLedger } from '../core/workflow/findings/raw-capabilities.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { stopBudgetRoundsCompleted } from '../core/workflow/findings/stop-budget.js';
import { computeRoundMarker } from '../core/workflow/findings/round-marker.js';
import { createFindingAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd());
}
const executeAgentMock = vi.mocked(executeAgent);

// raw admission validation が実 fs を見るため fixture を用意する。
const TEST_TMPDIR = realpathSync(tmpdir());
const FIXTURE_CWD = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-robustness-fixtures-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/a.ts', 60);
writeFixtureFile('src/b.ts', 60);
execFileSync('git', ['init', '--quiet'], { cwd: FIXTURE_CWD });
execFileSync('git', ['add', 'src/a.ts', 'src/b.ts'], { cwd: FIXTURE_CWD });
execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: FIXTURE_CWD });

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Existing issue',
    location: 'src/a.ts:10',
    description: 'Existing issue body.',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    revision: 1,
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [makeFinding()],
    rawFindings: [{
      rawFindingId: 'raw-existing',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue',
      location: 'src/a.ts:10',
      description: 'Existing issue body.',
    }],
    conflicts: [],
    ...overrides,
  };
}

interface Harness {
  savedLedgers: FindingLedger[];
  savedReports: FindingManagerValidationReport[];
  currentLedger: () => FindingLedger;
  run: (input: {
    reviewerRawFindings: Array<Record<string, unknown>>;
    runId?: string;
    priorStepResponseText?: string;
    /** updateLedger の最初の呼び出し直前に fresh ledger を差し替える（並行更新の再現）。 */
    interceptFresh?: (fresh: FindingLedger) => FindingLedger;
  }) => ReturnType<typeof runFindingManagerForStep>;
}

function makeHarness(
  initialLedger: FindingLedger,
  stopBudget?: { maxRounds?: number; maxMinutes?: number },
  afterUpdate?: (ledger: FindingLedger) => Promise<void>,
): Harness {
  let ledger = initialLedger;
  const savedLedgers: FindingLedger[] = [];
  const savedReports: FindingManagerValidationReport[] = [];
  let intercept: ((fresh: FindingLedger) => FindingLedger) | undefined;
  const ledgerStore: FindingLedgerStore = {
    workflowName: 'peer-review',
    loadLedger: () => ledger,
    saveLedger: (next) => { ledger = next; savedLedgers.push(next); },
    updateLedger: async (mutator) => {
      if (intercept !== undefined) {
        ledger = intercept(ledger);
        intercept = undefined;
      }
      const mutation = mutator(ledger);
      ledger = mutation.ledger;
      savedLedgers.push(ledger);
      await afterUpdate?.(ledger);
      return mutation;
    },
    ...createFindingAdjudicationReservation(),
    createRunCopy: () => '/tmp/ledger-copy.json',
    saveRawFindings: () => '/tmp/raw-findings.json',
    saveManagerValidationReport: (report) => {
      savedReports.push(report);
      return '/tmp/manager-report.json';
    },
    saveConflictAdjudicationReport: () => '/tmp/adjudication-report.json',
    saveNeedsAdjudicationReport: () => '/tmp/needs-adjudication.json',
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    recordSynthesizedAgentUsage: () => {},
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    ledgerPath: '.takt/findings/ledger.json',
    rawFindingsPath: '.takt/findings/raw',
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
    ...(stopBudget !== undefined ? { stopBudget } : {}),
  };
  return {
    savedLedgers,
    savedReports,
    currentLedger: () => ledger,
    run: (input) => {
      intercept = input.interceptFresh;
      return runFindingManagerForStep({
        contract: contract as never,
        ledgerStore,
        optionsBuilder: optionsBuilder as never,
        stepExecutor: stepExecutor as never,
        cwd: FIXTURE_CWD,
        parentStep,
        stepIteration: 2,
        subResults: [
          {
            subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
            response: {
              status: 'done',
              content: '',
              structuredOutput: { rawFindings: input.reviewerRawFindings },
            } as unknown as AgentResponse,
          },
        ],
        workflowName: 'peer-review',
        runId: input.runId ?? 'run-2',
        callNamespace: '',
        timestamp: '2026-06-14T00:00:00.000Z',
        priorStepResponseText: input.priorStepResponseText,
      });
    },
  };
}

/** intake が使うのと同一の材料でこのテストの reviewer stable key を再現する。 */
const REVIEWER_STABLE_KEY = computeReviewerStableKey({
  workflowName: 'peer-review',
  callNamespace: '',
  parentStepName: 'reviewers',
  reviewerPersonaKey: 'arch',
});

/** 対象 F-0001 を指す ambiguous persists（本文が target と異なる）。 */
const AMBIGUOUS_PERSISTS_RAW = {
  rawFindingId: 'p-1',
  familyTag: 'bug',
  severity: 'high',
  title: 'Existing issue still present',
  description: 'Claims the resolved issue persists with different content.',
  suggestion: '',
  relation: 'persists',
  targetFindingId: 'F-0001',
  ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20),
};

function interpretationResponse(interpretations: Array<Record<string, unknown>>): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    structuredOutput: { interpretations },
    timestamp: new Date('2026-06-14T00:00:01.000Z'),
  } as unknown as AgentResponse;
}

function extractResidualRawIdFromInterpretationInstruction(instruction: string, localId: string): string {
  const matches = [...instruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)].map((match) => match[1]!);
  const found = matches.find((id) => id.endsWith(`:${localId}`));
  if (found === undefined) {
    throw new Error(`Test setup error: raw id ending with :${localId} not found in interpretation instruction`);
  }
  return found;
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

// ---------------------------------------------------------------------------
// ケース1: 権限の不正遷移
// ---------------------------------------------------------------------------
describe('ケース1: 権限の不正遷移（manager が capability の外の操作を提案する）', () => {
  it('resolve/waive/invalidate/supersede 相当の提案語彙は schema に存在せず、返すと batch 全体が provisional に落ちる。target は不変', async () => {
    // 対象が resolved の persists → ambiguous → 解釈フェーズへ。manager が
    // 「resolve」を返す（提案 enum の外 = 権限の不正遷移の試み）。
    const ledger = makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 3 })],
    });
    const harness = makeHarness(ledger);
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([
        { decision: 'resolve', rawFindingId: rawId, proofId: '', targetFindingId: 'F-0001', reason: '' },
      ]);
    });

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('resolved');
    expect(target?.revision).toBe(3);
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
  });

  it('証明なし same（same_with_proof + 捏造 proofId）は拒否され、target 不変 + provisional open になる', async () => {
    const ledger = makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 })],
    });
    const harness = makeHarness(ledger);
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([
        { decision: 'same_with_proof', rawFindingId: rawId, proofId: 'invalid-proof-id', targetFindingId: '', reason: '' },
      ]);
    });

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('resolved');
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(provisional?.provisional?.reason).toContain('engine-issued proof');
  });
});

// ---------------------------------------------------------------------------
// ケース2: candidate/canonical 型混同
// ---------------------------------------------------------------------------
describe('ケース2: candidate/canonical 型混同（factory を通らない object の runtime 拒否）', () => {
  const intakeContext = {
    workflowName: 'peer-review',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    runId: 'run-x',
    reviewerStepName: 'arch-review',
    reviewerPersonaKey: 'arch',
  };

  it('手組みの candidate 風 object は canonical 生成関数が拒否する', () => {
    const handmade = {
      intakeId: 'x', reviewerStableKey: 'x', sourceBytes: 1, reviewer: 'r', stepName: 's',
      title: 't', description: 'd', severity: 'high', familyTag: 'bug', relation: 'new',
    };
    expect(() => canonicalizeReviewerRawFinding(handmade as never, { ledger: makeLedger() }))
      .toThrow(/did not come from a candidate factory/);
  });

  it('spread で複製した canonical は brand を失い、downstream（toLedgerRawFinding / SameProof 発行）が拒否する', () => {
    const [candidate] = createReviewerRawFindingCandidates([
      { rawFindingId: 'raw-1', title: 'T', description: 'D', severity: 'high', familyTag: 'bug', relation: 'new', targetFindingId: '', location: 'src/a.ts:5', suggestion: '' },
    ], intakeContext);
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger: makeLedger() });
    // 正規経路は通る。
    expect(() => toLedgerRawFinding(canonical)).not.toThrow();
    // spread による「昇格コピー」は runtime で拒否される。
    const invalidCandidate = { ...canonical };
    expect(() => toLedgerRawFinding(invalidCandidate as never)).toThrow(/candidate\/canonical type confusion/);
    expect(() => issueDeterministicSameProofs({ ledger: makeLedger(), ambiguousRawFindings: [invalidCandidate as never] }))
      .toThrow(/candidate\/canonical type confusion/);
  });

  it('型 assertion で作った canonical 風 object も runtime で拒否される', () => {
    const invalidCandidate = {
      rawFindingId: 'r', reviewerStableKey: 'k', lineageKey: 'l', evidenceHash: 'h',
      relation: 'resolution_confirmation',
      reviewer: 'r', stepName: 's', coherence: 'coherent',
      provenance: { origin: 'reviewer', ambiguityOrigin: false, clarificationAttempted: false, ambiguityCodes: [] },
      familyTag: 'bug', severity: 'high', title: 't', description: 'd', targetFindingId: 'F-0001',
    };
    expect(() => toLedgerRawFinding(invalidCandidate as never)).toThrow(/candidate\/canonical type confusion/);
  });

  it('保存済み raw も同じ factory（candidateFromStoredRawFinding → canonicalize）を通る', () => {
    const storedRaw: RawFinding = {
      rawFindingId: 'raw-stored',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Stored issue',
      location: 'src/a.ts:10',
      description: 'Stored body.',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    };
    const candidate = candidateFromStoredRawFinding(storedRaw, REVIEWER_STABLE_KEY);
    expect(candidate.relation).toBe('resolution_confirmation');
    const { canonical } = canonicalizeReviewerRawFinding(candidate, { ledger: makeLedger() });
    expect(canonical.relation).toBe('resolution_confirmation');
    expect(() => toLedgerRawFinding(canonical)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ケース3: stale confirmation（coherent 経路でも成立すること）
// ---------------------------------------------------------------------------
describe('ケース3: stale confirmation（prompt 後の persists 保存と競合する形式的に正しい確認）', () => {
  it('coherent confirmation の snapshot 後に別 caller が persists を保存すると、resolve されず target open + active conflict + provisional になる', async () => {
    const harness = makeHarness(makeLedger());
    // 形式的に正しい confirmation（coherent）→ 機械分類で resolved 候補になる。
    const confirmation = {
      rawFindingId: 'c-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed fixed',
      description: 'Verified the fix at src/a.ts:10.',
      suggestion: '',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
    };
    // 保存の直前に、別の並列 caller が同じ target へ persists を保存した状況を再現。
    const result = await harness.run({
      reviewerRawFindings: [confirmation],
      interceptFresh: (fresh) => ({
        ...fresh,
        findings: fresh.findings.map((finding) => (finding.id === 'F-0001'
          ? {
            ...finding,
            rawFindingIds: [...finding.rawFindingIds, 'raw-concurrent-persists'],
            revision: (finding.revision ?? 1) + 1,
            lastSeen: { runId: 'other-run', stepName: 'reviewers', timestamp: '2026-06-14T00:00:00.500Z' },
          }
          : finding)),
        rawFindings: [
          ...fresh.rawFindings,
          {
            rawFindingId: 'raw-concurrent-persists',
            stepName: 'reviewers',
            reviewer: 'security-review',
            familyTag: 'bug',
            severity: 'high',
            title: 'Existing issue',
            location: 'src/a.ts:12',
            description: 'Still observing the issue.',
            relation: 'persists',
            targetFindingId: 'F-0001',
          },
        ],
      }),
    });

    expect(result.status).toBe('updated');
    // 機械分類だけで完結する入力なので manager は呼ばれない（coherent 経路の再現）。
    expect(executeAgentMock).not.toHaveBeenCalled();

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    // target は open のまま（confirmation は適用されない）。
    expect(target?.status).toBe('open');
    // confirmation と persists を参照する active conflict が立つ。
    const conflict = saved.conflicts.find((entry) => entry.status === 'active' && entry.findingIds.includes('F-0001'));
    expect(conflict).toBeDefined();
    // confirmation 側の stale-precondition provisional が立つ。
    const provisional = saved.findings.find((finding) => finding.provisional?.kind === 'stale-precondition');
    expect(provisional?.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// ケース4: persists の不正吸収
// ---------------------------------------------------------------------------
describe('ケース4: persists の不正吸収（ambiguous persists を target に吸収させる試み）', () => {
  it('内容が target と異なる ambiguous persists に決定的 proof は発行されず、manager が create_independent を返しても target の rawFindingIds / revision / lastSeen は変化しない', async () => {
    // 対象 F-0001 は resolved → persists は ambiguous（persists-target-not-open）。
    const ledger = makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 5 })],
    });
    const harness = makeHarness(ledger);
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      // proof は提示されていない（内容不一致）ことを固定する。
      expect(instruction as string).toContain('"availableSameProofId": null');
      return interpretationResponse([
        { decision: 'create_independent', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: '' },
      ]);
    });

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    // target は一切変化しない（rawFindingIds / lastSeen / revision — 決定的 same なしの吸収禁止）。
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    expect(target?.revision).toBe(5);
    expect(target?.lastSeen.runId).toBe('run-1');
    expect(target?.status).toBe('resolved');
    // 独立した confirmed open finding が立つ（§5 規則2）。
    const independent = saved.findings.find((finding) => finding.title === 'Existing issue still present');
    expect(independent?.status).toBe('open');
    expect(independent?.provisional).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ケース5: 永久機関
// ---------------------------------------------------------------------------
describe('ケース5: 永久機関（同一 lineage の ambiguous raw を run/iteration/id/説明文/行番号を変えて繰り返す）', () => {
  it('finding ID は増殖せず同じ provisional が更新され、manager 解釈は lineage 上限2 epoch で止まる', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
    }));
    let interpretationCalls = 0;
    let dismissConsultations = 0;
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      // 解釈 epoch 枯渇後は provisional が dismiss 候補になり、decisions manager
      // への相談が始まる（永久機関の設計上の出口）。ここでは manager が裁定を
      // 保留する（空 decisions）ケースとして扱い、解釈呼び出しとは別に数える。
      if (!(instruction as string).includes('## Ambiguous raw finding interpretation')) {
        dismissConsultations += 1;
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
        } as unknown as AgentResponse;
      }
      interpretationCalls += 1;
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' },
      ]);
    });

    // 4ラウンド: runId・rawFindingId・説明文（= evidence 実質変更）・行番号を毎回変える。
    // 行番号を変えるので verbatimExcerpt/snapshotId もラウンドごとに実ファイルへ
    // 揃え直す（typed evidence protocol、codex 対策#4 — location だけ変えると
    // verbatimExcerpt との不一致で証跡不成立 anomaly に落ちてしまう）。
    for (let round = 1; round <= 4; round += 1) {
      const result = await harness.run({
        runId: `run-${round}`,
        reviewerRawFindings: [{
          ...AMBIGUOUS_PERSISTS_RAW,
          rawFindingId: 'p-1',
          description: `Claims the resolved issue persists (attempt #${round}).`,
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20 + round),
        }],
      });
      expect(result.status).toBe('updated');
    }

    const saved = harness.currentLedger();
    // 同じ claim（path+title+familyTag は不変 → lineage 同一）の provisional は1件だけ。
    const provisionals = saved.findings.filter((finding) => finding.provisional !== undefined);
    expect(provisionals).toHaveLength(1);
    expect(provisionals[0]?.status).toBe('open');
    expect(provisionals[0]?.lifecycle).toBe('persists');
    // 4ラウンド分の raw が同じ provisional に集約されている。
    expect(provisionals[0]?.rawFindingIds.length).toBeGreaterThanOrEqual(4);
    // manager 解釈は lineage あたり最大2 epoch（3・4ラウンド目は呼ばれない）。
    expect(interpretationCalls).toBe(2);
    // 「今回出なかった」だけでは resolve されない（無 raw ラウンド後も open のまま）。
    const after = await harness.run({ runId: 'run-5', reviewerRawFindings: [] });
    expect(after.ledger.findings.filter((finding) => finding.provisional !== undefined)[0]?.status).toBe('open');
    expect(interpretationCalls).toBe(2);
    // 解釈枯渇後（3ラウンド目以降）は dismiss 候補として decisions manager に
    // 相談され続ける — 解釈の無限化は止まったまま、裁定という出口が開いている。
    expect(dismissConsultations).toBeGreaterThan(0);
  }, 30_000);
});

describe('ケース5 の出口: 解釈枯渇後の dismiss 裁定', () => {
  it('dismiss と同一ラウンドに同じ claim の raw が再来しても、新 ID の open provisional は復活せずゲートが開く', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
    }));
    let dismissTargetId: string | undefined;
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      if (!(instruction as string).includes('## Ambiguous raw finding interpretation')) {
        // 解釈枯渇後の decisions 相談: 提示された候補を dismiss する。
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: dismissTargetId !== undefined
              ? [{ findingId: dismissTargetId, basis: 'unverifiable_claim', reason: '解釈2 epoch と再観測でも確定できない主張' }]
              : [],
          },
        } as unknown as AgentResponse;
      }
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' },
      ]);
    });

    // round 1-2: 解釈 epoch を使い切る（provisional は同一 ID で滞留）。
    for (let round = 1; round <= 2; round += 1) {
      await harness.run({
        runId: `run-${round}`,
        reviewerRawFindings: [{
          ...AMBIGUOUS_PERSISTS_RAW,
          description: `Claims the resolved issue persists (attempt #${round}).`,
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20 + round),
        }],
      });
    }
    const provisionalBefore = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined);
    expect(provisionalBefore?.status).toBe('open');
    dismissTargetId = provisionalBefore!.id;

    // round 3: 同じ claim の raw が再来し、同一ラウンドで manager が dismiss を裁定する。
    const result = await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        ...AMBIGUOUS_PERSISTS_RAW,
        description: 'Claims the resolved issue persists (attempt #3).',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 23),
      }],
    });

    const saved = result.ledger;
    const dismissed = saved.findings.find((finding) => finding.id === dismissTargetId)!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissal?.basis).toBe('unverifiable_claim');
    // 同じ claim の再来は新 ID の open provisional として復活しない — ゲートが開く。
    expect(saved.findings.filter((finding) => finding.status === 'open')).toEqual([]);
    // 抑止した観測は dismissed finding へ監査添付される（黙って消えない）。
    expect(dismissed.rejectedObservations?.some((observation) => observation.rawFindingId.startsWith('run-3:'))).toBe(true);
    // 監査レポートの provisionalLandings は実台帳と整合する — 抑止された spec を
    // 「着地済み」として報告しない。
    const lastReport = harness.savedReports.at(-1);
    expect(lastReport?.provisionalLandings ?? []).not.toContainEqual(
      expect.objectContaining({
        sourceRawFindingIds: expect.arrayContaining([expect.stringMatching(/^run-3:/)]),
      }),
    );
  }, 30_000);
});

describe('ケース5 変種: 同一 evidence 再送（codex B1）', () => {
  it('applied 済みと同一 evidence の raw を再送しても provisional は増殖せず、同じエントリへ帰属して manager も呼ばれない', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
    }));
    let interpretationCalls = 0;
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      interpretationCalls += 1;
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' },
      ]);
    });

    // round 1: 解釈 → provisional 着地（ledger_applied）。
    await harness.run({ runId: 'run-a', reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    // round 2: フィールド完全同一（= evidence hash 同一）の再送。
    await harness.run({ runId: 'run-b', reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });

    expect(interpretationCalls).toBe(1);
    const saved = harness.currentLedger();
    const provisionals = saved.findings.filter((finding) => finding.provisional !== undefined);
    // 旧実装は fallback が別の reviewerStableKey を導出して2つ目の provisional を
    // 作っていた（実測: F-0002 と F-0003 の併存）。同一エントリへの帰属を固定する。
    expect(provisionals).toHaveLength(1);
    expect(provisionals[0]?.rawFindingIds.some((id) => id.startsWith('run-a:'))).toBe(true);
    expect(provisionals[0]?.rawFindingIds.some((id) => id.startsWith('run-b:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ケース6: no-op ゲート回避
// ---------------------------------------------------------------------------
describe('ケース6: no-op ゲート回避（空配列・unknown id・unsupported で先へ進める試み）', () => {
  it('decisions manager が空配列 + unknown raw id + unsupported を返しても raw は消えず provisional open になり、findings.provisional.count が gate を塞ぐ', async () => {
    const harness = makeHarness(makeLedger());
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const persistsId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'e-1');
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [
            // unknown raw id への decision（黙って無視される）
            { rawFindingId: 'raw-unknown-id', decision: 'new', findingId: '', evidence: 'x' },
            // 明示参照 raw への unsupported（監査のみで消える経路は v2 で禁止）
            { rawFindingId: persistsId, decision: 'unsupported', findingId: '', evidence: 'Reference does not hold.' },
            // i-1 への decision は返さない（欠落）
          ],
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date('2026-06-14T00:00:01.000Z'),
      } as unknown as AgentResponse;
    });

    const result = await harness.run({
      reviewerRawFindings: [
        {
          // admission を通す（機械照合済み evidence）ことで decisions manager
          // の「決定を返さない」を単独で試せるようにする — evidence が無いと
          // typed evidence protocol（codex 対策#4）が manager に渡す前に
          // reviewer anomaly へ隔離してしまい、このケースの対象外になる。
          rawFindingId: 'i-1',
          familyTag: 'security',
          severity: 'medium',
          title: 'Unhandled new issue',
          description: 'A new problem the manager ignores.',
          suggestion: '',
          relation: 'new',
          targetFindingId: '',
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 5),
        },
        {
          // coherent な明示参照（open target への persists）だが機械分類には
          // 掛からないよう本文を target と変え、residual として manager に渡る
          // ……persists で open target は機械 same になるため、ここは
          // target を open のまま参照しつつ manager 判断を要する形にする:
          // reopened（open target への reopened は ambiguous になるため使わない）
          // ではなく、対象未知の confirmation を使う。
          rawFindingId: 'e-1',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue persists',
          description: 'Still broken with different details.',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 30),
        },
      ],
    });
    expect(result.status).toBe('updated');

    const saved = harness.currentLedger();
    // e-1 は機械 same（open target への coherent persists）として F-0001 に
    // 吸収されるため、manager の unsupported は decision 済み raw への重複と
    // して無視される。i-1（欠落）は provisional として残る。
    const context = buildFindingsRuleContext(saved);
    expect(context.provisional.count).toBeGreaterThanOrEqual(1);
    // 欠落 raw は裁定未了（RawAdjudicationRecovery 管轄）として保持される
    expect(context.provisional.items.some((item) => item.kind === 'raw-adjudication-unresolved')).toBe(true);
    const provisional = saved.findings.find((finding) => finding.title === 'Unhandled new issue');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.gateEffect).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// ケース7: resource exhaustion
// ---------------------------------------------------------------------------
describe('ケース7: resource exhaustion（435 raw・巨大 description・step 上限）', () => {
  function makeManyRaws(count: number, prefix: string): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, index) => ({
      rawFindingId: `${prefix}-${index + 1}`,
      familyTag: 'flood',
      severity: 'low',
      title: `Flood finding ${prefix}-${index + 1}`,
      location: 'src/b.ts:5',
      description: `Flood description ${index + 1}.`,
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
    }));
  }

  it('435 raw の reviewer は単一の reviewer-output-overflow blocker に置き換わり、finding が435件立つことはない（部分採用もしない）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    const result = await harness.run({ reviewerRawFindings: makeManyRaws(435, 'flood') });

    expect(result.status).toBe('updated');
    // manager は呼ばれない（overflow は解釈対象ではない）。
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    expect(saved.findings).toHaveLength(1);
    const blocker = saved.findings[0]!;
    expect(blocker.provisional?.kind).toBe('reviewer-output-overflow');
    expect(blocker.severity).toBe('high');
    expect(blocker.status).toBe('open');
    // 先頭64件の部分採用が起きていない（flood タイトルの finding が無い）。
    expect(saved.findings.some((finding) => finding.title.startsWith('Flood finding'))).toBe(false);
    expect(harness.savedReports[0]?.reviewerOutputOverflows).toHaveLength(1);
  });

  it('巨大 description（8192超）を1件でも含む reviewer は全量が単一 overflow に置き換わる', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    const raws = makeManyRaws(3, 'big');
    raws[1]!.description = 'x'.repeat(9000);
    const result = await harness.run({ reviewerRawFindings: raws });

    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.findings).toHaveLength(1);
    expect(saved.findings[0]?.provisional?.kind).toBe('reviewer-output-overflow');
  });

  it('複数 reviewer の合算が step 上限（128件）を超えると超過側の reviewer だけが overflow になり、正常 reviewer の raw は処理される', async () => {
    // 2 reviewer を subResults で渡すため、harness ではなく直接構築する。
    let ledger = makeLedger({ findings: [], rawFindings: [] });
    const ledgerStore: FindingLedgerStore = {
      workflowName: 'peer-review',
      loadLedger: () => ledger,
      saveLedger: (next) => { ledger = next; },
      updateLedger: (mutator) => {
        const mutation = mutator(ledger);
        ledger = mutation.ledger;
        return Promise.resolve(mutation);
      },
      ...createFindingAdjudicationReservation(),
      createRunCopy: () => '/tmp/ledger-copy.json',
      saveRawFindings: () => '/tmp/raw-findings.json',
      saveManagerValidationReport: () => '/tmp/manager-report.json',
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
      recordSynthesizedAgentUsage: () => {},
      normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    };
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      // 正常 reviewer の raw への decisions（全部 new）。
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:ok-\d+)"/g)].map((match) => match[1]!);
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({ rawFindingId, decision: 'new', findingId: '', evidence: 'fresh' })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });

    const okRaws = makeManyRaws(3, 'ok').map((raw, index) => (
      { ...raw, title: `Legit finding ${index + 1}`, description: `Legit ${index + 1}`, ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 5) }
    ));
    const result = await runFindingManagerForStep({
      contract: {
        ledgerPath: '.takt/findings/ledger.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'JSON.' },
      } as never,
      ledgerStore,
      optionsBuilder: {
        buildAgentOptions: () => ({}),
        resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
      } as never,
      stepExecutor: stepExecutor as never,
      cwd: FIXTURE_CWD,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
      stepIteration: 1,
      subResults: [
        {
          subStep: { kind: 'agent', name: 'good-review', persona: 'good', edit: false } as WorkflowStep,
          response: { status: 'done', content: '', structuredOutput: { rawFindings: okRaws } } as unknown as AgentResponse,
        },
        {
          subStep: { kind: 'agent', name: 'flood-review', persona: 'flood', edit: false } as WorkflowStep,
          // 単体では 64 件以下 × 3 リクエスト分…ではなく、単体上限は超えないが
          // 合算で 128 を超える 60 件 ×…を単純化して 130 件にする（per-reviewer
          // 64 上限も超えるため、この reviewer は確実に overflow）。
          response: { status: 'done', content: '', structuredOutput: { rawFindings: makeManyRaws(130, 'flood') } } as unknown as AgentResponse,
        },
      ],
      workflowName: 'peer-review',
      runId: 'run-2',
      callNamespace: '',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(result.status).toBe('updated');
    // 正常 reviewer の 3 件は confirmed finding として処理される。
    expect(ledger.findings.filter((finding) => finding.title.startsWith('Legit finding'))).toHaveLength(3);
    // flood reviewer は単一 overflow blocker のみ。
    const overflows = ledger.findings.filter((finding) => finding.provisional?.kind === 'reviewer-output-overflow');
    expect(overflows).toHaveLength(1);
    expect(ledger.findings.some((finding) => finding.title.startsWith('Flood finding'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ケース8: crash/replay
// ---------------------------------------------------------------------------
describe('ケース8: crash/replay（WAL 各段での停止と resume の冪等性）', () => {
  const AMBIGUOUS_FIELDS = {
    relation: 'persists' as const,
    targetFindingId: 'F-0001',
    title: 'Existing issue still present',
    description: 'Claims the resolved issue persists with different content.',
    severity: 'high' as const,
    familyTag: 'bug',
    location: 'src/a.ts:20',
  };
  const LINEAGE_KEY = computeLineageKey({
    targetFindingId: 'F-0001',
    location: AMBIGUOUS_FIELDS.location,
    title: AMBIGUOUS_FIELDS.title,
    familyTag: AMBIGUOUS_FIELDS.familyTag,
  });
  const EVIDENCE_HASH = computeRawEvidenceHash(AMBIGUOUS_FIELDS);
  const BASE_INTERPRETATION_KEY = computeBaseInterpretationKey({
    reviewerStableKey: REVIEWER_STABLE_KEY,
    lineageKey: LINEAGE_KEY,
    candidateEvidenceHash: EVIDENCE_HASH,
  });
  const INTERPRETATION_KEY = computeInterpretationAttemptKey(BASE_INTERPRETATION_KEY, 1);

  function resolvedTargetLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
    return makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
      ...overrides,
    });
  }

  it('started 保存直後に停止した run の resume は、旧 attempt を interrupted にして次 attempt を実行する', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'interpretation_started',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        promptPreconditions: [],
      }],
    }));
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([{
        decision: 'provisional',
        rawFindingId: rawId,
        proofId: '',
        targetFindingId: '',
        reason: 'Still ambiguous.',
      }]);
    });

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).toHaveBeenCalledOnce();
    const saved = harness.currentLedger();
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.interpretationEpochs).toBe(2);
    expect(saved.interpretations?.filter((record) => record.lineageKey === LINEAGE_KEY)).toHaveLength(2);
    expect(saved.interpretations?.[0]?.stage).toBe('interpretation_interrupted');
  });

  it('completed 保存後に停止した run の resume は、保存済み decision を再利用して manager を再呼び出さない', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'interpretation_completed',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        reservationToken: 'crashed-reservation',
        completedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:01.000Z' },
        validatedDecision: {
          decision: 'create_independent',
          rawFindingId: 'crashed-run:reviewers:1:arch-review:p-1',
        },
        promptPreconditions: [],
      }],
    }));

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    // 保存済み decision（create_independent）が適用され、独立 finding が1件立つ。
    const independent = saved.findings.filter((finding) => finding.title === 'Existing issue still present');
    expect(independent).toHaveLength(1);
    // WAL は ledger_applied へ進む。
    const record = saved.interpretations?.find((entry) => entry.interpretationKey === INTERPRETATION_KEY);
    expect(record?.stage).toBe('ledger_applied');
    expect(record?.applicationResult).toBe('created');
  });

  it('completed decision の live owner が commit するまで並列呼び出しは同じ decision を適用しない', async () => {
    let notifyCompleted!: () => void;
    let releaseOwner!: () => void;
    const completedSaved = new Promise<void>((resolve) => { notifyCompleted = resolve; });
    const ownerMayCommit = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let heldCompleted = false;
    const harness = makeHarness(resolvedTargetLedger(), undefined, async (saved) => {
      if (!heldCompleted && saved.interpretations?.some((record) => record.stage === 'interpretation_completed')) {
        heldCompleted = true;
        notifyCompleted();
        await ownerMayCommit;
      }
    });
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([{
        decision: 'create_independent',
        rawFindingId: rawId,
        proofId: '',
        targetFindingId: '',
        reason: '',
      }]);
    });

    const ownerRun = harness.run({ runId: 'owner-run', reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    await completedSaved;
    const contenderResult = await harness.run({
      runId: 'contender-run',
      reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW],
    });
    expect(contenderResult.ledger.interpretations?.[0]?.stage).toBe('interpretation_completed');

    releaseOwner();
    await ownerRun;

    const saved = harness.currentLedger();
    const claimFindings = saved.findings.filter((finding) => finding.title === AMBIGUOUS_PERSISTS_RAW.title);
    expect(claimFindings).toHaveLength(1);
    expect(claimFindings[0]?.provisional).toBeUndefined();
    expect(saved.findings.filter((finding) => (
      finding.status === 'open' && finding.provisional !== undefined
    ))).toHaveLength(0);
    expect(buildFindingsRuleContext(saved).provisional.count).toBe(0);
    expect(saved.rawFindings.some((raw) => raw.rawFindingId.startsWith('contender-run:'))).toBe(true);
    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(saved.interpretations?.[0]?.stage).toBe('ledger_applied');
  });

  it('ledger_applied 済みの解釈は no-op になり、finding ID の二重割当・rawFindingIds の二重追加が起きない', async () => {
    const applied = makeFinding({
      id: 'F-0002',
      title: 'Existing issue still present',
      location: 'src/a.ts:20',
      description: 'Claims the resolved issue persists with different content.',
      rawFindingIds: ['crashed-run:reviewers:1:arch-review:p-1'],
    });
    const harness = makeHarness(resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' }), applied],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        appliedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:02.000Z' },
        applicationResult: 'created',
        promptPreconditions: [],
      }],
    }));

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    // 同じ観測に対する finding が増殖せず、再来 raw は前回の着地先へ添付される
    // （codex B1: 完全 identity による一意再同定）。provisional も立たない。
    const sameTitle = saved.findings.filter((finding) => finding.title === 'Existing issue still present');
    expect(sameTitle).toHaveLength(1);
    expect(sameTitle[0]?.rawFindingIds.some((id) => id.startsWith('run-2:'))).toBe(true);
    expect(saved.findings.every((finding) => finding.provisional === undefined)).toBe(true);
  });

  it('applied（provisional_created）後の同一 raw 再来は次 attempt を実行し、既存 provisional を更新する', async () => {
    const provisionalStableKey = computeProvisionalStableKey({
      reviewerStableKey: REVIEWER_STABLE_KEY,
      lineageKey: LINEAGE_KEY,
      provisionalKind: 'raw-meaning-ambiguous',
    });
    const existingProvisional = makeFinding({
      id: 'F-0002',
      title: 'Existing issue still present',
      location: 'src/a.ts:20',
      description: 'Claims the resolved issue persists with different content.',
      rawFindingIds: ['crashed-run:reviewers:1:arch-review:p-1'],
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: provisionalStableKey,
        lineageKey: LINEAGE_KEY,
        sourceRawFindingIds: ['crashed-run:reviewers:1:arch-review:p-1'],
        reason: 'Cannot determine.',
        firstObservedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        lastObservedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        interpretationEpochs: 1,
        gateEffect: 'block',
        recoveryReviewerStableKey: REVIEWER_STABLE_KEY,
      },
    });
    const harness = makeHarness(resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' }), existingProvisional],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        appliedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:02.000Z' },
        applicationResult: 'provisional_created',
        promptPreconditions: [],
      }],
    }));
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([{
        decision: 'provisional',
        rawFindingId: rawId,
        proofId: '',
        targetFindingId: '',
        reason: 'Still ambiguous.',
      }]);
    });

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).toHaveBeenCalledOnce();
    const saved = harness.currentLedger();
    const provisionals = saved.findings.filter((finding) => finding.provisional !== undefined);
    // F-0002 と F-0003 の併存（実測された増殖）が起きない。
    expect(provisionals).toHaveLength(1);
    expect(provisionals[0]?.id).toBe('F-0002');
    expect(provisionals[0]?.rawFindingIds.some((id) => id.startsWith('run-2:'))).toBe(true);
    expect(saved.interpretations?.filter((record) => record.lineageKey === LINEAGE_KEY)).toHaveLength(2);
  });

  it('reviewer の再報告がない recovery item も provisional 適用後に attempt 1 から 2 へ進む', async () => {
    const sourceRawId = 'crashed-run:reviewers:1:arch-review:p-1';
    const sourceRaw: RawFinding = {
      rawFindingId: sourceRawId,
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: AMBIGUOUS_PERSISTS_RAW.familyTag,
      severity: AMBIGUOUS_PERSISTS_RAW.severity,
      title: AMBIGUOUS_PERSISTS_RAW.title,
      description: AMBIGUOUS_PERSISTS_RAW.description,
      relation: AMBIGUOUS_PERSISTS_RAW.relation,
      targetFindingId: AMBIGUOUS_PERSISTS_RAW.targetFindingId,
      location: AMBIGUOUS_PERSISTS_RAW.location,
    };
    const recovery = makeFinding({
      id: 'F-0002',
      title: `Pending interpretation: ${AMBIGUOUS_PERSISTS_RAW.title}`,
      location: AMBIGUOUS_PERSISTS_RAW.location,
      description: AMBIGUOUS_PERSISTS_RAW.description,
      rawFindingIds: [sourceRawId],
      provisional: {
        kind: 'manager-budget-exhausted',
        stableKey: computeProvisionalStableKey({
          reviewerStableKey: REVIEWER_STABLE_KEY,
          lineageKey: LINEAGE_KEY,
          provisionalKind: 'manager-budget-exhausted',
        }),
        lineageKey: LINEAGE_KEY,
        sourceRawFindingIds: [sourceRawId],
        reason: 'The prior run exhausted its interpretation budget.',
        firstObservedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        lastObservedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        interpretationEpochs: 1,
        gateEffect: 'block',
        recoveryReviewerStableKey: REVIEWER_STABLE_KEY,
      },
    });
    const harness = makeHarness(resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' }), recovery],
      rawFindings: [makeLedger().rawFindings[0]!, sourceRaw],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        appliedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:02.000Z' },
        applicationResult: 'provisional_created',
        promptPreconditions: [],
      }],
    }));
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([{
        decision: 'create_independent',
        rawFindingId: rawId,
        proofId: '',
        targetFindingId: '',
        reason: '',
      }]);
    });

    await harness.run({ runId: 'attempt-2', reviewerRawFindings: [] });

    const records = harness.currentLedger().interpretations?.filter((record) => (
      record.lineageKey === LINEAGE_KEY
    ));
    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(records?.map((record) => record.attemptOrdinal)).toEqual([1, 2]);
    expect(records?.map((record) => record.stage)).toEqual(['ledger_applied', 'ledger_applied']);
    expect(records?.map((record) => record.applicationResult)).toEqual(['provisional_created', 'provisional_updated']);
  });

  it('同じ confirmation の再適用は冪等（同じ evidence で resolved 済みなら二重 resolve にならない）', async () => {
    // 1回目: confirmation が F-0001 を resolve する。
    const harness = makeHarness(makeLedger());
    const confirmation = {
      rawFindingId: 'c-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed fixed',
      description: 'Verified the fix at src/a.ts:10.',
      suggestion: '',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
    };
    const first = await harness.run({ reviewerRawFindings: [confirmation], runId: 'run-2' });
    expect(first.ledger.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
    const revisionAfterFirst = first.ledger.findings.find((finding) => finding.id === 'F-0001')?.revision;

    // 2回目（replay）: 同じ confirmation。fresh target は既に resolved（同じ evidence）
    // → 冪等成功として黙って外れ、二重 resolve（revision 二重加算）は起きない。
    // 対象が resolved の confirmation は intake で ambiguous になるため、解釈
    // フェーズが1回走る（提案は provisional）。
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'c-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Already resolved.' },
      ]);
    });
    const second = await harness.run({ reviewerRawFindings: [confirmation], runId: 'run-3' });
    const target = second.ledger.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('resolved');
    expect(target?.revision).toBe(revisionAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 追加必須テスト（設計書 §13）
// ---------------------------------------------------------------------------
describe('v2 追加必須テスト', () => {

  it('correction で relation が整っても taint（priorAmbiguityCodes）は残る', () => {
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-fixed',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue still present',
      location: 'src/a.ts:20',
      description: 'Still broken.',
      suggestion: '',
      relation: 'persists',
      targetFindingId: 'F-0001',
    }], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-x',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch',
    });
    const { outcome, canonical } = canonicalizeReviewerRawFinding(candidate!, {
      ledger: makeLedger(),
      clarificationAttempted: true,
      priorAmbiguityCodes: ['new-collides-open-finding'],
    });
    // 形式は coherent（open target への persists）だが taint は消えない。
    expect(outcome).toBe('coherent');
    expect(canonical.provenance.ambiguityOrigin).toBe(true);
    expect(canonical.provenance.clarificationAttempted).toBe(true);
    expect(canonical.provenance.ambiguityCodes).toContain('new-collides-open-finding');
  });

  it('deterministic SameProof は revision が stale なら不採用になる', () => {
    const ledger = makeLedger();
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-dup',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue',
      location: 'src/a.ts:10',
      description: 'Existing issue body.',
      suggestion: '',
      relation: 'new',
      targetFindingId: 'F-0001',
    }], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-x',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch',
    });
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger });
    const proofs = issueDeterministicSameProofs({ ledger, ambiguousRawFindings: [canonical] });
    const proof = proofs.get(canonical.rawFindingId);
    expect(proof).toBeDefined();
    // 発行時 revision の台帳ではOK。
    expect(verifySameProofAgainstLedger(proof!, ledger).ok).toBe(true);
    // revision が進んだ台帳では stale として不採用。
    const bumped: FindingLedger = {
      ...ledger,
      findings: ledger.findings.map((finding) => ({ ...finding, revision: (finding.revision ?? 1) + 1 })),
    };
    const stale = verifySameProofAgainstLedger(proof!, bumped);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toContain('revision changed');
    }
  });

  it('ambiguous reopened は terminal target を直接 reopen できない（target 不変 + provisional）', async () => {
    const ledger = makeLedger({
      findings: [makeFinding({ status: 'invalidated', lifecycle: 'invalidated', revision: 2 })],
    });
    const harness = makeHarness(ledger);
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'r-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot verify reopen claim.' },
      ]);
    });

    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        title: 'Invalidated issue came back',
        description: 'The invalidated finding is real after all.',
        suggestion: '',
        relation: 'reopened',
        targetFindingId: 'F-0001',
      }],
    });

    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('invalidated');
    expect(target?.revision).toBe(2);
    expect(saved.findings.find((finding) => finding.provisional !== undefined)?.status).toBe('open');
  });

  it('clean な後続 raw だけが provisional を確定できる（clean new で confirmed へ昇格、新規 ID は増えない）', async () => {
    // round 1: ambiguous raw が provisional として着地する。
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'a-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Unclear.' },
      ]);
    });
    await harness.run({
      runId: 'run-2',
      reviewerRawFindings: [{
        rawFindingId: 'a-1',
        familyTag: 'bug',
        title: 'Suspicious behaviour in parser',
        description: 'Something is off.',
        suggestion: '',
        relation: 'new',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7),
      }],
    });
    const afterRound1 = harness.currentLedger();
    const provisionalId = afterRound1.findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 同じ claim（path+title）の clean new が届く → 新規 finding を作らず
    // provisional を confirmed へ昇格（metadata が外れる）。
    executeAgentMock.mockReset();
    executeAgentMock.mockResolvedValue({
      persona: 'findings-manager',
      status: 'done',
      content: '',
      structuredOutput: (() => ({
        rawDecisions: [],
        disputeDecisions: [],
        conflictDecisions: [],
        invalidateDecisions: [],
        duplicateDecisions: [],
        dismissDecisions: [],
      }))(),
      timestamp: new Date(),
    } as unknown as AgentResponse);
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:clean-1)"/g)].map((match) => match[1]!);
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({ rawFindingId, decision: 'new', findingId: '', evidence: 'fresh observation' })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });
    await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        rawFindingId: 'clean-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        description: 'Confirmed: the parser drops trailing tokens.',
        suggestion: 'Fix the tokenizer.',
        relation: 'new',
        targetFindingId: '',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 9),
      }],
    });

    const afterRound2 = harness.currentLedger();
    const settled = afterRound2.findings.find((finding) => finding.id === provisionalId);
    // 同じ ID のまま confirmed へ昇格し、provisional metadata が外れている。
    expect(settled?.status).toBe('open');
    expect(settled?.provisional).toBeUndefined();
    // 新規 finding は増えていない（claim が同じなら1件のまま）。
    expect(afterRound2.findings.filter((finding) => finding.title === 'Suspicious behaviour in parser')).toHaveLength(1);
  });

  it('B2 誤確定の拒否: path+title が同じでも description / familyTag が異なる clean new は provisional を昇格させない', async () => {
    // round 1: ambiguous raw → provisional。
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'a-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Unclear.' },
      ]);
    });
    await harness.run({
      runId: 'run-2',
      reviewerRawFindings: [{
        rawFindingId: 'a-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        description: 'Something is off.',
        suggestion: '',
        relation: 'new',
        targetFindingId: 'F-9999',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7),
      }],
    });
    const provisionalId = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 同 path+title だが description も familyTag も異なる clean new
    // （= 完全 identity 不一致・claim lineage 不一致 → 別問題の可能性）。
    executeAgentMock.mockReset();
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:other-1)"/g)].map((match) => match[1]!);
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({ rawFindingId, decision: 'new', findingId: '', evidence: 'fresh' })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });
    await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        rawFindingId: 'other-1',
        familyTag: 'perf',
        severity: 'medium',
        title: 'Suspicious behaviour in parser',
        description: 'A totally different failure mode: quadratic scan on large inputs.',
        suggestion: '',
        relation: 'new',
        targetFindingId: '',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 9),
      }],
    });

    const saved = harness.currentLedger();
    // provisional は昇格せず開いたまま。
    const provisional = saved.findings.find((finding) => finding.id === provisionalId);
    expect(provisional?.provisional).toMatchObject({ kind: 'raw-meaning-ambiguous' });
    // clean new は独立した確定 finding として立つ（誤統合しない）。
    const independent = saved.findings.find(
      (finding) => finding.id !== provisionalId && finding.title === 'Suspicious behaviour in parser',
    );
    expect(independent?.status).toBe('open');
    expect(independent?.provisional).toBeUndefined();
  });

  it('B2 昇格: 完全 identity の clean raw が provisional 自身へ match すると metadata が外れて通常 open へ昇格する（永久 provisional の防止）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'a-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Unclear.' },
      ]);
    });
    const observation = {
      rawFindingId: 'a-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Suspicious behaviour in parser',
      description: 'Something is off.',
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
      ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7),
    };
    // round 1: relation/target 矛盾で ambiguous → provisional。
    await harness.run({
      runId: 'run-2',
      reviewerRawFindings: [{ ...observation, targetFindingId: 'F-9999' }],
    });
    const provisionalId = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 完全に同一内容の clean raw → 機械分類の
    // exact-duplicate match が provisional 自身に付く → 昇格。
    executeAgentMock.mockReset();
    await harness.run({ runId: 'run-3', reviewerRawFindings: [observation] });
    // 完全一致は機械処理されるため manager は呼ばれない。
    expect(executeAgentMock).not.toHaveBeenCalled();

    const saved = harness.currentLedger();
    const settled = saved.findings.find((finding) => finding.id === provisionalId);
    expect(settled?.status).toBe('open');
    expect(settled?.provisional).toBeUndefined();
    expect(settled?.rawFindingIds.some((id) => id.startsWith('run-3:'))).toBe(true);
    // 新規 finding は増えない。
    expect(saved.findings.filter((finding) => finding.title === 'Suspicious behaviour in parser')).toHaveLength(1);
  });

  it('B2 解消の拒否: manager の意味判断 match は provisional の解消根拠にならない', async () => {
    // 台帳: 別内容の open target T（F-0001）+ provisional P（claim A）。
    const target = makeFinding({
      id: 'F-0001',
      title: 'Different tracked issue',
      location: 'src/a.ts:10',
      description: 'A tracked problem with different content.',
    });
    const provisionalStableKey = 'sk-manual';
    const provisionalEntry = makeFinding({
      id: 'F-0002',
      title: 'Suspicious behaviour in parser',
      location: 'src/b.ts:7',
      description: 'Something is off.',
      rawFindingIds: ['old:reviewers:1:arch-review:a-1'],
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: provisionalStableKey,
        lineageKey: 'lk-manual',
        sourceRawFindingIds: ['old:reviewers:1:arch-review:a-1'],
        reason: 'Unclear.',
        firstObservedAt: { runId: 'old', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastObservedAt: { runId: 'old', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        interpretationEpochs: 1,
        gateEffect: 'block',
      },
    });
    const harness = makeHarness(makeLedger({ nextId: 3, findings: [target, provisionalEntry] }));
    // clean raw（P と同一 identity）を manager が意味判断で T へ same にする。
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:a-2)"/g)].map((match) => match[1]!);
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => (
            { rawFindingId, decision: 'same', findingId: 'F-0001', evidence: 'Semantically the same underlying bug.' }
          )),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });
    await harness.run({
      runId: 'run-4',
      reviewerRawFindings: [{
        rawFindingId: 'a-2',
        familyTag: 'bug',
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        location: 'src/b.ts:8',
        description: 'Something is off.',
        suggestion: '',
        relation: 'new',
        targetFindingId: '',
      }],
    });

    const saved = harness.currentLedger();
    // T は match で証拠を得るが、P は resolved にならない（T 側に完全 identity が
    // 無い = 意味判断 match は決定的根拠ではない）。
    const provisional = saved.findings.find((finding) => finding.id === 'F-0002');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional).toBeDefined();
  });

  it('正規化監査: 矛盾 relation の raw を intake すると、wire は new + targetFindingId なしに正規化されつつ、監査メタデータから元の主張が復元できる', async () => {
    const harness = makeHarness(makeLedger());
    // 解釈フェーズは provisional 提案で流す（この試験の主眼は監査メタデータ）。
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'x-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Unclear.' },
      ]);
    });

    // レビュアの矛盾主張: relation "new" なのに targetFindingId を書いてくる。
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'x-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Contradictory claim',
        location: 'src/b.ts:5',
        description: 'Claims to be new but names an existing target.',
        suggestion: '',
        relation: 'new',
        targetFindingId: 'F-0001',
      }],
    });
    expect(result.status).toBe('updated');

    // wire（台帳の rawFindings）は正規化後の整合ペアだけを持つ:
    // relation は new、targetFindingId は除外されている。identity 構成
    // フィールド（title/description/location）は元のまま（注記で汚さない）。
    const saved = harness.currentLedger();
    const wire = saved.rawFindings.find((raw) => raw.rawFindingId.endsWith(':x-1'));
    expect(wire?.relation).toBe('new');
    expect(wire?.targetFindingId).toBeUndefined();
    expect(wire?.description).toBe('Claims to be new but names an existing target.');

    // 監査メタデータ（検証レポートの rawNormalizations）から元の主張が復元できる。
    const report = harness.savedReports.at(-1)!;
    const record = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':x-1'));
    expect(record).toBeDefined();
    expect(record?.claimedRelation).toBe('new');
    expect(record?.claimedTargetFindingId).toBe('F-0001');
    expect(record?.normalizedRelation).toBe('new');
    expect(record?.wireTargetFindingId).toBeUndefined();
    expect(record?.ambiguityCodes).toContain('relation-target-mismatch');
    expect(record?.normalizations).toContain('target-dropped-from-wire');
  });

  it('正規化監査の write-ahead: intake 後の処理（updateLedger）が例外を投げても、元の主張はディスクの検証レポートから復元できる', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-wal-audit-project-'));
    const reportDir = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-wal-audit-report-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
      execFileSync('git', ['init', '--quiet'], { cwd: projectCwd });
      writeFileSync(join(projectCwd, '.gitignore'), '.takt/\n');
      execFileSync('git', ['add', 'src/b.ts', '.gitignore'], { cwd: projectCwd });
      execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: projectCwd });

      const realStore = createFindingLedgerStore({
        projectCwd,
        reportDir,
        workflowName: 'peer-review',
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
      });
      realStore.saveLedger({
        version: 1,
        workflowName: 'peer-review',
        nextId: 2,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [makeFinding()],
        rawFindings: [],
        conflicts: [],
      });
      // intake 後の最初の永続化処理（WAL の beginInterpretations / 最終
      // updateLedger）で必ず例外が起きるストア。
      const crashingStore: FindingLedgerStore = {
        ...realStore,
        updateLedger: () => Promise.reject(new Error('simulated crash after intake')),
      };

      await expect(runFindingManagerForStep({
        contract: {
          ledgerPath: '.takt/findings/peer-review.json',
          rawFindingsPath: '.takt/findings/raw',
          manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'JSON.' },
        } as never,
        ledgerStore: crashingStore,
        optionsBuilder: {
          buildAgentOptions: () => ({}),
          resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
        } as never,
        stepExecutor: {
          buildPhase1Instruction: (instruction: string) => instruction,
          recordSynthesizedAgentUsage: () => {},
          normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
        } as never,
        cwd: projectCwd,
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
        stepIteration: 1,
        subResults: [{
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: {
              rawFindings: [{
                // 矛盾主張: relation new + targetFindingId（正規化対象）。
                rawFindingId: 'x-1',
                familyTag: 'bug',
                severity: 'high',
                title: 'Contradictory claim',
                location: 'src/b.ts:5',
                description: 'Claims to be new but names an existing target.',
                suggestion: '',
                relation: 'new',
                targetFindingId: 'F-0001',
              }],
            },
          } as unknown as AgentResponse,
        }],
        workflowName: 'peer-review',
        runId: 'crash-run',
        callNamespace: '',
        timestamp: '2026-06-14T00:00:00.000Z',
      })).rejects.toThrow('simulated crash after intake');

      // 例外にもかかわらず、write-ahead 保存された検証レポートがディスクに在り、
      // 正規化前の元の主張が復元できる。
      const reportPath = join(reportDir, 'findings-manager-validation.reviewers.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
        ledgerUpdated: boolean;
        rawNormalizations?: Array<{
          rawFindingId: string;
          claimedRelation?: string;
          claimedTargetFindingId?: string;
          ambiguityCodes: string[];
          normalizations: string[];
        }>;
      };
      expect(report.ledgerUpdated).toBe(false);
      const record = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':x-1'));
      expect(record?.claimedRelation).toBe('new');
      expect(record?.claimedTargetFindingId).toBe('F-0001');
      expect(record?.ambiguityCodes).toContain('relation-target-mismatch');
      expect(record?.normalizations).toContain('target-dropped-from-wire');
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('A-1: clean な confirmation の location 不成立も従来どおり監査保存のみ（clean/tainted で同一規則）', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'c-clean-bad',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        location: 'src/does-not-exist.ts:9',
        description: 'Verified the fix at a hallucinated location.',
        suggestion: '',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.findings.every((finding) => finding.provisional === undefined)).toBe(true);
    expect(saved.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('open');
    expect(harness.savedReports.at(-1)!.rawAdmissionRejections?.some((entry) => entry.rawFindingId.endsWith(':c-clean-bad'))).toBe(true);
  });

  it('A-3 完全版（codex ブロッカー2）: 同一ラウンドの confirmation が target を閉じた場合、証跡不成立 persists は resolved target へ添付されず provisional にフォールバックする（gate 非減少）', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [
        {
          // 有効な confirmation（機械分類で F-0001 を resolve する）。
          rawFindingId: 'c-ok',
          familyTag: 'bug',
          severity: 'high',
          title: 'Confirmed fixed',
          description: 'Verified the fix at src/a.ts:10.',
          suggestion: '',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
        },
        {
          // 証跡不成立（存在しない path）の persists。prompt 時点では F-0001 は
          // open なので A-3 の添付候補になるが、reconcile が F-0001 を閉じる。
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          location: 'src/does-not-exist.ts:5',
          description: 'Still observing it (bad evidence).',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
        },
      ],
    });
    expect(result.status).toBe('updated');

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // confirmation は正当に適用される。
    expect(target.status).toBe('resolved');
    // 旧実装の欠陥: resolved target へ rejected observation が添付され着地
    // 0件（既存 blocker 消失 + 代替 blocker なし = gate 減少）。修正後は添付せず
    // reviewer anomaly（review-integrity 側の二系統台帳、codex 対策#4）へ
    // フォールバックする — findings 配列を一切汚さず、観測は消えない。
    expect(target.rejectedObservations ?? []).toEqual([]);
    expect(saved.findings.some((finding) => finding.provisional !== undefined)).toBe(false);
    const anomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-bad')));
    expect(anomaly?.kind).toBe('quote-mismatch');
    expect(anomaly?.promotedFindingId).toBeUndefined();
    // 監査にも着地が残る。
    expect(harness.savedReports.at(-1)!.reviewerAnomalyLandings?.some((landing) => (
      landing.sourceRawFindingIds.some((id) => id.endsWith(':p-bad'))
    ))).toBe(true);
  });

  it('A-2: 行範囲 / N-A / 空 / カンマ区切りの4象限が admission で機械正規化され、適用事実が rawNormalizations に記録される', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:(?:r-range|r-na|r-empty))"/g)].map((match) => match[1]!);
      return {
        persona: 'findings-manager',
        status: 'done',
        content: '',
        structuredOutput: {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({ rawFindingId, decision: 'new', findingId: '', evidence: 'fresh' })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });
    const base = {
      familyTag: 'bug',
      severity: 'medium' as const,
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
    };
    const result = await harness.run({
      reviewerRawFindings: [
        // 行範囲は正規化されても、admission は typed evidence protocol
        // （codex 対策#4）の対象 — verbatimExcerpt が実ファイル内容と一致して
        // 初めて finding として立つ（正規化 + 照合の両方が効く happy path）。
        { ...base, rawFindingId: 'r-range', title: 'Range location issue', description: 'Cited with a line range.', ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 5, 9) },
        // N/A・空の locationless finding は、明示的な evidenceKind:'locationless'
        // を宣言してはじめて admissible（codex 検証ブロッカー#2 — 空/N-A の暗黙
        // admit は廃止。宣言なしの bare N-A/空は下の r-na-bare のとおり anomaly）。
        { ...base, rawFindingId: 'r-na', title: 'No-location issue', location: ' N/A ', description: 'Architectural observation.', evidenceKind: 'locationless', verbatimExcerpt: '', snapshotId: '' },
        { ...base, rawFindingId: 'r-empty', title: 'Empty-location issue', location: '', description: 'Another locationless observation.', evidenceKind: 'locationless', verbatimExcerpt: '', snapshotId: '' },
        // 明示宣言の無い bare N-A（fresh claim）は証跡不成立 → reviewer anomaly。
        { ...base, rawFindingId: 'r-na-bare', title: 'Bare N-A issue', location: 'N/A', description: 'Locationless but undeclared.' },
        // カンマ区切りは正規化しない上、typed evidence も無い → 証跡不成立。
        { ...base, rawFindingId: 'r-multi', title: 'Multi location issue', location: 'src/a.ts:5, src/b.ts:9', description: 'Ambiguous multi-location citation.' },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // 行範囲の source_quote は確定する。一方、明示 locationless は raw と説明を
    // 保持した gate-blocking provisional であり、confirmed finding にはならない。
    const rangeFinding = saved.findings.find((finding) => finding.title === 'Range location issue');
    expect(rangeFinding?.status).toBe('open');
    expect(rangeFinding?.provisional).toBeUndefined();
    for (const title of ['No-location issue', 'Empty-location issue']) {
      const landed = saved.findings.find((finding) => finding.title === title);
      expect(landed?.status).toBe('open');
      expect(landed?.provisional?.kind).toBe('unverified-locationless');
      expect(landed?.description).toBe(title === 'No-location issue' ? 'Architectural observation.' : 'Another locationless observation.');
    }
    // カンマ区切りと bare N-A（locationless 宣言なし）は証跡不成立 → reviewer
    // anomaly（review-integrity 側）へ隔離され、product finding にはならない
    // （product gate も塞がない。codex 検証ブロッカー#2）。
    expect(saved.findings.some((finding) => finding.title === 'Multi location issue')).toBe(false);
    expect(saved.findings.some((finding) => finding.title === 'Bare N-A issue')).toBe(false);
    const multiAnomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':r-multi')));
    expect(multiAnomaly?.kind).toBe('quote-mismatch');
    const bareNaAnomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':r-na-bare')));
    expect(bareNaAnomaly?.kind).toBe('quote-mismatch');
    // 正規化の適用事実が rawNormalizations に記録される（無変換の r-empty は記録なし）。
    const report = harness.savedReports.at(-1)!;
    const rangeRecord = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':r-range'));
    expect(rangeRecord?.normalizations).toContain('location-line-range-interpreted');
    const naRecord = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':r-na'));
    expect(naRecord?.normalizations).toContain('location-not-applicable');
    expect(report.rawNormalizations?.some((entry) => entry.rawFindingId.endsWith(':r-empty'))).toBe(false);
  });

  it('A-3: 証跡不成立 persists の着地4分岐（open target 添付 / provisional target 添付 / terminal target provisional / 不明 target provisional）', async () => {
    // 台帳: open F-0001、provisional F-0002、resolved F-0003。
    const provisionalEntry = makeFinding({
      id: 'F-0002',
      title: 'Provisional observation',
      location: 'src/b.ts:5',
      description: 'Unclear claim.',
      rawFindingIds: ['old:reviewers:1:arch-review:p-old'],
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: 'sk-a3',
        lineageKey: 'lk-a3',
        sourceRawFindingIds: ['old:reviewers:1:arch-review:p-old'],
        reason: 'Unclear.',
        firstObservedAt: { runId: 'old', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastObservedAt: { runId: 'old', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        interpretationEpochs: 1,
        gateEffect: 'block',
      },
    });
    const resolvedEntry = makeFinding({
      id: 'F-0003',
      title: 'Fixed one',
      location: 'src/a.ts:30',
      description: 'Already fixed.',
      status: 'resolved',
      lifecycle: 'resolved',
    });
    const harness = makeHarness(makeLedger({
      nextId: 4,
      findings: [makeFinding(), provisionalEntry, resolvedEntry],
    }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      // terminal / unknown target の persists は tainted → 解釈フェーズ。
      const text = instruction as string;
      const ids = [...text.matchAll(/"rawFindingId":\s*"([^"]+:(?:p-terminal|p-unknown))"/g)].map((match) => match[1]!);
      return interpretationResponse([...new Set(ids)].map((rawFindingId) => (
        { decision: 'provisional', rawFindingId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }
      )));
    });
    const base = {
      familyTag: 'bug',
      severity: 'high' as const,
      suggestion: '',
      relation: 'persists',
      location: 'src/does-not-exist.ts:1',
    };
    const result = await harness.run({
      reviewerRawFindings: [
        { ...base, rawFindingId: 'p-open', title: 'Existing issue', description: 'Still there (bad evidence).', targetFindingId: 'F-0001' },
        { ...base, rawFindingId: 'p-prov', title: 'Provisional observation', description: 'Still there too (bad evidence).', targetFindingId: 'F-0002' },
        { ...base, rawFindingId: 'p-terminal', title: 'Fixed one', description: 'Came back (bad evidence).', targetFindingId: 'F-0003' },
        { ...base, rawFindingId: 'p-unknown', title: 'Ghost issue', description: 'References nothing real.', targetFindingId: 'F-9999' },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();

    // 1) open target: 監査添付のみ。canonical evidence / revision / status 不変。
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    expect(target.status).toBe('open');
    expect(target.revision).toBe(1);
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    expect(target.rejectedObservations?.some((entry) => entry.rawFindingId.endsWith(':p-open'))).toBe(true);

    // 2) provisional target: その観測履歴へ添付。新規 blocker は増えない。
    const provisionalTarget = saved.findings.find((finding) => finding.id === 'F-0002')!;
    expect(provisionalTarget.rejectedObservations?.some((entry) => entry.rawFindingId.endsWith(':p-prov'))).toBe(true);

    // 3)/4) terminal / 不明 target: attach 先が無いので独立の着地が要る。codex
    // 対策#4 以降はこれも product gate を塞ぐ provisional ではなく、
    // review-integrity 側の reviewer anomaly（quote-mismatch）— 観測は消えず
    // 監査に残るが、証跡不成立というだけで欠陥主張の真偽は証明しないため product
    // finding は増やさない。
    expect(saved.findings.some((finding) => finding.provisional !== undefined && finding.id !== 'F-0002')).toBe(false);
    const terminalAnomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-terminal')));
    const unknownAnomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-unknown')));
    expect(terminalAnomaly?.kind).toBe('quote-mismatch');
    expect(unknownAnomaly?.kind).toBe('quote-mismatch');
    // resolved target はそのまま（terminal 分の観測は F-0003 を汚染しない）。
    const terminalTarget = saved.findings.find((finding) => finding.id === 'F-0003')!;
    expect(terminalTarget.status).toBe('resolved');
    expect(terminalTarget.rejectedObservations ?? []).toEqual([]);

    // product gate: F-0001 open + F-0002 provisional の2件だけが塞ぐ。
    // terminal/不明分は anomaly 隔離により product gate を追加で塞がない
    // （codex 対策#4 の gate 分離— 旧来の「証跡不成立は常に gate を塞ぐ」から、
    // 「製品欠陥ゲートは検証済み証跡だけで決まる」への意図的な変更）。
    const provisionalCount = saved.findings.filter((finding) => finding.status === 'open' && finding.provisional !== undefined).length;
    expect(provisionalCount).toBe(1); // F-0002 のみ
  });

  it('B4: interpretation の structured output はスキーマ構造で出力サイズが有界（maxItems 16 / フィールド maxLength）', () => {
    const schema = AmbiguousInterpretationsOutputJsonSchema as {
      properties: {
        interpretations: {
          maxItems: number;
          items: { properties: Record<string, { maxLength?: number }> };
        };
      };
    };
    expect(schema.properties.interpretations.maxItems).toBe(16);
    expect(schema.properties.interpretations.items.properties.rawFindingId?.maxLength).toBe(512);
    expect(schema.properties.interpretations.items.properties.proofId?.maxLength).toBe(128);
    expect(schema.properties.interpretations.items.properties.targetFindingId?.maxLength).toBe(128);
    expect(schema.properties.interpretations.items.properties.reason?.maxLength).toBe(2048);
  });

  it('並列 workflow_call の同時実行でも stable key と WAL が衝突せず lost update が起きない', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-parallel-project-'));
    const reportDir = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-parallel-report-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/a.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
      execFileSync('git', ['init', '--quiet'], { cwd: projectCwd });
      writeFileSync(join(projectCwd, '.gitignore'), '.takt/\n');
      execFileSync('git', ['add', 'src/a.ts', '.gitignore'], { cwd: projectCwd });
      execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: projectCwd });

      const store = createFindingLedgerStore({
        projectCwd,
        reportDir,
        workflowName: 'peer-review',
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
      });
      store.saveLedger({
        version: 1,
        workflowName: 'peer-review',
        nextId: 2,
        updatedAt: '2026-06-13T00:00:00.000Z',
        findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
        rawFindings: [],
        conflicts: [],
      });

      executeAgentMock.mockImplementation(async (_persona, instruction) => {
        const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return interpretationResponse([
          { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' },
        ]);
      });

      const runCall = (callNamespace: string, title: string) => runFindingManagerForStep({
        contract: {
          ledgerPath: '.takt/findings/peer-review.json',
          rawFindingsPath: '.takt/findings/raw',
          manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'JSON.' },
        } as never,
        ledgerStore: store,
        optionsBuilder: {
          buildAgentOptions: () => ({}),
          resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
        } as never,
        stepExecutor: {
          buildPhase1Instruction: (instruction: string) => instruction,
          recordSynthesizedAgentUsage: () => {},
          normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
        } as never,
        cwd: projectCwd,
        parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
        stepIteration: 1,
        subResults: [{
          subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
          response: {
            status: 'done',
            content: '',
            structuredOutput: {
              rawFindings: [{
                ...AMBIGUOUS_PERSISTS_RAW,
                title,
                ...verifiedSourceQuoteFields(projectCwd, 'src/a.ts', 20),
              }],
            },
          } as unknown as AgentResponse,
        }],
        workflowName: 'peer-review',
        runId: 'shared-run',
        callNamespace,
        timestamp: '2026-06-14T00:00:00.000Z',
      });

      const [resultA, resultB] = await Promise.all([
        runCall('child-a', 'Ambiguous claim from child A'),
        runCall('child-b', 'Ambiguous claim from child B'),
      ]);
      expect(resultA.status).toBe('updated');
      expect(resultB.status).toBe('updated');

      const finalLedger = store.loadLedger();
      // 両方の provisional が残る（lost update なし）。
      expect(finalLedger.findings.some((finding) => finding.title === 'Ambiguous claim from child A' && finding.provisional !== undefined)).toBe(true);
      expect(finalLedger.findings.some((finding) => finding.title === 'Ambiguous claim from child B' && finding.provisional !== undefined)).toBe(true);
      // finding id の重複割当なし。
      const ids = finalLedger.findings.map((finding) => finding.id);
      expect(new Set(ids).size).toBe(ids.length);
      // WAL レコードも両方残り、interpretationKey は衝突しない
      // （lineage は title 依存、reviewer stable key は同一でも evidence が異なる）。
      const keys = (finalLedger.interpretations ?? []).map((record) => record.interpretationKey);
      expect(keys.length).toBe(2);
      expect(new Set(keys).size).toBe(2);
      expect((finalLedger.interpretations ?? []).every((record) => record.stage === 'ledger_applied')).toBe(true);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('findings.open.count と findings.provisional.count の双方が正しい（provisional は open にも数えられる）', () => {
    const ledger = makeLedger({
      findings: [
        makeFinding(),
        makeFinding({
          id: 'F-0002',
          title: 'Provisional observation',
          location: 'src/b.ts:5',
          provisional: {
            kind: 'raw-meaning-ambiguous',
            stableKey: 'sk',
            lineageKey: 'lk',
            sourceRawFindingIds: ['raw-x'],
            reason: 'Cannot determine meaning',
            firstObservedAt: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-06-14T00:00:00.000Z' },
            lastObservedAt: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-06-14T00:00:00.000Z' },
            interpretationEpochs: 1,
            gateEffect: 'block',
          },
        }),
      ],
    });
    const context = buildFindingsRuleContext(ledger);
    expect(context.open.count).toBe(2);
    expect(context.provisional.count).toBe(1);
    expect(context.provisional.items[0]).toMatchObject({ id: 'F-0002', kind: 'raw-meaning-ambiguous' });
  });
});

// ---------------------------------------------------------------------------
// ケース9: fixpoint 悪用（対策バッチ B1 — 意図的な provisional 固定による
// 早期停止の悪用）
// ---------------------------------------------------------------------------
describe('ケース9: fixpoint 悪用（意図的に provisional を固定して早期停止させ、その隙に何かを通そうとする試み）', () => {
  it('fixpoint に達しても provisional は open かつ gate-blocking のまま残り、COMPLETE 不変条件（open.count == 0）は独立して働き続ける', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    // location 付きの主張は typed evidence protocol（codex 対策#4）の admission
    // gate にかかり anomaly へ隔離される（fixpoint/provisional の対象外になる）
    // ため、fixpoint の起点には構造的に曖昧な persists（location なし・target
    // 不明）を使う。
    const ambiguous = (rawFindingId: string) => ({
      rawFindingId,
      familyTag: 'bug',
      severity: 'high',
      title: 'Re-report of a finding that was never actually opened',
      description: 'Claims to persist a finding id the ledger has never seen.',
      suggestion: '',
      relation: 'persists',
      targetFindingId: 'F-9001',
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['raw-1', 'raw-2', 'raw-3'],
      );
      return interpretationResponse([{ decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }]);
    });

    // 同一観測でも recovery attempt は省略できないため、固定化の悪用は
    // interpretation 上限へ達した後にだけ fixpoint となる。
    await harness.run({ reviewerRawFindings: [ambiguous('raw-1')] });
    await harness.run({ reviewerRawFindings: [ambiguous('raw-2')] });
    await harness.run({ reviewerRawFindings: [ambiguous('raw-3')] });

    const ledger = harness.currentLedger();
    expect(ledger.fixpoint?.reached).toBe(true);

    // fixpoint 到達は「plan への差し戻しをやめて NEEDS_ADJUDICATION へ回す」
    // という workflow のルーティング判断材料になるだけで、台帳側の finding
    // そのものには一切影響しない — resolve/waive/invalidate のいずれにも
    // ならず、open のまま gate-blocking であり続ける。
    const provisional = ledger.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.status).toBe('open');
    // 'persists' は「同じ観測が繰り返された」ことを表す非終端 lifecycle。
    // resolved/waived/invalidated/superseded/reopened のいずれにもなっていない
    // ことが不変条件 — fixpoint 到達がこれらへ勝手に遷移させないことを見る。
    expect(['new', 'persists']).toContain(provisional?.lifecycle);
    expect(provisional?.provisional?.gateEffect).toBe('block');
    expect(provisional?.resolvedAt).toBeUndefined();
    expect(provisional?.waivers).toBeUndefined();
    expect(provisional?.invalidatedAt).toBeUndefined();

    // COMPLETE 不変条件（WorkflowEngine.checkCompletionGate 相当）が見る
    // findings.open.count == 0 は、fixpoint の有無と無関係に false のまま。
    const context = buildFindingsRuleContext(ledger);
    expect(context.open.count).toBeGreaterThan(0);
    expect(context.provisional.count).toBeGreaterThan(0);
  });

  it('fixpoint 到達後にさらに同一の偽装観測を繰り返しても、新しい finding が増殖したり既存 finding の状態が動いたりしない（何も「通らない」）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    // ケース9 の1件目と同じ理由で、location hallucination ではなく構造的に
    // 曖昧な persists を fixpoint の起点に使う（codex 対策#4）。
    const ambiguous = (rawFindingId: string) => ({
      rawFindingId,
      familyTag: 'bug',
      severity: 'high',
      title: 'Re-report of a finding that was never actually opened',
      description: 'Claims to persist a finding id the ledger has never seen.',
      suggestion: '',
      relation: 'persists',
      targetFindingId: 'F-9001',
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['raw-1', 'raw-2', 'raw-3', 'raw-4'],
      );
      return interpretationResponse([{ decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }]);
    });

    await harness.run({ reviewerRawFindings: [ambiguous('raw-1')] });
    await harness.run({ reviewerRawFindings: [ambiguous('raw-2')] });
    await harness.run({ reviewerRawFindings: [ambiguous('raw-3')] });
    expect(harness.currentLedger().fixpoint?.reached).toBe(true);
    const findingCountAtFixpoint = harness.currentLedger().findings.length;

    // fixpoint 到達後もラウンドを止める権限は engine 側の rule 評価にしかない
    // （このユニットテストは manager-runner 単体の性質を見るため、workflow
    // ルーティングそのものは別テストで検証済み）。ここでは「fixpoint 到達済み」
    // という事実そのものが、後続ラウンドの台帳更新ロジックを緩めないことを見る。
    await harness.run({ reviewerRawFindings: [ambiguous('raw-4')] });

    const ledger = harness.currentLedger();
    // 同一 stableKey の観測が繰り返されただけで、finding は増殖しない。
    expect(ledger.findings.length).toBe(findingCountAtFixpoint);
    expect(ledger.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(1);
    // fixpoint 到達は継続する（何も新しい進展が無いため）が、それでも open のまま。
    expect(ledger.fixpoint?.reached).toBe(true);
    expect(ledger.findings[0]?.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// ケース10: stop-budget 悪用（有限停止予算; codex 裁定・対策バッチ B1 の
// 拡張。fixpoint を意図的に回避する churn を続けながら、budget 到達の隙に
// 何かを通そうとする、またはカウンタそのものを操作しようとする試み）
// ---------------------------------------------------------------------------
describe('ケース10: stop-budget 悪用（churn で fixpoint を回避しつつ budget 到達の隙を突く試み、およびカウンタ操作の試み）', () => {
  // location 付きの主張は typed evidence protocol（codex 対策#4）の admission
  // gate にかかり anomaly へ隔離される（budget/provisional の対象外になる）
  // ため、churn の各観測には構造的に曖昧な persists（location なし・target
  // 不明、n ごとに別 target で別 lineage）を使う。
  function churnRaw(n: number): Record<string, unknown> {
    return {
      rawFindingId: `raw-churn-${n}`,
      familyTag: 'bug',
      severity: 'high',
      title: `Re-report of fabricated finding ${n} that was never actually opened`,
      description: `Claims to persist finding id F-900${n}, which the ledger has never seen.`,
      suggestion: '',
      relation: 'persists',
      targetFindingId: `F-900${n}`,
    };
  }

  function mockChurnInterpretations(): void {
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:raw-churn-\d+)"/g)].map((match) => match[1]!);
      return interpretationResponse([...new Set(ids)].map((rawFindingId) => (
        { decision: 'provisional', rawFindingId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }
      )));
    });
  }

  it('budget が尽きても（fixpoint は churn のため決して成立しない）provisional は open かつ gate-blocking のまま残り、COMPLETE 不変条件（open.count == 0）は独立して働き続ける', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }), { maxRounds: 2 });
    mockChurnInterpretations();

    // 不正な入力元（または壊れたレビュアー）が毎ラウンド別の架空観測を送り、fixpoint
    // を意図的に回避しながら churn を続ける。各ラウンドは別 invocation
    // （別 runId）なのでマーカーが異なり、正しく別ラウンドとして計上される。
    await harness.run({ reviewerRawFindings: [churnRaw(1)], runId: 'run-churn-1' });
    await harness.run({ reviewerRawFindings: [churnRaw(2)], runId: 'run-churn-2' });

    const ledger = harness.currentLedger();
    // fixpoint は churn のため決して成立しない — budget が唯一の停止条件になる。
    expect(ledger.fixpoint?.reached).toBe(false);
    expect(ledger.stopBudget?.exhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(ledger)).toBe(2);

    // budget 到達は「plan への差し戻しをやめて NEEDS_ADJUDICATION へ回す」と
    // いう workflow のルーティング判断材料になるだけで、台帳側の finding
    // そのものには一切影響しない — resolve/waive/invalidate のいずれにも
    // ならず、open のまま gate-blocking であり続ける。
    const provisionals = ledger.findings.filter((finding) => finding.provisional !== undefined);
    expect(provisionals).toHaveLength(2);
    for (const provisional of provisionals) {
      expect(provisional.status).toBe('open');
      expect(provisional.provisional?.gateEffect).toBe('block');
      expect(provisional.resolvedAt).toBeUndefined();
      expect(provisional.waivers).toBeUndefined();
      expect(provisional.invalidatedAt).toBeUndefined();
    }

    // COMPLETE 不変条件（WorkflowEngine.checkCompletionGate 相当）が見る
    // findings.open.count == 0 は、budget 到達の有無と無関係に false のまま。
    const context = buildFindingsRuleContext(ledger);
    expect(context.open.count).toBeGreaterThan(0);
    expect(context.provisional.count).toBeGreaterThan(0);
    expect(context.rounds.budgetExhausted).toBe(true);
  });

  it('budget 到達後にさらに churn を続けても、カウンタは単調に進むだけで巻き戻らず、新しい観測は引き続き provisional として着地するだけ（何も「通らない」）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }), { maxRounds: 2 });
    mockChurnInterpretations();

    await harness.run({ reviewerRawFindings: [churnRaw(1)], runId: 'run-churn-1' });
    await harness.run({ reviewerRawFindings: [churnRaw(2)], runId: 'run-churn-2' });
    expect(harness.currentLedger().stopBudget?.exhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(2);

    // budget 到達後もラウンドを止める権限は engine 側の rule 評価にしかない
    // （このユニットテストは manager-runner 単体の性質を見るため、workflow
    // ルーティングそのものは別テストで検証済み）。ここでは「budget 到達済み」
    // という事実そのものが、後続ラウンドの台帳更新ロジックを緩めないことを見る。
    await harness.run({ reviewerRawFindings: [churnRaw(3)], runId: 'run-churn-3' });

    const ledger = harness.currentLedger();
    // 3件目の churn 観測はやはり新規 provisional として着地する（budget 到達は
    // 台帳へ書く操作の権限を何も緩めない）が、カウンタは単調に進むだけ。
    expect(stopBudgetRoundsCompleted(ledger)).toBe(3);
    expect(ledger.stopBudget?.exhausted).toBe(true);
    expect(ledger.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(3);
  });

  it('同一 invocation（同一 runId/step/iteration）を replay しても budget カウンタは二重計上しない（crash/replay 冪等: 同一マーカーの再適用は no-op）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }), { maxRounds: 5 });
    mockChurnInterpretations();

    // 同じ runId を渡す = 同一ラウンド identity（harness は stepIteration を固定
    // するため、runId が同じなら (runId, ns, step, iter) 全体が一致する）。
    await harness.run({ reviewerRawFindings: [churnRaw(1)], runId: 'run-crashed' });
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(1);
    // 台帳保存後・checkpoint 前クラッシュ → 同一ラウンドを再実行・再コミット。
    await harness.run({ reviewerRawFindings: [churnRaw(1)], runId: 'run-crashed' });
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(1);
    expect(harness.currentLedger().stopBudget?.roundMarkers).toHaveLength(1);
    expect(harness.currentLedger().stopBudget?.exhausted).toBe(false);
  });

  it('reviewer の raw finding に stopBudget 風の偽装フィールドを混入させても、台帳の roundMarkers / firstRoundAt / exhausted は一切影響を受けない（不正な入力元はラウンドカウンタを直接操作できない）', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }), { maxRounds: 100 });
    mockChurnInterpretations();
    const tamperedInput = {
      ...churnRaw(1),
      // raw finding の envelope には存在しないフィールド。canonicalization は
      // 既知フィールドしか読まないため静かに無視されるはず — もしどこかで
      // 読まれてしまうと、不正な入力元が exhausted を偽って早期/遅延停止させたり、
      // firstRoundAt を書き換えて時間予算の起点をずらせることになる。
      stopBudget: { roundMarkers: ['marker-1', 'marker-2', 'marker-3'], firstRoundAt: '2000-01-01T00:00:00.000Z', exhausted: true },
    };

    await harness.run({ reviewerRawFindings: [tamperedInput], runId: 'run-tampered' });

    const ledger = harness.currentLedger();
    expect(stopBudgetRoundsCompleted(ledger)).toBe(1);
    expect(ledger.stopBudget?.roundMarkers).not.toContain('marker-1');
    expect(ledger.stopBudget?.exhausted).toBe(false);
    expect(ledger.stopBudget?.firstRoundAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('並行更新で fresh ledger のマーカー集合が呼び出し開始時点より既に進んでいても、その最新集合を保ったまま自分のマーカーを足す（古い previousLedger 基準の lost-update・巻き戻りをしない — crash/replay の atomic 性と同じ保証）', async () => {
    const seedMarker = 'seed-round-marker';
    const seeded = makeLedger({
      findings: [],
      rawFindings: [],
      stopBudget: { roundMarkers: [seedMarker], firstRoundAt: '2026-06-14T00:00:00.000Z', exhausted: false },
    });
    const harness = makeHarness(seeded, { maxRounds: 100 });
    mockChurnInterpretations();
    const concurrentMarker = 'concurrent-round-marker';
    // harness は runId='run-2', stepIteration=2, callNamespace='' で呼ぶ。
    const thisRoundMarker = computeRoundMarker({ runId: 'run-2', callNamespace: '', parentStepName: 'reviewers', stepIteration: 2 });

    const result = await harness.run({
      reviewerRawFindings: [churnRaw(1)],
      // updateLedger の排他区間直前に、別 caller が並行してもう1ラウンド完了
      // させ、そのマーカーを集合へ追加していた状況を再現する。
      interceptFresh: (fresh) => ({
        ...fresh,
        stopBudget: {
          roundMarkers: [...(fresh.stopBudget?.roundMarkers ?? []), concurrentMarker],
          firstRoundAt: fresh.stopBudget!.firstRoundAt,
          exhausted: false,
        },
      }),
    });

    expect(result.status).toBe('updated');
    // 呼び出し開始時に読んだ古い集合（[seed]）を基準に上書きするのではなく、
    // 排他区間で読み直した最新集合（[seed, concurrent]）に自分のマーカーを足す。
    const markers = harness.currentLedger().stopBudget?.roundMarkers ?? [];
    expect(markers).toContain(seedMarker);
    expect(markers).toContain(concurrentMarker);
    expect(markers).toContain(thisRoundMarker);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// codex 検証2巡目#2: 証跡なし persists/reopened が既存 finding を変異させる経路
// （clean な persists→attach/conflict 化、clean な reopened→resolved/waived の
// reopen）を、検証済み source_quote が無い限り塞ぐ。
// ---------------------------------------------------------------------------
describe('codex 検証2巡目#2: 未検証 persists/reopened は既存 finding を変異させない', () => {
  it('未検証 reopened は resolved finding を open に戻せない（reopen は検証済み source_quote を要求する）', async () => {
    // F-0001 は resolved。reopened→resolved は coherent（clean）なので、機械分類の
    // ままだと reconciler が open へ戻せてしまう。証跡が無ければ変異させない。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 })],
    }));
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        description: 'Claims the resolved issue is back (no verifiable evidence).',
        suggestion: '',
        relation: 'reopened',
        targetFindingId: 'F-0001',
      }],
    });
    expect(result.status).toBe('updated');
    // 解釈フェーズにも decisions manager にも掛からない（admission で止まる）。
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    // F-0001 は resolved のまま（reopen されない・revision も動かない）。
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    expect(target.status).toBe('resolved');
    expect(target.revision).toBe(2);
    // 観測は消えず reviewer anomaly として残る（product gate は塞がない）。
    const anomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':r-1')));
    expect(anomaly?.kind).toBe('quote-mismatch');
    expect(saved.findings.some((finding) => finding.provisional !== undefined)).toBe(false);
  });

  it('未検証 persists は有効な confirmation を conflict 化して close を妨害できない', async () => {
    // 同一ラウンド: F-0001 を閉じる有効 confirmation（機械照合済み source_quote）と、
    // F-0001 が「まだ在る」と主張する未検証 persists。旧来なら両者が矛盾して
    // conflict 化し F-0001 が open のまま残った（close 妨害）。未検証 persists は
    // 機械分類に載せず rejected observation（監査のみ）へ回すことで、confirmation
    // だけが機械処理され F-0001 が resolved になる。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding()], // F-0001 open, src/a.ts:10
    }));
    const result = await harness.run({
      reviewerRawFindings: [
        {
          rawFindingId: 'c-ok',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'Verified the fix at src/a.ts:10.',
          suggestion: '',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
        },
        {
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          location: 'src/a.ts:10',
          description: 'Still broken (no verifiable evidence).',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
        },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // confirmation は成功し F-0001 は resolved。
    expect(target.status).toBe('resolved');
    // 未検証 persists は conflict を作らない（active conflict 無し = close 非妨害）。
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active' && conflict.findingIds.includes('F-0001'))).toEqual([]);
    // 未検証 persists は resolved target の canonical へも合流しない（product
    // finding は増えない・provisional も無し）。
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    expect(saved.findings.some((finding) => finding.provisional !== undefined)).toBe(false);
    // 同一ラウンドで confirmation が target を閉じたため、persists は resolved
    // target へは添付されず reviewer anomaly（review-integrity 側の監査）へ落ちる
    // （A-3 完全版と同じフォールバック — 観測は消えず、gate も塞がない）。
    const anomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-bad')));
    expect(anomaly?.kind).toBe('quote-mismatch');
  });
});

// ---------------------------------------------------------------------------
// codex 検証3巡目: 明示 evidenceKind:'locationless' でも persists/reopened の
// 既存 finding 変異は許さない。locationless が admit の根拠になれるのは new の
// absence finding だけ。
// ---------------------------------------------------------------------------
describe('codex 検証3巡目: 明示 locationless は persists/reopened の変異に使えない（new の absence 専用）', () => {
  it('locationless persists は有効な confirmation を conflict 化して close を妨害できない', async () => {
    // p-bad は明示 evidenceKind:'locationless' 付き。前回は「evidence 未指定」だけを
    // 塞いだが、locationless の反例（relation 判定より先に admit される穴）が残って
    // いた。locationless でも clean persists は変異経路へ通さない。
    const harness = makeHarness(makeLedger({ findings: [makeFinding()] })); // F-0001 open, src/a.ts:10
    const result = await harness.run({
      reviewerRawFindings: [
        {
          rawFindingId: 'c-ok',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'Verified the fix at src/a.ts:10.',
          suggestion: '',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
          ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
        },
        {
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          location: '',
          description: 'Claims the issue still persists (locationless).',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          evidenceKind: 'locationless',
          verbatimExcerpt: '',
          snapshotId: '',
        },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // confirmation は成功し F-0001 は resolved。
    expect(target.status).toBe('resolved');
    // locationless persists は conflict を作らない（active conflict 無し = close 非妨害）。
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active' && conflict.findingIds.includes('F-0001'))).toEqual([]);
    // canonical へも合流しない。監査（reviewer anomaly）へ着地する。
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    expect(saved.findings.some((finding) => finding.provisional !== undefined)).toBe(false);
    const anomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-bad')));
    expect(anomaly?.kind).toBe('quote-mismatch');
  });

  it('locationless reopened は resolved finding を open に戻せない（anomaly 着地）', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 })],
    }));
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        location: '',
        description: 'Claims the resolved issue is back (locationless).',
        suggestion: '',
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidenceKind: 'locationless',
        verbatimExcerpt: '',
        snapshotId: '',
      }],
    });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // F-0001 は resolved のまま（reopen されない・revision 不変）。
    expect(target.status).toBe('resolved');
    expect(target.revision).toBe(2);
    const anomaly = saved.reviewerAnomalies?.find((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':r-1')));
    expect(anomaly?.kind).toBe('quote-mismatch');
    expect(saved.findings.some((finding) => finding.provisional !== undefined)).toBe(false);
  });

  it('new + locationless は provisional に保持し、confirmed/anomaly へは着地しない', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    const rawFinding = {
      rawFindingId: 'n-1',
      familyTag: 'security',
      severity: 'high',
      title: 'Missing rate limiter (absence finding)',
      location: '',
      description: 'A rate limiter that should exist is absent from the request pipeline.',
      suggestion: 'Add a rate limiter.',
      relation: 'new',
      targetFindingId: '',
      evidenceKind: 'locationless',
      verbatimExcerpt: '',
      snapshotId: '',
    };
    const result = await harness.run({ reviewerRawFindings: [rawFinding] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    // description と raw 観測を保持する provisional であり、確定 authority にはしない。
    const landed = saved.findings.find((finding) => finding.title === 'Missing rate limiter (absence finding)');
    expect(landed?.status).toBe('open');
    expect(landed?.provisional?.kind).toBe('unverified-locationless');
    expect(landed?.description).toBe('A rate limiter that should exist is absent from the request pipeline.');
    expect(landed?.rawFindingIds).toHaveLength(1);
    expect(saved.rawFindings).toHaveLength(1);
    expect(saved.rawFindings[0]?.description).toBe('A rate limiter that should exist is absent from the request pipeline.');
    expect(saved.reviewerAnomalies ?? []).toEqual([]);
    const context = buildFindingsRuleContext(saved);
    expect(context.provisional.count).toBe(1);
    expect(context.open.count).toBe(1);

    await harness.run({ reviewerRawFindings: [rawFinding] });
    const replayed = harness.currentLedger();
    const replayedFinding = replayed.findings.find((finding) => finding.title === 'Missing rate limiter (absence finding)');
    expect(replayed.rawFindings).toHaveLength(1);
    expect(replayedFinding?.rawFindingIds).toHaveLength(1);
    expect(replayedFinding?.provisional?.sourceRawFindingIds).toHaveLength(1);
    expect(stopBudgetRoundsCompleted(replayed)).toBe(1);
  });

  it('架空コードを locationless と偽装した new claim は confirmed finding にならない', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'n-hallucinated',
        familyTag: 'security',
        severity: 'critical',
        title: 'Imaginary authentication bypass',
        location: '',
        description: 'The nonexistent auth/ghost.ts bypasses every authorization check.',
        suggestion: 'Remove the imaginary bypass.',
        relation: 'new',
        targetFindingId: '',
        evidenceKind: 'locationless',
        verbatimExcerpt: '',
        snapshotId: '',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const landed = saved.findings.find((finding) => finding.title === 'Imaginary authentication bypass');
    expect(landed?.provisional?.kind).toBe('unverified-locationless');
    expect(landed?.provisional).toBeDefined();
    expect(saved.reviewerAnomalies ?? []).toEqual([]);
  });

  it('対照: persists + matching source_quote は従来どおり変異経路へ（open target へ機械 attach する）', async () => {
    // 検証済み source_quote 付きの persists は open target へ機械 same として
    // 合流（attach）する = 既存 finding を変異させる正当な経路。locationless/
    // 未検証との対照。
    const harness = makeHarness(makeLedger({ findings: [makeFinding()] })); // F-0001 open, src/a.ts:10
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'p-ok',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        description: 'Still observing the issue at src/a.ts:10.',
        suggestion: '',
        relation: 'persists',
        targetFindingId: 'F-0001',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10),
      }],
    });
    expect(result.status).toBe('updated');
    // 機械 same で確定するため decisions manager は呼ばれない。
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // open のまま、observation が canonical へ合流する（rawFindingIds に p-ok が付く）。
    expect(target.status).toBe('open');
    expect(target.rawFindingIds.some((id) => id.endsWith(':p-ok'))).toBe(true);
    // anomaly には落ちない（正当な変異経路）。
    expect(saved.reviewerAnomalies?.some((entry) => entry.sourceRawFindingIds.some((id) => id.endsWith(':p-ok'))) ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// codex 検証4巡目: tainted × locationless（未検証）の persists/reopened が
// ambiguous ladder（SameProof / create_independent / open_conflict）経由で既存
// finding を変異できる穴を塞ぐ。未検証 tainted persists/reopened は provisional-only。
// ---------------------------------------------------------------------------
describe('codex 検証4巡目: 未検証 tainted persists/reopened は ambiguous ladder でも provisional-only', () => {
  it('tainted locationless reopened は open target を SameProof identity マッチで変異できない（reattach 遮断）', async () => {
    // F-0001 は open で、locationless + 同一 title/description/suggestion の raw と
    // identity（SameProof の一致条件）が一致する。reopened→open target は
    // reopened-target-open で tainted になる。修正前はこの identity 一致で
    // SameProof が発行され reattach（revision/rawFindingIds/lastSeen 更新）できた。
    const seed = makeFinding({
      status: 'open', lifecycle: 'new', revision: 1,
      location: undefined,
      title: 'Missing input validation',
      description: 'The handler does not validate input.',
      suggestion: 'Add validation.',
      rawFindingIds: ['raw-existing'],
    });
    const harness = makeHarness(makeLedger({ findings: [seed] }));
    // SameProof が塞がれた後、raw は解釈へ回る。provisional を返させて着地を固定。
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'r-1');
      return interpretationResponse([{ decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot verify the re-observation.' }]);
    });
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Missing input validation',
        location: '',
        description: 'The handler does not validate input.',
        suggestion: 'Add validation.',
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidenceKind: 'locationless',
        verbatimExcerpt: '',
        snapshotId: '',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // 変異なし: status/revision/lifecycle/description/rawFindingIds すべて不変。
    expect(target.status).toBe('open');
    expect(target.revision).toBe(1);
    expect(target.lifecycle).toBe('new');
    expect(target.description).toBe('The handler does not validate input.');
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    // raw は gate-blocking provisional として着地する（観測は消えない）。
    const provisional = saved.findings.find((finding) => finding.id !== 'F-0001' && finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(provisional?.rawFindingIds.some((id) => id.endsWith(':r-1'))).toBe(true);
  });

  it('tainted locationless persists は manager が create_independent を返しても provisional 止まり（新規 finding を作らない）', async () => {
    // persists→resolved target は persists-target-not-open で tainted。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', location: undefined, title: 'Old bug' })],
    }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      // manager が create_independent を提案しても、未検証 persists は provisional へ強制。
      return interpretationResponse([{ decision: 'create_independent', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: '' }]);
    });
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'p-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'A brand new independent problem',
        location: '',
        description: 'Something else entirely.',
        suggestion: '',
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidenceKind: 'locationless',
        verbatimExcerpt: '',
        snapshotId: '',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // create_independent は封じられ、新規の confirmed finding は立たない。
    expect(saved.findings.some((finding) => finding.title === 'A brand new independent problem' && finding.provisional === undefined)).toBe(false);
    // provisional として着地する。
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(provisional?.rawFindingIds.some((id) => id.endsWith(':p-1'))).toBe(true);
    // resolved target は不変。
    expect(saved.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
  });

  it('tainted locationless persists は manager が open_conflict を返しても provisional 止まり（別 open finding へ conflict を立てない）', async () => {
    // F-0001 resolved（persists target）、F-0002 open（open_conflict のターゲット候補）。
    const harness = makeHarness(makeLedger({
      findings: [
        makeFinding({ status: 'resolved', lifecycle: 'resolved', location: undefined, title: 'Old bug' }),
        makeFinding({ id: 'F-0002', status: 'open', location: 'src/b.ts:5', title: 'Unrelated open finding', rawFindingIds: ['raw-f2'] }),
      ],
      nextId: 3,
    }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      // manager が open_conflict（F-0002 は open なので validation は通る）を返しても
      // 未検証 persists は provisional へ強制され、conflict は立たない。
      return interpretationResponse([{ decision: 'open_conflict', rawFindingId: rawId, proofId: '', targetFindingId: 'F-0002', reason: '' }]);
    });
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'p-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Old bug',
        location: '',
        description: 'Claims it still persists (locationless).',
        suggestion: '',
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidenceKind: 'locationless',
        verbatimExcerpt: '',
        snapshotId: '',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // open_conflict は封じられ、active conflict は立たない。
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active')).toEqual([]);
    // F-0002 は不変、raw は provisional。
    expect(saved.findings.find((finding) => finding.id === 'F-0002')?.rawFindingIds).toEqual(['raw-f2']);
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
  });

  it('対照: verified(source_quote match) の tainted persists は従来どおり ladder の能力を維持する（create_independent が通る）', async () => {
    // persists→resolved target（tainted）だが、matching source_quote 付き = 検証済み。
    // provisional-only 制限の対象外なので、manager の create_independent が通り
    // 新規 finding が立つ（退行させない）。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', title: 'Old bug' })],
      nextId: 2,
    }));
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-verified');
      return interpretationResponse([{ decision: 'create_independent', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: '' }]);
    });
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'p-verified',
        familyTag: 'bug',
        severity: 'high',
        title: 'A genuinely new problem with a real citation',
        description: 'Cited with a verified source_quote.',
        suggestion: '',
        relation: 'persists',
        targetFindingId: 'F-0001',
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 15),
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // 検証済みなので create_independent が通り、新規 open finding が立つ（provisional ではない）。
    const created = saved.findings.find((finding) => finding.title === 'A genuinely new problem with a real citation');
    expect(created?.status).toBe('open');
    expect(created?.provisional).toBeUndefined();
  });
});
