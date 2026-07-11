/**
 * v2 梯子設計（raw finding 意味矛盾）のレッドチーム成立攻撃8件の再現回帰テスト
 * （設計書 §13）。攻撃の入力列をそのまま再現し、修正後の挙動 — 権限拒否・
 * provisional 化・CAS 不採用・conflict 化 — を固定する。
 *
 * 攻撃対応表:
 *   attack 1: 権限洗浄（manager が resolve/waive/invalidate/supersede/証明なし same）
 *   attack 2: candidate/canonical 型混同（型 assertion / spread / 手組み object）
 *   attack 3: stale confirmation（prompt 後の persists 保存と競合する確認）
 *   attack 4: persists 洗浄（ambiguous persists の target 吸収）
 *   attack 5: 永久機関（同一 lineage の ambiguous raw 再発による ID 増殖・解釈無限化）
 *   attack 6: no-op gate bypass（空配列・不正 decision・unknown id・unsupported）
 *   attack 7: resource exhaustion（435 raw・巨大 description・step 上限超過）
 *   attack 8: crash/replay（WAL 各段でのプロセス停止と resume）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  candidateFromLegacyRawFinding,
  computeInterpretationKey,
  computeLineageKey,
  computeProvisionalStableKey,
  computeRawEvidenceHash,
  computeReviewerStableKey,
  createReviewerRawFindingCandidates,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { AmbiguousInterpretationsOutputJsonSchema } from '../core/workflow/findings/schemas.js';
import { issueDeterministicSameProofs, verifySameProofAgainstLedger } from '../core/workflow/findings/raw-capabilities.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import { kindForRelation, parseFindingLedger } from '../core/workflow/findings/schemas.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

// raw admission validation が実 fs を見るため fixture を用意する。
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-ladder-attack-fixtures-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/a.ts', 60);
writeFixtureFile('src/b.ts', 60);

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

function makeHarness(initialLedger: FindingLedger): Harness {
  let ledger = initialLedger;
  const savedLedgers: FindingLedger[] = [];
  const savedReports: FindingManagerValidationReport[] = [];
  let intercept: ((fresh: FindingLedger) => FindingLedger) | undefined;
  const ledgerStore: FindingLedgerStore = {
    workflowName: 'peer-review',
    loadLedger: () => ledger,
    saveLedger: (next) => { ledger = next; savedLedgers.push(next); },
    updateLedger: (mutator) => {
      if (intercept !== undefined) {
        ledger = intercept(ledger);
        intercept = undefined;
      }
      ledger = mutator(ledger);
      savedLedgers.push(ledger);
      return Promise.resolve(ledger);
    },
    createRunCopy: () => '/tmp/ledger-copy.json',
    saveRawFindings: () => '/tmp/raw-findings.json',
    saveManagerValidationReport: (report) => {
      savedReports.push(report);
      return '/tmp/manager-report.json';
    },
  };
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
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
  location: 'src/a.ts:20',
  description: 'Claims the resolved issue persists with different content.',
  suggestion: '',
  relation: 'persists',
  targetFindingId: 'F-0001',
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
// attack 1: 権限洗浄
// ---------------------------------------------------------------------------
describe('attack 1: 権限洗浄（manager が capability の外の操作を提案する）', () => {
  it('resolve/waive/invalidate/supersede 相当の提案語彙は schema に存在せず、返すと batch 全体が provisional に落ちる。target は不変', async () => {
    // 対象が resolved の persists → ambiguous → 解釈フェーズへ。manager が
    // 「resolve」を返す（提案 enum の外 = 権限洗浄の試み）。
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
        { decision: 'same_with_proof', rawFindingId: rawId, proofId: 'forged-proof-id', targetFindingId: '', reason: '' },
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
// attack 2: candidate/canonical 型混同
// ---------------------------------------------------------------------------
describe('attack 2: candidate/canonical 型混同（factory を通らない object の runtime 拒否）', () => {
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
    const forged = { ...canonical };
    expect(() => toLedgerRawFinding(forged as never)).toThrow(/candidate\/canonical type confusion/);
    expect(() => issueDeterministicSameProofs({ ledger: makeLedger(), ambiguousRawFindings: [forged as never] }))
      .toThrow(/candidate\/canonical type confusion/);
  });

  it('型 assertion で作った canonical 風 object も runtime で拒否される', () => {
    const forged = {
      rawFindingId: 'r', reviewerStableKey: 'k', lineageKey: 'l', evidenceHash: 'h',
      relation: 'resolution_confirmation', kind: 'resolution_confirmation',
      reviewer: 'r', stepName: 's', coherence: 'coherent',
      provenance: { origin: 'reviewer', ambiguityOrigin: false, clarificationAttempted: false, ambiguityCodes: [] },
      familyTag: 'bug', severity: 'high', title: 't', description: 'd', targetFindingId: 'F-0001',
    };
    expect(() => toLedgerRawFinding(forged as never)).toThrow(/candidate\/canonical type confusion/);
  });

  it('legacy ledger の raw も同じ factory（candidateFromLegacyRawFinding → canonicalize）を通る', () => {
    const legacyRaw: RawFinding = {
      rawFindingId: 'raw-legacy',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Legacy issue',
      location: 'src/a.ts:10',
      description: 'Legacy body.',
      kind: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    };
    const candidate = candidateFromLegacyRawFinding(legacyRaw, REVIEWER_STABLE_KEY);
    // legacy adapter の中だけは kind → relation の復元が許される。
    expect(candidate.relation).toBe('resolution_confirmation');
    const { canonical } = canonicalizeReviewerRawFinding(candidate, { ledger: makeLedger() });
    expect(canonical.kind).toBe(kindForRelation(canonical.relation));
    expect(() => toLedgerRawFinding(canonical)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// attack 3: stale confirmation（coherent 経路でも成立すること）
// ---------------------------------------------------------------------------
describe('attack 3: stale confirmation（prompt 後の persists 保存と競合する形式的に正しい確認）', () => {
  it('coherent confirmation の snapshot 後に別 caller が persists を保存すると、resolve されず target open + active conflict + provisional になる', async () => {
    const harness = makeHarness(makeLedger());
    // 形式的に正しい confirmation（coherent）→ 機械分類で resolved 候補になる。
    const confirmation = {
      rawFindingId: 'c-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed fixed',
      location: 'src/a.ts:10',
      description: 'Verified the fix at src/a.ts:10.',
      suggestion: '',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
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
// attack 4: persists 洗浄
// ---------------------------------------------------------------------------
describe('attack 4: persists 洗浄（ambiguous persists を target に吸収させる試み）', () => {
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
// attack 5: 永久機関
// ---------------------------------------------------------------------------
describe('attack 5: 永久機関（同一 lineage の ambiguous raw を run/iteration/id/説明文/行番号を変えて繰り返す）', () => {
  it('finding ID は増殖せず同じ provisional が更新され、manager 解釈は lineage 上限2 epoch で止まる', async () => {
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

    // 4ラウンド: runId・rawFindingId・説明文（= evidence 実質変更）・行番号を毎回変える。
    for (let round = 1; round <= 4; round += 1) {
      const result = await harness.run({
        runId: `run-${round}`,
        reviewerRawFindings: [{
          ...AMBIGUOUS_PERSISTS_RAW,
          rawFindingId: 'p-1',
          location: `src/a.ts:${20 + round}`,
          description: `Claims the resolved issue persists (attempt #${round}).`,
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
  });
});

describe('attack 5 変種: 同一 evidence 再送（codex B1）', () => {
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
// attack 6: no-op gate bypass
// ---------------------------------------------------------------------------
describe('attack 6: no-op gate bypass（空配列・unknown id・unsupported で先へ進める試み）', () => {
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
        },
        timestamp: new Date('2026-06-14T00:00:01.000Z'),
      } as unknown as AgentResponse;
    });

    const result = await harness.run({
      reviewerRawFindings: [
        {
          rawFindingId: 'i-1',
          familyTag: 'security',
          severity: 'medium',
          title: 'Unhandled new issue',
          location: 'src/b.ts:5',
          description: 'A new problem the manager ignores.',
          suggestion: '',
          relation: 'new',
          targetFindingId: '',
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
          location: 'src/a.ts:30',
          description: 'Still broken with different details.',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
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
    expect(context.provisional.items.some((item) => item.kind === 'raw-meaning-ambiguous')).toBe(true);
    const provisional = saved.findings.find((finding) => finding.title === 'Unhandled new issue');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.gateEffect).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// attack 7: resource exhaustion
// ---------------------------------------------------------------------------
describe('attack 7: resource exhaustion（435 raw・巨大 description・step 上限）', () => {
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
      updateLedger: (mutator) => { ledger = mutator(ledger); return Promise.resolve(ledger); },
      createRunCopy: () => '/tmp/ledger-copy.json',
      saveRawFindings: () => '/tmp/raw-findings.json',
      saveManagerValidationReport: () => '/tmp/manager-report.json',
    };
    const stepExecutor = {
      buildPhase1Instruction: (instruction: string) => instruction,
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
        },
        timestamp: new Date(),
      } as unknown as AgentResponse;
    });

    const okRaws = makeManyRaws(3, 'ok').map((raw, index) => ({ ...raw, title: `Legit finding ${index + 1}`, description: `Legit ${index + 1}`, location: 'src/a.ts:5' }));
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
// attack 8: crash/replay
// ---------------------------------------------------------------------------
describe('attack 8: crash/replay（WAL 各段での停止と resume の冪等性）', () => {
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
  const INTERPRETATION_KEY = computeInterpretationKey({
    reviewerStableKey: REVIEWER_STABLE_KEY,
    lineageKey: LINEAGE_KEY,
    candidateEvidenceHash: EVIDENCE_HASH,
  });

  function resolvedTargetLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
    return makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' })],
      ...overrides,
    });
  }

  it('started 保存直後に停止した run の resume は、manager を再呼び出さず interpretation-interrupted provisional にする', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'interpretation_started',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        promptPreconditions: [],
      }],
    }));

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    // manager は再呼び出しされない。
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('interpretation-interrupted');
    expect(provisional?.status).toBe('open');
  });

  it('completed 保存後に停止した run の resume は、保存済み decision を再利用して manager を再呼び出さない', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        policyVersion: 2,
        stage: 'interpretation_completed',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
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

  it('applied（provisional_created）後の同一 raw 再来は既存 provisional へ帰属し、別キーの provisional が増殖しない（codex B1 実測ケース）', async () => {
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
      },
    });
    const harness = makeHarness(resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved' }), existingProvisional],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
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

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const provisionals = saved.findings.filter((finding) => finding.provisional !== undefined);
    // F-0002 と F-0003 の併存（実測された増殖）が起きない。
    expect(provisionals).toHaveLength(1);
    expect(provisionals[0]?.id).toBe('F-0002');
    expect(provisionals[0]?.rawFindingIds.some((id) => id.startsWith('run-2:'))).toBe(true);
  });

  it('同じ confirmation の再適用は冪等（同じ evidence で resolved 済みなら二重 resolve にならない）', async () => {
    // 1回目: confirmation が F-0001 を resolve する。
    const harness = makeHarness(makeLedger());
    const confirmation = {
      rawFindingId: 'c-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed fixed',
      location: 'src/a.ts:10',
      description: 'Verified the fix at src/a.ts:10.',
      suggestion: '',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
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
  it('relation→kind の4通り（kindForRelation が唯一の導出）', () => {
    expect(kindForRelation('new')).toBe('issue');
    expect(kindForRelation('persists')).toBe('issue');
    expect(kindForRelation('reopened')).toBe('issue');
    expect(kindForRelation('resolution_confirmation')).toBe('resolution_confirmation');
  });

  it('kind/relation 矛盾（v3-r3 gemma 実測）は parse 失敗ではなく ambiguity taint になる', () => {
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-gemma',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue',
      location: 'src/a.ts:10',
      description: 'Confirmed the fix.',
      suggestion: '',
      kind: 'issue',
      relation: 'resolution_confirmation',
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
    const { outcome, canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger: makeLedger() });
    expect(outcome).toBe('ambiguous');
    expect(canonical.provenance.ambiguityOrigin).toBe(true);
    expect(canonical.provenance.ambiguityCodes).toContain('kind-relation-conflict');
    // canonical の relation/kind は必ず一致する整合ペア。
    expect(canonical.kind).toBe(kindForRelation(canonical.relation));
  });

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
      kind: 'issue',
      relation: 'resolution_confirmation', // kind と矛盾 → ambiguous
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
      // manager が何を返しても reopen の提案語彙は無い。provisional 提案で着地。
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot verify reopen claim.' },
      ]);
    });

    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Invalidated issue came back',
        location: 'src/a.ts:15',
        description: 'The invalidated finding is real after all.',
        suggestion: '',
        // reopened の対象は resolved/waived のみ許容。invalidated（terminal）への
        // reopened は…detectRawFindingAmbiguities では open でない target への
        // reopened は coherent 扱いだが、機械分類は reopen を manager に送り、
        // decisions manager では invalidated target への reopen は不採用になる。
        // ここでは kind 矛盾で ambiguous にし、ladder 側で reopen 不能を固定する。
        kind: 'resolution_confirmation',
        relation: 'reopened',
        targetFindingId: 'F-0001',
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('invalidated');
    expect(target?.revision).toBe(2);
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.status).toBe('open');
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
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        location: 'src/b.ts:7',
        description: 'Something is off.',
        suggestion: '',
        kind: 'resolution_confirmation', // kind 矛盾 → ambiguous
        relation: 'new',
        targetFindingId: '',
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
        location: 'src/b.ts:9',
        description: 'Confirmed: the parser drops trailing tokens.',
        suggestion: 'Fix the tokenizer.',
        relation: 'new',
        targetFindingId: '',
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

  it('既存 v1 ledger（revision / provisional / interpretations なし）を migration なしで読め、保存後も version 1 のまま', async () => {
    const legacyLedger = {
      version: 1,
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      rawFindings: [{
        rawFindingId: 'raw-existing',
        stepName: 'reviewers',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        location: 'src/a.ts:10',
        description: 'Existing issue body.',
        // legacy: kind のみ（relation なし）
        kind: 'issue',
      }],
      conflicts: [],
    };
    const parsed = parseFindingLedger(legacyLedger);
    expect(parsed.version).toBe(1);
    // legacy raw の relation は derive される（kind → relation は legacy 経路のみ）。
    expect(parsed.rawFindings[0]?.relation).toBe('new');

    const harness = makeHarness(parsed);
    const confirmation = {
      rawFindingId: 'c-1',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed fixed',
      location: 'src/a.ts:10',
      description: 'Verified the fix.',
      suggestion: '',
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
    };
    const result = await harness.run({ reviewerRawFindings: [confirmation] });
    expect(result.ledger.version).toBe(1);
    // 保存後の台帳も v1 schema で round-trip する。
    expect(() => parseFindingLedger(JSON.parse(JSON.stringify(result.ledger)))).not.toThrow();
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
        location: 'src/b.ts:7',
        description: 'Something is off.',
        suggestion: '',
        kind: 'resolution_confirmation', // kind 矛盾 → ambiguous
        relation: 'new',
        targetFindingId: '',
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
        location: 'src/b.ts:9',
        description: 'A totally different failure mode: quadratic scan on large inputs.',
        suggestion: '',
        relation: 'new',
        targetFindingId: '',
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
      location: 'src/b.ts:7',
      description: 'Something is off.',
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
    };
    // round 1: kind 矛盾で ambiguous → provisional。
    await harness.run({ runId: 'run-2', reviewerRawFindings: [{ ...observation, kind: 'resolution_confirmation' }] });
    const provisionalId = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 完全に同一内容の clean raw（kind 矛盾なし）→ 機械分類の
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

  it('正規化監査: v3-r3 実測の kind/relation 矛盾も元の kind と ambiguity codes が監査メタデータに残る。無変換の clean raw は記録されない', async () => {
    const harness = makeHarness(makeLedger());
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'g-1');
      return interpretationResponse([
        { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Unclear.' },
      ]);
    });

    await harness.run({
      reviewerRawFindings: [
        {
          // gemma パターン: kind=issue + relation=resolution_confirmation。
          rawFindingId: 'g-1',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          location: 'src/a.ts:10',
          description: 'Confirmed the fix but mislabeled kind.',
          suggestion: '',
          kind: 'issue',
          relation: 'resolution_confirmation',
          targetFindingId: 'F-0001',
        },
        {
          // 無変換の clean new（監査ノイズを増やさないことの確認）。
          rawFindingId: 'clean-1',
          familyTag: 'security',
          severity: 'medium',
          title: 'A clean unrelated issue',
          location: 'src/b.ts:9',
          description: 'A separate clean observation.',
          suggestion: '',
          relation: 'new',
          targetFindingId: '',
        },
      ],
      priorStepResponseText: undefined,
    });

    const report = harness.savedReports.at(-1)!;
    const record = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':g-1'));
    expect(record?.claimedKind).toBe('issue');
    expect(record?.claimedRelation).toBe('resolution_confirmation');
    expect(record?.ambiguityCodes).toContain('kind-relation-conflict');
    // 無変換 raw は記録されない。
    expect(report.rawNormalizations?.some((entry) => entry.rawFindingId.endsWith(':clean-1'))).toBe(false);
  });

  it('正規化監査の write-ahead: intake 後の処理（updateLedger）が例外を投げても、元の主張はディスクの検証レポートから復元できる', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-ladder-wal-audit-project-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-ladder-wal-audit-report-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);

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
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-ladder-parallel-project-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-ladder-parallel-report-'));
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/a.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);

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
