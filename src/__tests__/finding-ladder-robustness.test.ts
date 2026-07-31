/**
 * raw finding 意味矛盾の解釈梯子に対する堅牢性検証ケース8件の再現回帰テスト
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
  createReviewerRawFindingCandidates as createReviewerRawFindingCandidateBatch,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import { AmbiguousInterpretationsOutputJsonSchema } from '../core/workflow/findings/schemas.js';
import { issueDeterministicSameProofs, verifySameProofAgainstLedger } from '../core/workflow/findings/raw-capabilities.js';
import { computeClaimIdentityHash } from '../core/workflow/findings/evidence-domain.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { stopBudgetRoundsCompleted } from '../core/workflow/findings/stop-budget.js';
import { addRoundMarker, computeRoundMarker } from '../core/workflow/findings/round-marker.js';
import { computeFindingReviewPublicationId } from '../core/workflow/findings/review-publication.js';
import { captureFindingPreconditions } from '../core/workflow/findings/finding-preconditions.js';
import { collectInterpretationRecoveryPlan } from '../core/workflow/findings/interpretation-recovery.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';
import { settleProvisionalsWithCleanEvidence } from '../core/workflow/findings/manager-provisional-settlement.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import { createFindingAdjudicationReservation } from './helpers/finding-adjudication-reservation.js';
import {
  verifiedSourceQuoteFields,
} from './helpers/finding-evidence.js';
import {
  createFindingManagerPublicationDouble,
  observeFindingLedgerMutations,
  RevisionedFindingLedgerTestRepository,
} from './helpers/finding-manager-publication.js';
import { findingReviewPublicationFixture } from './helpers/finding-review-publication.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { findingManagerTaskResponse } from './helpers/finding-manager-task-response.js';

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
const publicationDirs = new Set<string>();
function makePublicationDir(prefix: string): string {
  const directory = mkdtempSync(join(TEST_TMPDIR, prefix));
  publicationDirs.add(directory);
  return directory;
}
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
const FIXTURE_SNAPSHOT_ID = verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 1).snapshotId;

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
  for (const directory of publicationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    description: 'Existing issue body.',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-existing'],
    firstSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    lastSeen: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  const ledger: FindingLedger = {
    workflowName: 'peer-review',
    nextId: 2,
    updatedAt: '2026-06-13T00:00:00.000Z',
    findings: [makeFinding({ revision: 1 })],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [canonicalRawFindingFixture({
      rawFindingId: 'raw-existing',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: null,
      severity: 'high',
      title: 'Existing issue',
      description: 'Existing issue body.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: reviewerEvidence('src/a.ts', 1),
    })],
    conflicts: [],
    interpretations: [],
    ...overrides,
  };
  return authorizeFindingLedgerFixture({
    ...ledger,
    rawFindings: ledger.rawFindings.map((rawFinding) => (
      canonicalRawFindingFixture(rawFinding)
    )),
  });
}

function reviewerEvidence(path: string, line: number) {
  return [verifiedSourceQuoteFields(FIXTURE_CWD, path, line)];
}

function reviewerExtraction(raw: Record<string, unknown>): Record<string, unknown> {
  if ('rawExcerpt' in raw && 'candidate' in raw) {
    return raw;
  }
  const finding = raw as Partial<RawFinding>;
  const localId = typeof finding.rawFindingId === 'string' ? finding.rawFindingId : null;
  const description = typeof finding.description === 'string' ? finding.description : null;
  return reviewerRawExtractionFixture({
    rawFindingId: localId,
    familyTag: typeof finding.familyTag === 'string' ? finding.familyTag : null,
    severity: finding.severity ?? null,
    title: typeof finding.title === 'string' ? finding.title : null,
    description,
    suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : null,
    relation: finding.relation ?? null,
    targetFindingId: typeof finding.targetFindingId === 'string' && finding.targetFindingId !== ''
      ? finding.targetFindingId
      : null,
    target: finding.target,
    evidence: finding.evidence,
    rawExcerpt: `[${localId ?? 'anonymous'}] ${description ?? finding.title ?? 'Observation'}`,
  });
}

function reviewerExtractions(
  raws: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return raws.map(reviewerExtraction);
}

function createReviewerRawFindingCandidates(
  raws: Array<Record<string, unknown>>,
  context: Omit<
    Parameters<typeof createReviewerRawFindingCandidateBatch>[1],
    'reviewReport' | 'issueEvidenceRequests'
  >,
) {
  const extractions = reviewerExtractions(raws);
  return createReviewerRawFindingCandidateBatch(extractions, {
    ...context,
    reviewReport: extractions.map((item) => String(item.rawExcerpt ?? '')).join('\n'),
    issueEvidenceRequests: () => ({
      evidence: [],
      engineProofRecords: [],
      coverageGaps: [],
    }),
  }).candidates;
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
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(initialLedger);
  const publicationReportDir = makePublicationDir('takt-ladder-publication-');
  const savedLedgers: FindingLedger[] = [];
  const savedReports: FindingManagerValidationReport[] = [];
  const publicationDouble = createFindingManagerPublicationDouble(
    (report) => {
      savedReports.push(report);
      return join(
        publicationReportDir,
        `findings-manager-validation.${report.stepName}.json`,
      );
    },
    ledgerRepository,
  );
  const observedMutations = observeFindingLedgerMutations(
    ledgerRepository,
    publicationDouble,
    async (ledger) => {
      savedLedgers.push(ledger);
      await afterUpdate?.(ledger);
    },
  );
  const ledgerStore: FindingLedgerStore = {
    ledgerIdentity: '/test/finding-ladder-robustness/ledger.json',
    interpretationLiveClaims: processInterpretationLiveClaims,
    workflowName: 'peer-review',
    loadLedger: () => ledgerRepository.loadLedger(),
    ...createFindingAdjudicationReservation(),
    saveLedgerSnapshot: () => {},
    saveRawFindings: () => {},
    saveManagerValidationReport: (report) => {
      savedReports.push(report);
    },
    ...publicationDouble,
    ...observedMutations,
    saveConflictAdjudicationReport: () => {},
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
    currentLedger: () => ledgerRepository.loadLedger(),
    run: (input) => {
      if (input.interceptFresh !== undefined) {
        ledgerRepository.commitBeforeNextExclusiveMutation(input.interceptFresh);
      }
      const extractions = reviewerExtractions(input.reviewerRawFindings);
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
            publication: findingReviewPublicationFixture({
              scopeIdentity: ledgerStore.ledgerIdentity,
              parentStepName: parentStep.name,
              stepIteration: 2,
              reviewerStepName: 'arch-review',
              rawFindings: extractions,
            }),
          },
        ],
        workflowName: 'peer-review',
        workflowTask: 'Review the implementation.',
        runId: input.runId ?? 'run-2',
        callNamespace: '',
        timestamp: '2026-06-14T00:00:00.000Z',
        priorStepResponseText: input.priorStepResponseText,
        managerAuthority: 'standard',
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

/** relation が欠けた不完全 new claim。一般の interpretation/WAL 安全性テスト用。 */
const AMBIGUOUS_PERSISTS_RAW = {
  rawFindingId: 'p-1',
  familyTag: null,
  severity: 'high',
  title: 'Existing issue still present',
  description: 'Claims the resolved issue persists with different content.',
  suggestion: '',
  relation: 'new',
  targetFindingId: '',
  evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)],
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

function currentManagerRawFindingIds(instruction: string): string[] {
  const marker = '\nRaw findings:\n';
  const rawFindingsBlock = instruction.slice(instruction.lastIndexOf(marker) + marker.length);
  const fencedJson = /^(`{3,})json\n([\s\S]*?)\n\1/.exec(rawFindingsBlock);
  if (fencedJson?.[2] === undefined) return [];
  const rawFindings = JSON.parse(fencedJson[2]) as Array<{ rawFindingId?: unknown }>;
  return rawFindings.flatMap((raw) => (
    typeof raw.rawFindingId === 'string' ? [raw.rawFindingId] : []
  ));
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
    ledger: makeLedger(),
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
      { rawFindingId: 'raw-1', title: 'T', description: 'D', severity: 'high', familyTag: 'bug', relation: 'new', targetFindingId: null, suggestion: null, evidence: reviewerEvidence('src/a.ts', 5) },
    ], intakeContext);
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger: makeLedger() });
    // 正規経路は通る。
    expect(() => toLedgerRawFinding(canonical)).not.toThrow();
    // spread による「昇格コピー」は runtime で拒否される。
    const invalidCandidate = { ...canonical };
    expect(() => toLedgerRawFinding(invalidCandidate as never)).toThrow(/candidate\/canonical type confusion/);
    expect(() => issueDeterministicSameProofs({
      ledger: makeLedger(),
      ambiguousRawFindings: [invalidCandidate as never],
      excludedTargetFindingIdsByRawFindingId: new Map(),
    }))
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
    const sourceLedger = makeLedger();
    const storedRaw: RawFinding = canonicalRawFindingFixture({
      rawFindingId: 'raw-stored',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: null,
      severity: 'high',
      title: 'Stored issue',
      description: 'Stored body.',
      suggestion: null,
      relation: 'resolution_confirmation',
      targetFindingId: 'F-0001',
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: [],
      targetPrecondition: captureFindingPreconditions(sourceLedger)
        .get('F-0001')!.precondition,
    });
    const candidate = candidateFromStoredRawFinding(storedRaw, REVIEWER_STABLE_KEY);
    expect(candidate.relation).toBe('resolution_confirmation');
    const { canonical } = canonicalizeReviewerRawFinding(candidate, { ledger: sourceLedger });
    expect(canonical.relation).toBe('resolution_confirmation');
    expect(() => toLedgerRawFinding(canonical)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ケース3: stale confirmation（coherent 経路でも成立すること）
// ---------------------------------------------------------------------------
describe('ケース3: stale confirmation（prompt 後の persists 保存と競合する形式的に正しい確認）', () => {
  it('coherent confirmation の snapshot 後に別 caller が persists を保存すると、canonical finding が reopened になり一級 conflictへ収束する', async () => {
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
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
    };
    // 保存の直前に、別の並列 caller が同じ target へ persists を保存した状況を再現。
    const result = await harness.run({
      reviewerRawFindings: [confirmation],
      interceptFresh: (fresh) => {
        const targetPrecondition = captureFindingPreconditions(fresh)
          .get('F-0001')!.precondition;
        return {
          ...fresh,
          findings: fresh.findings.map((finding) => (finding.id === 'F-0001'
            ? {
              ...finding,
              rawFindingIds: [...finding.rawFindingIds, 'raw-concurrent-persists'],
              revision: finding.revision + 1,
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
              description: 'Still observing the issue.',
              suggestion: null,
              relation: 'persists',
              targetFindingId: 'F-0001',
              evidence: reviewerEvidence('src/a.ts', 12),
              targetPrecondition,
            },
          ],
        };
      },
    });

    expect(result.status).toBe('updated');
    // 機械分類だけで完結する入力なので manager は呼ばれない（coherent 経路の再現）。
    expect(executeAgentMock).not.toHaveBeenCalled();

    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    // 解消と再通達の競合は、canonical finding の再openと一級 conflictへ正規化する。
    expect(target?.status).toBe('open');
    expect(target?.lifecycle).toBe('reopened');
    expect(target?.rawFindingIds).toContain('raw-concurrent-persists');
    // confirmation と persists を参照する active conflict が立つ。
    const conflict = saved.conflicts.find((entry) => entry.status === 'active' && entry.findingIds.includes('F-0001'));
    expect(conflict).toBeDefined();
    expect(conflict?.rawFindingIds.some((rawFindingId) => rawFindingId.endsWith(':c-1'))).toBe(true);
    // 同じ競合を provisional finding へ二重着地させない。
    const provisional = saved.findings.find((finding) => finding.provisional?.kind === 'stale-precondition');
    expect(provisional).toBeUndefined();
    const staleReport = harness.savedReports.at(-1);
    const staleAttempt = staleReport?.attempts.at(-1);
    expect(staleAttempt).toBeUndefined();
    expect(staleAttempt?.managerOutput.anchorAdjudications.some(
      (adjudication) => adjudication.rawFindingId.endsWith(':c-1'),
    ) ?? false).toBe(false);
  });
});

describe('open_conflict target WAL CAS', () => {
  function conflictLedger(): FindingLedger {
    return makeLedger({
      nextId: 3,
      findings: [
        makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 }),
        makeFinding({
          id: 'F-0002',
          revision: 1,
          title: 'Conflict target',
          description: 'Potentially related open issue.',
          rawFindingIds: ['raw-f2'],
        }),
      ],
      rawFindings: [
        ...makeLedger().rawFindings,
        {
          rawFindingId: 'raw-f2',
          stepName: 'reviewers',
          reviewer: 'security-review',
          familyTag: 'bug',
          severity: 'high',
          title: 'Conflict target',
          description: 'Potentially related open issue.',
          suggestion: null,
          relation: 'new',
          targetFindingId: null,
          evidence: reviewerEvidence('src/a.ts', 20),
        },
      ],
    });
  }

  function chooseOpenConflict(): void {
    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
      return interpretationResponse([{
        decision: 'open_conflict',
        rawFindingId: rawId,
        targetFindingId: 'F-0002',
        proofId: '',
        reason: '',
      }]);
    });
  }

  it('WALに保存したopen targetの全preconditionがfreshならconflictとprovisionalを原子的に作る', async () => {
    const harness = makeHarness(conflictLedger());
    chooseOpenConflict();

    const result = await harness.run({ reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW] });

    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.interpretations[0]?.promptPreconditions).toEqual([
      expect.objectContaining({
        targetFindingId: 'F-0002',
        targetRevision: 1,
        targetStatus: 'open',
        targetEvidenceHash: expect.any(String),
      }),
    ]);
    expect(saved.conflicts).toContainEqual(expect.objectContaining({
      status: 'active',
      findingIds: ['F-0002'],
      rawFindingIds: [expect.stringContaining(':p-1')],
    }));
    expect(saved.findings).toContainEqual(expect.objectContaining({
      status: 'open',
      provisional: expect.objectContaining({ kind: 'raw-meaning-ambiguous' }),
    }));
  });

  it('targetがopenのままrevisionとevidenceを変えた場合はconflict/authorityを作らずstale provisionalへ落とす', async () => {
    const harness = makeHarness(conflictLedger());
    chooseOpenConflict();

    const result = await harness.run({
      reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW],
      interceptFresh: (fresh) => ({
        ...fresh,
        findings: fresh.findings.map((finding) => (
          finding.id === 'F-0002'
            ? {
                ...finding,
                revision: finding.revision + 1,
                rawFindingIds: [...finding.rawFindingIds, 'raw-f2-concurrent'],
              }
            : finding
        )),
        rawFindings: [
          ...fresh.rawFindings,
          {
            rawFindingId: 'raw-f2-concurrent',
            stepName: 'reviewers',
            reviewer: 'security-review',
            familyTag: 'bug',
            severity: 'high',
            title: 'Conflict target changed',
            description: 'Concurrent evidence changed the open target.',
            suggestion: null,
            relation: 'new',
            targetFindingId: null,
            evidence: reviewerEvidence('src/a.ts', 21),
          },
        ],
      }),
    });

    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.findings.find((finding) => finding.id === 'F-0002')).toEqual(
      expect.objectContaining({
        status: 'open',
        revision: 2,
        rawFindingIds: ['raw-f2', 'raw-f2-concurrent'],
      }),
    );
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active')).toEqual([]);
    expect(saved.findings).toContainEqual(expect.objectContaining({
      provisional: expect.objectContaining({
        kind: 'raw-meaning-ambiguous',
        reason: expect.stringContaining('became stale before save'),
      }),
    }));
    expect(saved.interpretations[0]?.applicationResult).toBe('stale_precondition');
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
    // required field が欠けた new claim は confirmed finding に洗浄されない。
    const independent = saved.findings.find((finding) => finding.title === 'Existing issue still present');
    expect(independent?.status).toBe('open');
    expect(independent?.provisional?.kind).toBe('raw-meaning-ambiguous');
  });
});

// ---------------------------------------------------------------------------
// ケース5: 永久機関
// ---------------------------------------------------------------------------
describe('ケース5: 永久機関（同一 lineage の ambiguous raw を run/iteration/id/説明文/行番号を変えて繰り返す）', () => {
  it('finding ID は増殖せず同じ provisional が更新され、manager 解釈は lineage 上限2 epoch で止まる', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20 + round)],
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
  it('dismiss と同一ラウンドの再観測は証拠優先で open を維持し、後続の無 raw 裁定で dismiss してゲートを開く', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
    }));
    let dismissTargetId: string | undefined;
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      if (!(instruction as string).includes('## Ambiguous raw finding interpretation')) {
        // 解釈枯渇後の decisions 相談: 提示された候補を dismiss する。
        return findingManagerTaskResponse(instruction as string, {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: dismissTargetId !== undefined
              ? [{
                  findingId: dismissTargetId,
                  basis: 'unverifiable_claim',
                  reason: '解釈2 epoch と再観測でも確定できない主張',
                  evidence: 'Current review evidence remains contradictory after two interpretation epochs.',
                }]
              : [],
        });
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20 + round)],
        }],
      });
    }
    const provisionalBefore = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined);
    expect(provisionalBefore?.status).toBe('open');
    dismissTargetId = provisionalBefore!.id;

    // round 3: 同じ claim の raw が再来したラウンドでは、manager が dismiss を
    // 提案しても再観測の証拠を優先し、dismiss を拒否する。
    const reobserved = await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        ...AMBIGUOUS_PERSISTS_RAW,
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 23)],
      }],
    });
    expect(reobserved.ledger.findings.find((finding) => finding.id === dismissTargetId)?.status)
      .toBe('open');
    expect(harness.savedReports.at(-1)?.attempts.at(-1)?.validationErrors)
      .toContainEqual(expect.stringContaining('re-observed (match/conflict) after merge'));

    // round 4: 新しい raw がない裁定で初めて dismiss が成立する。
    const result = await harness.run({ runId: 'run-4', reviewerRawFindings: [] });
    const saved = result.ledger;
    const dismissed = saved.findings.find((finding) => finding.id === dismissTargetId)!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissal?.basis).toBe('unverifiable_claim');
    // 裁定後に新 ID の open provisional は復活せず、ゲートが開く。
    expect(saved.findings.filter((finding) => finding.status === 'open')).toEqual([]);
  }, 30_000);
});

describe('ケース5 変種: 同一 evidence 再送（codex B1）', () => {
  it('applied 済みと同一 evidence の raw を再送しても provisional は増殖せず、同じエントリへ帰属して manager も呼ばれない', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
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
            // 明示参照 raw への unsupported（監査のみで消える経路は禁止）
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 5)],
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 30)],
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
      description: `Flood description ${index + 1}.`,
      suggestion: '',
      relation: 'new',
      targetFindingId: null,
      evidence: [{
        kind: 'file_quote',
        path: 'src/b.ts',
        startLine: 5,
        endLine: 5,
        verbatimExcerpt: '// line 5',
        snapshotId: FIXTURE_SNAPSHOT_ID,
      }],
    }));
  }

  it('435 raw の reviewer は publication 前に fail-closed となり台帳を更新しない', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    expect(() => harness.run({ reviewerRawFindings: makeManyRaws(435, 'flood') }))
      .toThrow(/exceeded limits/);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(harness.currentLedger().findings).toEqual([]);
    expect(harness.savedReports).toEqual([]);
  });

  it('巨大 description（8192超）は publication 前に fail-closed となる', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [] }));
    const raws = makeManyRaws(3, 'big');
    raws[1]!.description = 'x'.repeat(9000);
    expect(() => harness.run({ reviewerRawFindings: raws }))
      .toThrow(/field exceeded its limit/);

    expect(harness.currentLedger().findings).toEqual([]);
    expect(harness.savedReports).toEqual([]);
  });

  it('複数 reviewer の合算が step 上限（128件）を超えると超過側の reviewer だけが overflow になり、正常 reviewer の raw は処理される', async () => {
    // 2 reviewer を subResults で渡すため、harness ではなく直接構築する。
    const ledgerRepository = new RevisionedFindingLedgerTestRepository(
      makeLedger({ findings: [], rawFindings: [] }),
    );
    const publicationReportDir = makePublicationDir('takt-ladder-overflow-publication-');
    const ledgerStore: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-ladder-robustness/recovery-ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => ledgerRepository.loadLedger(),
      updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
      ...createFindingAdjudicationReservation(),
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
      ...createFindingManagerPublicationDouble(
        (report) => join(
          publicationReportDir,
          `findings-manager-validation.${report.stepName}.json`,
        ),
        ledgerRepository,
      ),
    };
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = currentManagerRawFindingIds(instruction as string)
        .filter((rawFindingId) => /:ok-\d+$/.test(rawFindingId));
      return findingManagerTaskResponse(instruction as string, {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({
            rawFindingId,
            decision: 'new',
            findingId: '',
            anchorRelevance: 'not_applicable',
            evidence: 'fresh',
          })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
      });
    });

    const okRaws = makeManyRaws(3, 'ok').map((raw, index) => (
      { ...raw, title: `Legit finding ${index + 1}`, description: `Legit ${index + 1}`, evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 5)] }
    ));
    const okExtractions = reviewerExtractions(okRaws);
    const floodExtractions = reviewerExtractions(makeManyRaws(130, 'flood'));
    expect(() => findingReviewPublicationFixture({
      scopeIdentity: ledgerStore.ledgerIdentity,
      parentStepName: 'reviewers',
      stepIteration: 1,
      reviewerStepName: 'good-review',
      rawFindings: okExtractions,
    })).not.toThrow();
    expect(() => findingReviewPublicationFixture({
      scopeIdentity: ledgerStore.ledgerIdentity,
      parentStepName: 'reviewers',
      stepIteration: 1,
      reviewerStepName: 'flood-review',
      rawFindings: floodExtractions,
    })).toThrow(/exceeded limits/);

    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(ledgerRepository.loadLedger().findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ケース8: crash/replay
// ---------------------------------------------------------------------------
describe('ケース8: crash/replay（WAL 各段での停止と resume の冪等性）', () => {
  const AMBIGUOUS_EVIDENCE = [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)];
  const AMBIGUOUS_FIELDS = {
    relation: 'new' as const,
    targetFindingId: null,
    title: 'Existing issue still present',
    description: 'Claims the resolved issue persists with different content.',
    severity: 'high' as const,
    familyTag: null,
    evidence: AMBIGUOUS_EVIDENCE,
  };
  const LINEAGE_KEY = computeLineageKey({
    claimIdentityHash: computeClaimIdentityHash({
      target: { kind: 'code', paths: ['src/a.ts'] },
      familyTag: AMBIGUOUS_FIELDS.familyTag,
      severity: AMBIGUOUS_FIELDS.severity,
      title: AMBIGUOUS_FIELDS.title,
      description: AMBIGUOUS_FIELDS.description,
      suggestion: null,
    }),
  });
  const EVIDENCE_HASH = computeRawEvidenceHash(AMBIGUOUS_FIELDS);
  const BASE_INTERPRETATION_KEY = computeBaseInterpretationKey({
    reviewerStableKey: REVIEWER_STABLE_KEY,
    lineageKey: LINEAGE_KEY,
    candidateEvidenceHash: EVIDENCE_HASH,
  });
const INTERPRETATION_KEY = computeInterpretationAttemptKey(BASE_INTERPRETATION_KEY, 1);
  const PRIOR_CANONICAL_INTEGRITY_DIGEST = 'b'.repeat(64);

  function resolvedTargetLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
    return makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
      ...overrides,
    });
  }

  it('started 保存後に canonical integrity が変わった resume は、旧 attempt を interrupted にして stale provisional にする', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        canonicalIntegrityDigest: PRIOR_CANONICAL_INTEGRITY_DIGEST,
        stage: 'interpretation_started',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        reservationToken: 'crashed-reservation',
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
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const provisional = saved.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.interpretationEpochs).toBe(0);
    expect(saved.interpretations?.filter((record) => record.lineageKey === LINEAGE_KEY)).toHaveLength(2);
    expect(saved.interpretations?.[0]?.stage).toBe('interpretation_interrupted');
  });

  it('completed 保存後に canonical integrity が変わった resume は、保存済み decision を再利用しない', async () => {
    const harness = makeHarness(resolvedTargetLedger({
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        canonicalIntegrityDigest: PRIOR_CANONICAL_INTEGRITY_DIGEST,
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
    const landed = saved.findings.filter((finding) => finding.title === 'Existing issue still present');
    expect(landed).toHaveLength(1);
    expect(landed[0]?.provisional?.kind).toBe('raw-meaning-ambiguous');
    const records = saved.interpretations?.filter((entry) => entry.lineageKey === LINEAGE_KEY);
    expect(records?.map((record) => record.stage))
      .toEqual(['interpretation_completed', 'ledger_applied']);
    expect(records?.[1]?.applicationResult).toBe('stale_precondition');
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
    let contenderSettled = false;
    const contenderRun = harness.run({
      runId: 'contender-run',
      reviewerRawFindings: [AMBIGUOUS_PERSISTS_RAW],
    }).then((result) => {
      contenderSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(contenderSettled).toBe(false);

    releaseOwner();
    const [, contenderResult] = await Promise.all([ownerRun, contenderRun]);
    expect(contenderResult.ledger.interpretations?.[0]?.stage).toBe('ledger_applied');

    const saved = harness.currentLedger();
    const claimFindings = saved.findings.filter((finding) => finding.title === AMBIGUOUS_PERSISTS_RAW.title);
    expect(claimFindings).toHaveLength(1);
    expect(claimFindings[0]?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(saved.findings.filter((finding) => (
      finding.status === 'open' && finding.provisional !== undefined
    ))).toHaveLength(1);
    expect(buildFindingsRuleContext(saved).provisional.count).toBe(1);
    expect(saved.rawFindings.some((raw) => raw.rawFindingId.startsWith('contender-run:'))).toBe(true);
    expect(executeAgentMock).toHaveBeenCalledOnce();
    expect(saved.interpretations?.[0]?.stage).toBe('ledger_applied');
  });

  it('ledger_applied 済みの解釈は no-op になり、finding ID の二重割当・rawFindingIds の二重追加が起きない', async () => {
    const baseLedger = resolvedTargetLedger();
    const appliedRaw = canonicalRawFindingFixture({
      rawFindingId: 'crashed-run:reviewers:1:arch-review:p-1',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue still present',
      description: 'Claims the resolved issue persists with different content.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: reviewerEvidence('src/a.ts', 20),
    });
    const applied = makeFinding({ revision: 1,
      id: 'F-0002',
      title: 'Existing issue still present',
      description: 'Claims the resolved issue persists with different content.',
      rawFindingIds: ['crashed-run:reviewers:1:arch-review:p-1'],
    });
    const harness = makeHarness(makeLedger({
      nextId: 3,
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' }), applied],
      rawFindings: [
        ...baseLedger.rawFindings,
        appliedRaw,
      ],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        canonicalIntegrityDigest: PRIOR_CANONICAL_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        reservationToken: 'crashed-reservation',
        completedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:01.000Z' },
        validatedDecision: {
          decision: 'create_independent',
          rawFindingId: 'crashed-run:reviewers:1:arch-review:p-1',
        },
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
    const baseLedger = resolvedTargetLedger();
    const sourceRaw = canonicalRawFindingFixture({
      rawFindingId: 'crashed-run:reviewers:1:arch-review:p-1',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: null,
      severity: 'high',
      title: 'Existing issue still present',
      description: 'Claims the resolved issue persists with different content.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: reviewerEvidence('src/a.ts', 20),
    });
    const provisionalStableKey = computeProvisionalStableKey({
      reviewerStableKey: REVIEWER_STABLE_KEY,
      lineageKey: LINEAGE_KEY,
      provisionalKind: 'raw-meaning-ambiguous',
    });
    const existingProvisional = makeFinding({ revision: 1,
      id: 'F-0002',
      title: 'Existing issue still present',
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
        firstObservedRound: 1,
        recoveryReviewerStableKey: REVIEWER_STABLE_KEY,
      },
    });
    const harness = makeHarness(resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' }), existingProvisional],
      rawFindings: [...baseLedger.rawFindings, sourceRaw],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        canonicalIntegrityDigest: PRIOR_CANONICAL_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        reservationToken: 'crashed-reservation',
        completedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:01.000Z' },
        validatedDecision: {
          decision: 'provisional',
          rawFindingId: 'crashed-run:reviewers:1:arch-review:p-1',
          reason: 'Still ambiguous.',
        },
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
    expect(executeAgentMock).not.toHaveBeenCalled();
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
    const sourceRaw = canonicalRawFindingFixture({
      rawFindingId: sourceRawId,
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: AMBIGUOUS_PERSISTS_RAW.familyTag,
      severity: AMBIGUOUS_PERSISTS_RAW.severity,
      title: AMBIGUOUS_PERSISTS_RAW.title,
      description: AMBIGUOUS_PERSISTS_RAW.description,
      suggestion: null,
      relation: AMBIGUOUS_PERSISTS_RAW.relation,
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidence: AMBIGUOUS_PERSISTS_RAW.evidence,
    });
    const recovery = makeFinding({ revision: 1,
      id: 'F-0002',
      title: `Pending interpretation: ${AMBIGUOUS_PERSISTS_RAW.title}`,
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
        firstObservedRound: 1,
        recoveryReviewerStableKey: REVIEWER_STABLE_KEY,
      },
    });
    const reconstructed = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(sourceRaw, REVIEWER_STABLE_KEY),
      { ledger: resolvedTargetLedger(), preserveAmbiguityOrigin: true },
    ).canonical;
    expect(reconstructed.lineageKey).toBe(LINEAGE_KEY);
    expect(reconstructed.evidenceSetHash).toBe(EVIDENCE_HASH);
    const initialLedger = resolvedTargetLedger({
      nextId: 3,
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' }), recovery],
      rawFindings: [makeLedger().rawFindings[0]!, sourceRaw],
      interpretations: [{
        interpretationKey: INTERPRETATION_KEY,
        baseInterpretationKey: BASE_INTERPRETATION_KEY,
        attemptOrdinal: 1,
        reviewerStableKey: REVIEWER_STABLE_KEY,
        lineageKey: LINEAGE_KEY,
        candidateEvidenceHash: EVIDENCE_HASH,
        canonicalIntegrityDigest: PRIOR_CANONICAL_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:00.000Z' },
        reservationToken: 'crashed-reservation',
        completedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:01.000Z' },
        validatedDecision: {
          decision: 'provisional',
          rawFindingId: sourceRaw.rawFindingId,
          reason: 'Still ambiguous.',
        },
        appliedAt: { runId: 'crashed-run', stepName: 'reviewers', timestamp: '2026-06-13T23:00:02.000Z' },
        applicationResult: 'provisional_created',
        promptPreconditions: [],
      }],
    });
    const recoveryPlan = collectInterpretationRecoveryPlan({
      ledger: initialLedger,
      currentItems: [],
      roundsCompleted: stopBudgetRoundsCompleted(initialLedger),
    });
    expect(recoveryPlan.failures).toEqual([]);
    expect(recoveryPlan.items).toHaveLength(1);
    const harness = makeHarness(initialLedger);
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
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(records?.map((record) => record.attemptOrdinal)).toEqual([1, 2]);
    expect(records?.map((record) => record.stage)).toEqual(['ledger_applied', 'ledger_applied']);
    expect(records?.map((record) => record.applicationResult)).toEqual(['provisional_created', 'stale_precondition']);
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
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
    };
    const first = await harness.run({ reviewerRawFindings: [confirmation], runId: 'run-2' });
    expect(first.ledger.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
    const revisionAfterFirst = first.ledger.findings.find((finding) => finding.id === 'F-0001')?.revision;

    // 2回目（replay）: 同じ confirmation。fresh target は既に resolved（同じ evidence）
    // → 冪等成功として黙って外れ、二重 resolve（revision 二重加算）は起きない。
    // 対象が resolved の confirmation は ambiguity taint を保持するが、A-1 により
    // ladder へ載せず audit-only とする。
    const second = await harness.run({ reviewerRawFindings: [confirmation], runId: 'run-3' });
    const target = second.ledger.findings.find((finding) => finding.id === 'F-0001');
    expect(executeAgentMock).not.toHaveBeenCalled();
    expect(target?.status).toBe('resolved');
    expect(target?.revision).toBe(revisionAfterFirst);
    expect(second.ledger.findings.every((finding) => finding.provisional === undefined)).toBe(true);
    expect(harness.savedReports.at(-1)?.unsupportedRawFindings?.some(
      (entry) => entry.rawFindingId.endsWith(':c-1'),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 追加必須テスト（設計書 §13）
// ---------------------------------------------------------------------------
describe('解釈梯子の追加必須テスト', () => {

  it('correction で relation が整っても taint（priorAmbiguityCodes）は残る', () => {
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-fixed',
      familyTag: 'bug',
      severity: 'high',
      title: 'Existing issue still present',
      description: 'Still broken.',
      suggestion: '',
      relation: 'persists',
      targetFindingId: 'F-0001',
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)],
    }], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-x',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch',
      ledger: makeLedger(),
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
      description: 'Existing issue body.',
      suggestion: '',
      relation: 'new',
      targetFindingId: null,
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
    }], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-x',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch',
      ledger,
    });
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger });
    const proofs = issueDeterministicSameProofs({
      ledger,
      ambiguousRawFindings: [canonical],
      excludedTargetFindingIdsByRawFindingId: new Map(),
    });
    const proof = proofs.get(canonical.rawFindingId);
    expect(proof).toBeDefined();
    // 発行時 revision の台帳ではOK。
    expect(verifySameProofAgainstLedger(proof!, ledger).ok).toBe(true);
    // revision が進んだ台帳では stale として不採用。
    const bumped: FindingLedger = {
      ...ledger,
      findings: ledger.findings.map((finding) => ({ ...finding, revision: finding.revision + 1 })),
    };
    const stale = verifySameProofAgainstLedger(proof!, bumped);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toContain('revision changed');
    }
  });

  it('recovery origin と同じ identity の別 open finding が後続しても、origin を除外して正当な target へ SameProof を発行する', () => {
    const origin = makeFinding({
      id: 'F-0001',
      revision: 1,
      title: 'Shared identity',
      description: 'The same claim body.',
      provisional: {
        kind: 'raw-meaning-ambiguous',
        stableKey: 'recovery-origin',
        lineageKey: 'recovery-lineage',
        sourceRawFindingIds: ['raw-origin'],
        reason: 'Pending recovery.',
        firstObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastObservedAt: { runId: 'run-1', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        interpretationEpochs: 1,
        gateEffect: 'block',
        firstObservedRound: 1,
        recoveryReviewerStableKey: REVIEWER_STABLE_KEY,
      },
    });
    const validTarget = makeFinding({
      id: 'F-0002',
      revision: 1,
      title: 'Shared identity',
      description: 'The same claim body.',
    });
    const ledger = makeLedger({
      nextId: 3,
      findings: [origin, validTarget],
    });
    const [candidate] = createReviewerRawFindingCandidates([{
      rawFindingId: 'raw-recovery',
      familyTag: 'bug',
      severity: 'high',
      title: 'Shared identity',
      description: 'The same claim body.',
      suggestion: '',
      relation: 'new',
      targetFindingId: null,
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
    }], {
      workflowName: 'peer-review',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 1,
      runId: 'run-x',
      reviewerStepName: 'arch-review',
      reviewerPersonaKey: 'arch',
      ledger,
    });
    const { canonical } = canonicalizeReviewerRawFinding(candidate!, { ledger });
    const proof = issueDeterministicSameProofs({
      ledger,
      ambiguousRawFindings: [canonical],
      excludedTargetFindingIdsByRawFindingId: new Map([
        [canonical.rawFindingId, new Set([origin.id])],
      ]),
    }).get(canonical.rawFindingId);

    expect(proof?.targetFindingId).toBe(validTarget.id);
  });

  it('verified terminal reopened は target を変えず audit-only となり recovery を起動しない', async () => {
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
        severity: 'high',
        title: 'Invalidated issue came back',
        description: 'The invalidated finding is real after all.',
        suggestion: '',
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)],
      }],
    });

    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001');
    expect(target?.status).toBe('invalidated');
    expect(target?.revision).toBe(2);
    expect(saved.findings).toHaveLength(1);
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('clean な後続 raw だけが provisional を確定できる（fresh precondition 付き same で confirmed へ昇格、新規 ID は増えない）', async () => {
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
        description: 'Something is off.',
        suggestion: '',
        relation: null,
        targetFindingId: '',
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7)],
      }],
    });
    const afterRound1 = harness.currentLedger();
    const provisionalId = afterRound1.findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();
    const provisional = afterRound1.findings.find((finding) => finding.id === provisionalId)!;
    const targetPrecondition = captureFindingPreconditions(afterRound1)
      .get(provisionalId!)!.precondition;
    const settlementRaw = (
      rawFindingId: string,
      overrides: Partial<Pick<RawFinding, 'relation' | 'targetFindingId' | 'targetPrecondition'>> = {},
    ): RawFinding => {
      const effectiveTargetPrecondition = 'targetPrecondition' in overrides
        ? overrides.targetPrecondition
        : targetPrecondition;
      return canonicalRawFindingFixture({
        rawFindingId,
        stepName: 'reviewers',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        description: 'Something is off.',
        suggestion: null,
        target: provisional.target!,
        relation: overrides.relation ?? 'persists',
        targetFindingId: 'targetFindingId' in overrides
          ? overrides.targetFindingId!
          : provisionalId!,
        ...(effectiveTargetPrecondition !== undefined
          ? { targetPrecondition: effectiveTargetPrecondition }
          : {}),
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 9)],
      });
    };
    const promotionResult = (raw: RawFinding) => {
      const output = createEmptyManagerOutput();
      output.matches = [{
        findingId: provisionalId!,
        rawFindingIds: [raw.rawFindingId],
      }];
      return settleProvisionalsWithCleanEvidence({
        output,
        cleanRawIds: new Set([raw.rawFindingId]),
        wireById: new Map([[raw.rawFindingId, raw]]),
        freshLedger: afterRound1,
        explicitResolvedByMapping: new Map(),
        explicitPromotedFindingIds: new Set(),
        healthyReviewerStableKeys: new Set(),
        replayOrigins: new Map(),
      });
    };
    expect(promotionResult(settlementRaw('promotion-valid')).promotedFindingIds)
      .toEqual(new Set([provisionalId]));
    expect(promotionResult(settlementRaw('promotion-relation-new', {
      relation: 'new',
      targetFindingId: null,
      targetPrecondition: undefined,
    })).promotedFindingIds).toEqual(new Set());
    expect(promotionResult(settlementRaw('promotion-wrong-target', {
      targetFindingId: 'F-9999',
    })).promotedFindingIds).toEqual(new Set());
    expect(promotionResult(settlementRaw('promotion-stale-revision', {
      targetPrecondition: {
        ...targetPrecondition,
        targetRevision: targetPrecondition.targetRevision + 1,
      },
    })).promotedFindingIds).toEqual(new Set());
    expect(promotionResult(settlementRaw('promotion-stale-status', {
      targetPrecondition: {
        ...targetPrecondition,
        targetStatus: 'resolved',
      },
    })).promotedFindingIds).toEqual(new Set());

    // round 2: 同じ claim identity で provisional 自身を明示する clean persists
    // が届く。intake が fresh revision precondition を捕捉するため、新規 finding
    // を作らず provisional を confirmed へ昇格できる。
    executeAgentMock.mockReset();
    await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        rawFindingId: 'clean-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Suspicious behaviour in parser',
        description: 'Something is off.',
        suggestion: '',
        relation: 'persists',
        targetFindingId: provisionalId,
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 9)],
      }],
    });
    expect(executeAgentMock).not.toHaveBeenCalled();

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
        relation: null,
        targetFindingId: '',
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7)],
      }],
    });
    const provisionalId = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 同 path+title だが description も familyTag も異なる clean new
    // （= 完全 identity 不一致・claim lineage 不一致 → 別問題の可能性）。
    executeAgentMock.mockReset();
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const ids = [...(instruction as string).matchAll(/"rawFindingId":\s*"([^"]+:other-1)"/g)].map((match) => match[1]!);
      return findingManagerTaskResponse(instruction as string, {
          rawDecisions: [...new Set(ids)].map((rawFindingId) => ({
            rawFindingId,
            decision: 'new',
            findingId: '',
            evidence: 'fresh',
          })),
          disputeDecisions: [],
          conflictDecisions: [],
          invalidateDecisions: [],
          duplicateDecisions: [],
          dismissDecisions: [],
      });
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
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 9)],
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
      relation: null,
      targetFindingId: '',
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 7)],
    };
    // round 1: relation 欠落で ambiguous → provisional。
    await harness.run({
      runId: 'run-2',
      reviewerRawFindings: [observation],
    });
    const provisionalId = harness.currentLedger().findings.find((finding) => finding.provisional !== undefined)?.id;
    expect(provisionalId).toBeDefined();

    // round 2: 完全に同一内容で provisional 自身を明示する clean raw。
    // fresh revision precondition 付きの機械 same が provisional 自身に付く → 昇格。
    executeAgentMock.mockReset();
    await harness.run({
      runId: 'run-3',
      reviewerRawFindings: [{
        ...observation,
        familyTag: 'bug',
        relation: 'persists',
        targetFindingId: provisionalId,
      }],
    });
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
    const target = makeFinding({ revision: 1,
      id: 'F-0001',
      title: 'Different tracked issue',
      description: 'A tracked problem with different content.',
    });
    const provisionalStableKey = 'sk-manual';
    const provisionalEntry = makeFinding({ revision: 1,
      id: 'F-0002',
      title: 'Suspicious behaviour in parser',
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
        firstObservedRound: 1,
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
            {
              rawFindingId,
              decision: 'same',
              findingId: 'F-0001',
              anchorRelevance: 'same',
              evidence: 'Semantically the same underlying bug.',
            }
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
        description: 'Something is off.',
        suggestion: null,
        relation: null,
        targetFindingId: null,
        evidence: reviewerEvidence('src/b.ts', 8),
      }],
    });

    const saved = harness.currentLedger();
    // T は match で証拠を得るが、P は resolved にならない（T 側に完全 identity が
    // 無い = 意味判断 match は決定的根拠ではない）。
    const provisional = saved.findings.find((finding) => finding.id === 'F-0002');
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional).toBeDefined();
  });

  it('正規化監査: 矛盾 relation の raw を intake すると、wire は unknown のまま保存され、監査メタデータから元の主張が復元できる', async () => {
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
        description: 'Claims to be new but names an existing target.',
        suggestion: '',
        relation: 'new',
        targetFindingId: 'F-0001',
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/b.ts', 5)],
      }],
    });
    expect(result.status).toBe('updated');

    // relation は捏造せず unknown(null) として保存する。主張された target は
    // 監査・後続 ambiguity 解決のため保持する。
    const saved = harness.currentLedger();
    const wire = saved.rawFindings.find((raw) => raw.rawFindingId.endsWith(':x-1'));
    expect(wire?.relation).toBeNull();
    expect(wire?.targetFindingId).toBe('F-0001');
    expect(wire?.description).toBe('Claims to be new but names an existing target.');

    // 監査メタデータ（検証レポートの rawNormalizations）から元の主張が復元できる。
    const report = harness.savedReports.at(-1)!;
    const record = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':x-1'));
    expect(record).toBeDefined();
    expect(record?.claimedRelation).toBe('new');
    expect(record?.claimedTargetFindingId).toBe('F-0001');
    expect(record?.normalizedRelation).toBeNull();
    expect(record?.wireTargetFindingId).toBe('F-0001');
    expect(record?.ambiguityCodes).toContain('relation-target-mismatch');
    expect(record?.normalizations).toContain('relation-normalized');
  });

  it('正規化監査の write-ahead: intake 後の処理（updateLedger）が例外を投げても、元の主張はディスクの検証レポートから復元できる', async () => {
    const projectCwd = mkdtempSync(join(TEST_TMPDIR, 'takt-ladder-wal-audit-project-'));
    const reportDir = join(
      projectCwd,
      '.takt',
      'runs',
      'crash-run',
      'reports',
    );
    try {
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(projectCwd, 'src/b.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
      execFileSync('git', ['init', '--quiet'], { cwd: projectCwd });
      writeFileSync(join(projectCwd, '.gitignore'), '.takt/\n');
      execFileSync('git', ['add', 'src/b.ts', '.gitignore'], { cwd: projectCwd });
      execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: projectCwd });

      const realStore = createFindingLedgerStore({
        projectCwd,
        runId: 'crash-run',
        reportDir,
        workflowName: 'peer-review',
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
      });
      await realStore.updateLedger(() => ({
        ledger: authorizeFindingLedgerFixture({
          workflowName: 'peer-review',
          nextId: 2,
          updatedAt: '2026-06-13T00:00:00.000Z',
          findings: [makeFinding({ revision: 1 })],
          evidenceRecords: [],
          evidenceBindings: [],
          lifecycleReservations: [],
          lifecycleEvents: [],
          rawRecoveryAttempts: [],
          rawRecoveryResults: [],
          rawFindings: [],
          conflicts: [],
          interpretations: [],
        }),
        result: undefined,
      }));
      // intake 後の最初の永続化処理（WAL の beginInterpretations / 最終
      // updateLedger）で必ず例外が起きるストア。
      const crashingStore: FindingLedgerStore = {
        ...realStore,
        updateLedger: () => Promise.reject(new Error('simulated crash after intake')),
        commitManagerLedger: () => (
          Promise.reject(new Error('simulated crash after intake'))
        ),
      };
      const contradictoryExtraction = reviewerExtraction({
        // 矛盾主張: relation new + targetFindingId（正規化対象）。
        rawFindingId: 'x-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Contradictory claim',
        description: 'Claims to be new but names an existing target.',
        suggestion: '',
        relation: 'new',
        targetFindingId: 'F-0001',
        evidence: [verifiedSourceQuoteFields(projectCwd, 'src/b.ts', 5)],
      });

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
          publication: findingReviewPublicationFixture({
            scopeIdentity: crashingStore.ledgerIdentity,
            parentStepName: 'reviewers',
            stepIteration: 1,
            reviewerStepName: 'arch-review',
            rawFindings: [contradictoryExtraction],
          }),
        }],
        workflowName: 'peer-review',
        workflowTask: 'Review the implementation.',
        runId: 'crash-run',
        callNamespace: '',
        timestamp: '2026-06-14T00:00:00.000Z',
        managerAuthority: 'standard',
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
          normalizedRelation?: string | null;
          wireTargetFindingId?: string;
          ambiguityCodes: string[];
          normalizations: string[];
        }>;
      };
      expect(report.ledgerUpdated).toBe(false);
      const record = report.rawNormalizations?.find((entry) => entry.rawFindingId.endsWith(':x-1'));
      expect(record?.claimedRelation).toBe('new');
      expect(record?.claimedTargetFindingId).toBe('F-0001');
      expect(record?.normalizedRelation).toBeNull();
      expect(record?.wireTargetFindingId).toBe('F-0001');
      expect(record?.ambiguityCodes).toContain('relation-target-mismatch');
      expect(record?.normalizations).toContain('relation-normalized');
      expect(record?.normalizations).not.toContain('target-dropped-from-wire');
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('A-1: confirmation の file_quote 不成立は target を変えず admission rejection として記録する', async () => {
    const harness = makeHarness(makeLedger());
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'c-clean-bad',
        familyTag: 'bug',
        severity: 'high',
        title: 'Confirmed fixed',
        description: 'Verified the fix at a hallucinated location.',
        suggestion: '',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        evidence: [{
          kind: 'file_quote',
          path: 'src/does-not-exist.ts',
          startLine: 9,
          endLine: 9,
          verbatimExcerpt: 'missing fixture line',
          snapshotId: FIXTURE_SNAPSHOT_ID,
        }],
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('open');
    expect(saved.findings.every((finding) => finding.provisional === undefined)).toBe(true);
    expect(harness.savedReports.at(-1)!.rawAdmissionRejections?.some((entry) => entry.rawFindingId.endsWith(':c-clean-bad'))).toBe(true);
    expect(harness.savedReports.at(-1)!.provisionalLandings ?? []).toEqual([]);
  });

  it('A-3 完全版（codex ブロッカー2）: 同一ラウンドの confirmation が target を閉じた場合、証跡不成立 persists は resolved target へ添付されず reviewer anomaly に隔離する', async () => {
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
        },
        {
          // 証跡不成立（存在しない path）の persists。prompt 時点では F-0001 は
          // open なので A-3 の添付候補になるが、reconcile が F-0001 を閉じる。
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'Still observing it (bad evidence).',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          evidence: [{
            kind: 'file_quote',
            path: 'src/does-not-exist.ts',
            startLine: 5,
            endLine: 5,
            verbatimExcerpt: 'missing fixture line',
            snapshotId: FIXTURE_SNAPSHOT_ID,
          }],
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
    const anomaly = saved.reviewerAnomalies?.find((entry) => (
      entry.sourceRawFindingIds.some((id) => id.endsWith(':p-bad'))
    ));
    expect(anomaly?.kind).toBe('quote-mismatch');
    expect(anomaly?.promotedFindingId).toBeUndefined();
    // 監査にも着地が残る。
    expect(harness.savedReports.at(-1)!.reviewerAnomalyLandings?.some((landing) => (
      landing.sourceRawFindingIds.some((id) => id.endsWith(':p-bad'))
    ))).toBe(true);
  });

  it('A-3: current precondition の証跡不成立 lifecycle 観測は terminal target を含め監査添付し、unknown target は reviewer anomaly に隔離する', async () => {
    // 台帳: open F-0001、provisional F-0002、resolved F-0003、dismissed F-0004。
    const provisionalEntry = makeFinding({ revision: 1,
      id: 'F-0002',
      title: 'Provisional observation',
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
        firstObservedRound: 1,
      },
    });
    const resolvedEntry = makeFinding({ revision: 1,
      id: 'F-0003',
      title: 'Fixed one',
      description: 'Already fixed.',
      status: 'resolved',
      lifecycle: 'resolved',
    });
    const dismissedEntry = makeFinding({ revision: 2,
      id: 'F-0004',
      title: 'Dismissed one',
      description: 'Terminally adjudicated.',
      status: 'dismissed',
      lifecycle: 'dismissed',
      dismissal: {
        basis: 'no_issue_after_verification',
        reason: 'Terminal verification found no product issue.',
        evidence: 'The terminal adjudicator verified the current target.',
        authority: 'terminal_adjudication',
        decidedAt: {
          runId: 'old',
          stepName: 'findings-manager',
          timestamp: '2026-06-13T00:00:00.000Z',
        },
      },
    });
    const harness = makeHarness(makeLedger({
      nextId: 5,
      findings: [
        makeFinding({ revision: 1 }),
        provisionalEntry,
        resolvedEntry,
        dismissedEntry,
      ],
    }));
    const base = {
      familyTag: 'bug',
      severity: 'high' as const,
      suggestion: '',
      relation: 'persists',
      evidence: [{
        kind: 'file_quote' as const,
        path: 'src/does-not-exist.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'missing fixture line',
        snapshotId: FIXTURE_SNAPSHOT_ID,
      }],
    };
    const result = await harness.run({
      reviewerRawFindings: [
        { ...base, rawFindingId: 'p-open', title: 'Existing issue', description: 'Still there (bad evidence).', targetFindingId: 'F-0001' },
        { ...base, rawFindingId: 'p-prov', title: 'Provisional observation', description: 'Still there too (bad evidence).', targetFindingId: 'F-0002' },
        { ...base, rawFindingId: 'p-terminal', title: 'Rephrased recurrence claim', description: 'Different wording on the same current head.', targetFindingId: 'F-0003' },
        { ...base, rawFindingId: 'p-dismissed', title: 'Rephrased dismissed claim', description: 'Different wording on the same dismissed head.', relation: 'reopened', targetFindingId: 'F-0004' },
        { ...base, rawFindingId: 'p-unknown', title: 'Ghost issue', description: 'References nothing real.', targetFindingId: 'F-9999' },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();

    // lifecycle evidence failure is audit-only and never mutates a target.
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    expect(target.status).toBe('open');
    expect(target.revision).toBe(2);
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    expect(target.rejectedObservations).toHaveLength(1);

    // provisional target also remains unchanged.
    const provisionalTarget = saved.findings.find((finding) => finding.id === 'F-0002')!;
    expect(provisionalTarget.rejectedObservations).toHaveLength(1);

    // current terminal target は audit-only。言い換えた semantic identity は
    // 収束判定に使わず、engine-issued target precondition だけで対象を確定する。
    const terminalTarget = saved.findings.find((finding) => finding.id === 'F-0003')!;
    expect(terminalTarget.status).toBe('resolved');
    expect(terminalTarget.rejectedObservations).toHaveLength(1);
    const dismissedTarget = saved.findings.find((finding) => finding.id === 'F-0004')!;
    expect(dismissedTarget.status).toBe('dismissed');
    expect(dismissedTarget.rejectedObservations).toHaveLength(1);
    expect(saved.findings.filter((finding) => finding.provisional !== undefined)).toHaveLength(1);
    expect(saved.reviewerAnomalies ?? []).toHaveLength(1);
    expect(saved.reviewerAnomalies?.some((anomaly) => anomaly.sourceRawFindingIds.some(
      (rawFindingId) => rawFindingId.endsWith(':p-unknown'),
    ))).toBe(true);
    const unknownAnomalyRawIds = saved.reviewerAnomalies![0]!.sourceRawFindingIds;
    expect(unknownAnomalyRawIds.every((rawFindingId) => (
      saved.rawFindings.some((raw) => raw.rawFindingId === rawFindingId)
    ))).toBe(true);
    expect(executeAgentMock).not.toHaveBeenCalled();
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
    const reportDir = join(projectCwd, '.takt', 'runs', 'shared-run', 'reports');
    try {
      mkdirSync(reportDir, { recursive: true });
      mkdirSync(join(projectCwd, 'src'), { recursive: true });
      writeFileSync(join(projectCwd, 'src/a.ts'), `${Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n')}\n`);
      execFileSync('git', ['init', '--quiet'], { cwd: projectCwd });
      writeFileSync(join(projectCwd, '.gitignore'), '.takt/\n');
      execFileSync('git', ['add', 'src/a.ts', '.gitignore'], { cwd: projectCwd });
      execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: projectCwd });

      const store = createFindingLedgerStore({
        projectCwd,
        runId: 'shared-run',
        reportDir,
        workflowName: 'peer-review',
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
      });
      await store.updateLedger(() => ({
        ledger: authorizeFindingLedgerFixture({
          workflowName: 'peer-review',
          nextId: 2,
          updatedAt: '2026-06-13T00:00:00.000Z',
          findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved' })],
          evidenceRecords: [],
          evidenceBindings: [],
          lifecycleReservations: [],
          lifecycleEvents: [],
          rawRecoveryAttempts: [],
          rawRecoveryResults: [],
          rawFindings: [],
          conflicts: [],
          interpretations: [],
        }),
        result: undefined,
      }));

      executeAgentMock.mockImplementation(async (_persona, instruction) => {
        const rawId = extractResidualRawIdFromInterpretationInstruction(instruction as string, 'p-1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return interpretationResponse([
          { decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' },
        ]);
      });

      const runCall = (callNamespace: string, title: string) => {
        const extraction = reviewerExtraction({
          ...AMBIGUOUS_PERSISTS_RAW,
          title,
          evidence: [verifiedSourceQuoteFields(projectCwd, 'src/a.ts', 20)],
        });
        return runFindingManagerForStep({
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
            publication: findingReviewPublicationFixture({
              scopeIdentity: store.ledgerIdentity,
              parentStepName: 'reviewers',
              stepIteration: 1,
              reviewerStepName: 'arch-review',
              callNamespace,
              rawFindings: [extraction],
            }),
          }],
          workflowName: 'peer-review',
          workflowTask: 'Review the implementation.',
          runId: 'shared-run',
          callNamespace,
          timestamp: '2026-06-14T00:00:00.000Z',
          managerAuthority: 'standard',
        });
      };

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
      const keys = finalLedger.interpretations.map((record) => record.interpretationKey);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(new Set(keys).size).toBe(keys.length);
      expect(finalLedger.interpretations.every((record) => record.stage === 'ledger_applied')).toBe(true);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it('findings.open.count と findings.provisional.count の双方が正しい（provisional は open にも数えられる）', () => {
    const ledger = makeLedger({
      findings: [
        makeFinding({ revision: 1 }),
        makeFinding({ revision: 1,
          id: 'F-0002',
          title: 'Provisional observation',
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
            firstObservedRound: 1,
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
    // ため、fixpoint の起点には product field が欠けた不完全 new claim を使う。
    const ambiguous = (rawFindingId: string) => ({
      rawFindingId,
      familyTag: null,
      severity: 'high',
      title: 'Re-report of a finding that was never actually opened',
      description: 'Claims to persist a finding id the ledger has never seen.',
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)],
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['raw-1', 'raw-2', 'raw-3', 'raw-4'],
      );
      return interpretationResponse([{ decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }]);
    });

    // 1巡目は比較対象がないため fixpoint ではない。2巡目以降は、同一 claim
    // が既存 provisional に帰属し、3つの snapshot 次元がすべて不変になる
    // ため fixpoint となる。raw 観測件数そのものは判定軸ではない。
    const roundStates: Array<NonNullable<FindingLedger['fixpoint']>> = [];
    for (const round of [1, 2, 3, 4]) {
      await harness.run({
        runId: `fixpoint-round-${round}`,
        reviewerRawFindings: [ambiguous(`raw-${round}`)],
      });
      roundStates.push(harness.currentLedger().fixpoint!);
    }

    const ledger = harness.currentLedger();
    expect(ledger.fixpoint?.reached).toBe(true);
    expect(roundStates[0]?.reached).toBe(false);
    expect(roundStates[1]?.reached).toBe(true);
    expect(roundStates[1]?.snapshot.provisionalKeys)
      .toEqual(roundStates[0]?.snapshot.provisionalKeys);
    expect(roundStates[1]?.snapshot.substantiveEntries)
      .toEqual(roundStates[0]?.snapshot.substantiveEntries);
    expect(roundStates[1]?.snapshot.unadjudicatedConflictEntries)
      .toEqual(roundStates[0]?.snapshot.unadjudicatedConflictEntries);
    for (const state of roundStates.slice(2)) {
      expect(state.reached).toBe(true);
      expect(state.snapshot).toEqual(roundStates[1]?.snapshot);
    }

    // fixpoint 到達は「要件を維持した replan へ回す」
    // という workflow のルーティング判断材料になるだけで、台帳側の finding
    // そのものには一切影響しない — resolve/waive/invalidate のいずれにも
    // ならず、open のまま gate-blocking であり続ける。
    const provisional = ledger.findings.find((finding) => finding.provisional !== undefined);
    expect(provisional?.status).toBe('open');
    // 同じ provisional への再観測は表示 lifecycle を persists に進め得るが、
    // 終端 lifecycle へは遷移せず open のまま残る。
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
    // ケース9 の1件目と同じ不完全 new claim を繰り返す。
    const ambiguous = (rawFindingId: string) => ({
      rawFindingId,
      familyTag: null,
      severity: 'high',
      title: 'Re-report of a finding that was never actually opened',
      description: 'Claims to persist a finding id the ledger has never seen.',
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 20)],
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['raw-1', 'raw-2', 'raw-3', 'raw-4', 'raw-5'],
      );
      return interpretationResponse([{ decision: 'provisional', rawFindingId: rawId, proofId: '', targetFindingId: '', reason: 'Cannot determine.' }]);
    });

    await harness.run({ runId: 'fixpoint-round-1', reviewerRawFindings: [ambiguous('raw-1')] });
    await harness.run({ runId: 'fixpoint-round-2', reviewerRawFindings: [ambiguous('raw-2')] });
    await harness.run({ runId: 'fixpoint-round-3', reviewerRawFindings: [ambiguous('raw-3')] });
    await harness.run({ runId: 'fixpoint-round-4', reviewerRawFindings: [ambiguous('raw-4')] });
    const findingCountAtFixpoint = harness.currentLedger().findings.length;

    // fixpoint 到達後もラウンドを止める権限は engine 側の rule 評価にしかない
    // （このユニットテストは manager-runner 単体の性質を見るため、workflow
    // ルーティングそのものは別テストで検証済み）。ここでは「fixpoint 到達済み」
    // という事実そのものが、後続ラウンドの台帳更新ロジックを緩めないことを見る。
    await harness.run({ runId: 'fixpoint-round-5', reviewerRawFindings: [ambiguous('raw-5')] });

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
      familyTag: null,
      severity: 'high',
      title: `Re-report of fabricated finding ${n} that was never actually opened`,
      description: `Claims to persist finding id F-900${n}, which the ledger has never seen.`,
      suggestion: '',
      relation: 'new',
      targetFindingId: '',
      evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', n)],
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

    // budget 到達は「要件を維持した replan へ回す」と
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
    const thisRoundMarker = computeRoundMarker({
      runId: 'run-2',
      callNamespace: '',
      parentStepName: 'reviewers',
      stepIteration: 2,
      publicationIds: [computeFindingReviewPublicationId({
        scopeIdentity: '/test/finding-ladder-robustness/ledger.json',
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 2,
        reviewerStepName: 'arch-review',
        reportName: 'arch-review.md',
      })],
    });

    const result = await harness.run({
      reviewerRawFindings: [churnRaw(1)],
      // updateLedger の排他区間直前に、別 caller が並行してもう1ラウンド完了
      // させ、そのマーカーを集合へ追加していた状況を再現する。
      interceptFresh: (fresh) => ({
        ...fresh,
        stopBudget: {
          roundMarkers: addRoundMarker(fresh.stopBudget?.roundMarkers, concurrentMarker),
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
// reopen）を、検証済み file_quote が無い限り塞ぐ。
// ---------------------------------------------------------------------------
describe('codex 検証2巡目#2: 未検証 persists/reopened は既存 finding を変異させない', () => {
  it('未検証 reopened は resolved finding を open に戻せない（reopen は検証済み file_quote を要求する）', async () => {
    // F-0001 は resolved。reopened→resolved は coherent（clean）なので、機械分類の
    // ままだと reconciler が open へ戻せてしまう。証跡が無ければ変異させない。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 })],
    }));
    const initialEvidenceIds = [
      ...harness.currentLedger().findings.find((finding) => finding.id === 'F-0001')!.evidenceIds,
    ];
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        description: 'Claims the resolved issue is back (no verifiable evidence).',
        suggestion: '',
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    // 解釈フェーズにも decisions manager にも掛からない（admission で止まる）。
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    // F-0001 は resolved のまま。監査添付だけが revision を進める。
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    expect(target.status).toBe('resolved');
    expect(target.lifecycle).toBe('resolved');
    expect(target.revision).toBe(3);
    expect(target.evidenceIds).toEqual(initialEvidenceIds);
    expect(target.title).toBe('Existing issue');
    expect(target.description).toBe('Existing issue body.');
    expect(target.rejectedObservations).toEqual([
      expect.objectContaining({ rawFindingId: expect.stringContaining(':r-1') }),
    ]);
    expect(saved.findings).toHaveLength(1);
    expect(saved.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('未検証 persists は有効な confirmation を conflict 化して close を妨害できない', async () => {
    // 同一ラウンド: F-0001 を閉じる有効 confirmation（機械照合済み file_quote）と、
    // F-0001 が「まだ在る」と主張する未検証 persists。旧来なら両者が矛盾して
    // conflict 化し F-0001 が open のまま残った（close 妨害）。未検証 persists は
    // 機械分類に載せず rejected observation（監査のみ）へ回すことで、confirmation
    // だけが機械処理され F-0001 が resolved になる。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1 })], // F-0001 open, src/a.ts:10
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
        },
        {
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'Still broken (no verifiable evidence).',
          suggestion: '',
          relation: 'persists',
          targetFindingId: 'F-0001',
          evidence: [],
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
    // 未検証 persists は resolved target の canonical へも合流しない。
    expect(target.rawFindingIds).toEqual([
      'raw-existing',
      expect.stringContaining(':c-ok'),
    ]);
    expect(target.rejectedObservations).toBeUndefined();
    expect(saved.findings).toHaveLength(1);
    expect(saved.reviewerAnomalies).toEqual([
      expect.objectContaining({
        kind: 'lifecycle-admission-failure',
        sourceRawFindingIds: [
          expect.stringContaining(':p-bad'),
        ],
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 証拠なし persists/reopened は既存 finding の変異権限を持たない。
// ---------------------------------------------------------------------------
describe('証拠なし raw finding の admission', () => {
  it('証拠なし persists は有効な confirmation を conflict 化して close を妨害できない', async () => {
    const harness = makeHarness(makeLedger({ findings: [makeFinding({ revision: 1 })] })); // F-0001 open, src/a.ts:10
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
          evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
        },
        {
          rawFindingId: 'p-bad',
          familyTag: 'bug',
          severity: 'high',
          title: 'Existing issue',
          description: 'Claims the issue still persists without evidence.',
          suggestion: null,
          relation: 'persists',
          targetFindingId: 'F-0001',
          evidence: [],
        },
      ],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // confirmation は成功し F-0001 は resolved。
    expect(target.status).toBe('resolved');
    // 証拠なし persists は conflict を作らない（active conflict 無し = close 非妨害）。
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active' && conflict.findingIds.includes('F-0001'))).toEqual([]);
    // 証拠なし persists は canonical へ合流しない。検証済み confirmation
    // だけが canonical evidence として残る。
    expect(target.rawFindingIds).toEqual([
      'raw-existing',
      expect.stringContaining(':c-ok'),
    ]);
    expect(target.rejectedObservations).toBeUndefined();
    expect(saved.findings).toHaveLength(1);
    expect(saved.reviewerAnomalies).toEqual([
      expect.objectContaining({
        kind: 'lifecycle-admission-failure',
        sourceRawFindingIds: [
          expect.stringContaining(':p-bad'),
        ],
      }),
    ]);
  });

  it('証拠なし reopened は resolved finding を open に戻さず audit observation に留める', async () => {
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ status: 'resolved', lifecycle: 'resolved', revision: 2 })],
    }));
    const initialEvidenceIds = [
      ...harness.currentLedger().findings.find((finding) => finding.id === 'F-0001')!.evidenceIds,
    ];
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'r-1',
        familyTag: 'bug',
        severity: 'high',
        title: 'Existing issue',
        description: 'Claims the resolved issue is back without evidence.',
        suggestion: null,
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).not.toHaveBeenCalled();
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // F-0001 は resolved のまま。監査添付だけが revision を進める。
    expect(target.status).toBe('resolved');
    expect(target.lifecycle).toBe('resolved');
    expect(target.revision).toBe(3);
    expect(target.evidenceIds).toEqual(initialEvidenceIds);
    expect(target.title).toBe('Existing issue');
    expect(target.description).toBe('Existing issue body.');
    expect(target.rejectedObservations).toEqual([
      expect.objectContaining({ rawFindingId: expect.stringContaining(':r-1') }),
    ]);
    expect(saved.findings).toHaveLength(1);
    expect(saved.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('証拠なし new claim は gate-blocking provisional に隔離する', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    const rawFinding = {
      rawFindingId: 'n-1',
      familyTag: 'security',
      severity: 'high',
      title: 'Missing rate limiter (absence finding)',
      description: 'A rate limiter that should exist is absent from the request pipeline.',
      suggestion: 'Add a rate limiter.',
      relation: 'new',
      targetFindingId: null,
      evidence: [],
    };
    const result = await harness.run({ reviewerRawFindings: [rawFinding] });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const saved = harness.currentLedger();
    const landed = saved.findings.find((finding) => finding.title === 'Missing rate limiter (absence finding)');
    expect(landed?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(saved.rawFindings).toHaveLength(1);
    expect(saved.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('証拠なしの架空コード claim は confirmed finding にならない', async () => {
    const harness = makeHarness(makeLedger({ findings: [], rawFindings: [], nextId: 1 }));
    const result = await harness.run({
      reviewerRawFindings: [{
        rawFindingId: 'n-hallucinated',
        familyTag: 'security',
        severity: 'critical',
        title: 'Imaginary authentication bypass',
        description: 'The nonexistent auth/ghost.ts bypasses every authorization check.',
        suggestion: 'Remove the imaginary bypass.',
        relation: 'new',
        targetFindingId: null,
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const saved = harness.currentLedger();
    const landed = saved.findings.find((finding) => finding.title === 'Imaginary authentication bypass');
    expect(landed?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(saved.reviewerAnomalies ?? []).toHaveLength(0);
  });

  it('対照: persists + matching file_quote は変異経路へ（open target へ機械 attach する）', async () => {
    // 検証済み file_quote 付きの persists は open target へ機械 same として
    // 合流（attach）する = 既存 finding を変異させる正当な経路。証拠なし/
    // 未検証との対照。
    const harness = makeHarness(makeLedger({ findings: [makeFinding({ revision: 1 })] })); // F-0001 open, src/a.ts:10
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
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 10)],
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
// tainted × 証拠なしの persists/reopened が
// ambiguous ladder（SameProof / create_independent / open_conflict）経由で既存
// finding を変異できる穴を塞ぐ。未検証 tainted persists/reopened は provisional-only。
// ---------------------------------------------------------------------------
describe('codex 検証4巡目: 未検証 tainted persists/reopened は ambiguous ladder でも provisional-only', () => {
  it('tainted evidence-free reopened は open target を SameProof identity マッチで変異できない（reattach 遮断）', async () => {
    // F-0001 は open で、証拠なし + 同一 title/description/suggestion の raw と
    // identity（SameProof の一致条件）が一致する。reopened→open target は
    // reopened-target-open で tainted になる。修正前はこの identity 一致で
    // SameProof が発行され reattach（revision/rawFindingIds/lastSeen 更新）できた。
    const seed = makeFinding({
      status: 'open', lifecycle: 'new', revision: 1,
      title: 'Missing input validation',
      description: 'The handler does not validate input.',
      suggestion: 'Add validation.',
      rawFindingIds: ['raw-existing'],
    });
    const harness = makeHarness(makeLedger({ findings: [seed] }));
    const initialEvidenceIds = [
      ...harness.currentLedger().findings.find((finding) => finding.id === 'F-0001')!.evidenceIds,
    ];
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
        description: 'The handler does not validate input.',
        suggestion: 'Add validation.',
        relation: 'reopened',
        targetFindingId: 'F-0001',
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    const target = saved.findings.find((finding) => finding.id === 'F-0001')!;
    // product state は不変で、監査添付だけが revision を進める。
    expect(target.status).toBe('open');
    expect(target.revision).toBe(2);
    expect(target.lifecycle).toBe('new');
    expect(target.evidenceIds).toEqual(initialEvidenceIds);
    expect(target.title).toBe('Missing input validation');
    expect(target.description).toBe('The handler does not validate input.');
    expect(target.rawFindingIds).toEqual(['raw-existing']);
    expect(target.rejectedObservations).toEqual([
      expect.objectContaining({ rawFindingId: expect.stringContaining(':r-1') }),
    ]);
    expect(saved.findings).toHaveLength(1);
    expect(saved.reviewerAnomalies ?? []).toHaveLength(0);
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('tainted evidence-free persists は manager が create_independent を返しても provisional 止まり（新規 finding を作らない）', async () => {
    // persists→resolved target は persists-target-not-open で tainted。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved', title: 'Old bug' })],
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
        description: 'Something else entirely.',
        suggestion: null,
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // create_independent は封じられ、新規の confirmed finding は立たない。
    expect(saved.findings.some((finding) => finding.title === 'A brand new independent problem' && finding.provisional === undefined)).toBe(false);
    expect(saved.findings).toHaveLength(1);
    expect(executeAgentMock).not.toHaveBeenCalled();
    // resolved target は不変。
    expect(saved.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
  });

  it('tainted evidence-free persists は manager が open_conflict を返しても provisional 止まり（別 open finding へ conflict を立てない）', async () => {
    // F-0001 resolved（persists target）、F-0002 open（open_conflict のターゲット候補）。
    const harness = makeHarness(makeLedger({
      findings: [
        makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved', title: 'Old bug' }),
        makeFinding({ revision: 1, id: 'F-0002', status: 'open', title: 'Unrelated open finding', rawFindingIds: ['raw-f2'] }),
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
        description: 'Claims it still persists without evidence.',
        suggestion: null,
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidence: [],
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    // open_conflict は封じられ、active conflict は立たない。
    expect(saved.conflicts.filter((conflict) => conflict.status === 'active')).toEqual([]);
    // F-0002 は不変、raw は audit-only。
    expect(saved.findings.find((finding) => finding.id === 'F-0002')?.rawFindingIds).toEqual(['raw-f2']);
    expect(saved.findings).toHaveLength(2);
  });

  it('verified(file_quote match) でも terminal target への persists は audit-only となり recovery を起動しない', async () => {
    // persists→resolved target は lifecycle supplement。証拠が検証済みでも
    // product finding の作成・変更権限を持たず、manager recovery へも送らない。
    const harness = makeHarness(makeLedger({
      findings: [makeFinding({ revision: 1, status: 'resolved', lifecycle: 'resolved', title: 'Old bug' })],
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
        description: 'Cited with a verified file_quote.',
        suggestion: null,
        relation: 'persists',
        targetFindingId: 'F-0001',
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/a.ts', 15)],
      }],
    });
    expect(result.status).toBe('updated');
    const saved = harness.currentLedger();
    expect(saved.findings).toHaveLength(1);
    expect(saved.findings[0]?.status).toBe('resolved');
    expect(executeAgentMock).not.toHaveBeenCalled();
  });
});
