/**
 * provisional fixpoint 判定（対策バッチ B1: raw finding 梯子設計 v2 の収束性
 * 対策）の単体・往復ラウンドテスト。
 *
 * - 単体: computeFixpointSnapshot / attachFixpointState の純粋なロジック
 * - 往復ラウンド: runFindingManagerForStep を実際に複数回呼び、
 *   findings-manager の1ラウンド = 1回の reconcile という前提のもとで、
 *   fixpoint.reached がラウンド跨ぎで正しく機械判定されることを検証する
 *   （v3-r4 実測形の再現、resume/新規走行を跨いだ継続、新観測による解消を含む）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingLedger, FindingLedgerEntry } from '../core/workflow/findings/types.js';
import {
  attachFixpointState as attachFixpointStateWithCwd,
  computeFixpointSnapshot as computeFixpointSnapshotWithCwd,
} from '../core/workflow/findings/fixpoint.js';
import { runFindingManagerForStep, type FindingManagerSubStepResult } from '../core/workflow/findings/manager-runner.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function computeFixpointSnapshot(ledger: FindingLedger) {
  return computeFixpointSnapshotWithCwd(ledger, process.cwd());
}

function attachFixpointState(previous: FindingLedger, next: FindingLedger): FindingLedger {
  return attachFixpointStateWithCwd(previous, next, process.cwd());
}

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd());
}

beforeEach(() => {
  executeAgentMock.mockReset();
});

/** Finds the namespaced rawFindingId ending with `:localId` inside a manager/interpretation instruction. */
function extractRawFindingId(instruction: string, localId: string): string {
  const matches = [...instruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)].map((match) => match[1]!);
  const found = matches.find((id) => id.endsWith(`:${localId}`));
  if (found === undefined) {
    throw new Error(`Test setup error: raw id ending with :${localId} not found in instruction: ${instruction}`);
  }
  return found;
}

/**
 * Same as extractRawFindingId, but for a generic mockImplementation shared
 * across multiple rounds/local ids: tries each candidate local id in order
 * and returns whichever one actually appears in this call's instruction.
 */
function extractResidualRawIdFromEitherLocalId(instruction: string, localIds: readonly string[]): string {
  for (const localId of localIds) {
    const matches = [...instruction.matchAll(/"rawFindingId":\s*"([^"]+)"/g)].map((match) => match[1]!);
    const found = matches.find((id) => id.endsWith(`:${localId}`));
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`Test setup error: none of [${localIds.join(', ')}] found in instruction: ${instruction}`);
}

// ---------------------------------------------------------------------------
// 純粋関数テスト: computeFixpointSnapshot / attachFixpointState
// ---------------------------------------------------------------------------

function observation(runId = 'run-1'): { runId: string; stepName: string; timestamp: string } {
  return { runId, stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' };
}

function provisionalFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0001',
    status: 'open',
    lifecycle: 'new',
    severity: 'high',
    title: 'Hallucinated issue',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-1'],
    firstSeen: observation(),
    lastSeen: observation(),
    revision: 1,
    provisional: {
      kind: 'invalid-location-evidence',
      stableKey: 'stable-key-a',
      lineageKey: 'lineage-a',
      sourceRawFindingIds: ['raw-1'],
      reason: 'Location does not exist',
      firstObservedAt: observation(),
      lastObservedAt: observation(),
      interpretationEpochs: 0,
      gateEffect: 'block',
    },
    ...overrides,
  };
}

function substantiveFinding(overrides: Partial<FindingLedgerEntry> = {}): FindingLedgerEntry {
  return {
    id: 'F-0002',
    status: 'open',
    lifecycle: 'new',
    severity: 'medium',
    title: 'Real issue',
    reviewers: ['arch-review'],
    rawFindingIds: ['raw-2'],
    firstSeen: observation(),
    lastSeen: observation(),
    revision: 1,
    ...overrides,
  };
}

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    version: 1,
    workflowName: 'peer-review',
    nextId: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

describe('computeFixpointSnapshot', () => {
  it('returns empty arrays for an empty ledger', () => {
    const snapshot = computeFixpointSnapshot(ledger());
    expect(snapshot).toEqual({ provisionalKeys: [], substantiveEntries: [], unadjudicatedConflictEntries: [] });
  });

  it('collects only open findings with provisional metadata into provisionalKeys, keyed by stableKey', () => {
    const snapshot = computeFixpointSnapshot(ledger({
      findings: [
        provisionalFinding({ id: 'F-0001', provisional: { ...provisionalFinding().provisional!, stableKey: 'key-a' } }),
        // resolved provisional は open ではないため除外される。
        provisionalFinding({
          id: 'F-0003',
          status: 'resolved',
          provisional: { ...provisionalFinding().provisional!, stableKey: 'key-b' },
        }),
      ],
    }));
    expect(snapshot.provisionalKeys).toEqual(['key-a']);
  });

  it('collects every non-provisional finding regardless of status into substantiveEntries as "id:status"', () => {
    const snapshot = computeFixpointSnapshot(ledger({
      findings: [
        substantiveFinding({ id: 'F-0002', status: 'open' }),
        substantiveFinding({ id: 'F-0004', status: 'resolved' }),
        // provisional は substantiveEntries から除外される。
        provisionalFinding({ id: 'F-0001' }),
      ],
    }));
    expect(snapshot.substantiveEntries).toEqual(['F-0002:open', 'F-0004:resolved']);
  });

  it('includes only active AND unadjudicated conflicts in unadjudicatedConflictEntries', () => {
    const withRaws = ledger({
      rawFindings: [{
        rawFindingId: 'raw-c1',
        stepName: 'reviewers',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Conflicting claim',
        description: 'One reviewer says X, another says Y.',
      }],
      conflicts: [
        {
          id: 'C-0001',
          status: 'active',
          findingIds: ['F-0002'],
          rawFindingIds: ['raw-c1'],
          description: 'Unresolved disagreement',
          firstSeen: observation(),
          lastSeen: observation(),
        },
        {
          id: 'C-0002',
          status: 'resolved',
          findingIds: ['F-0002'],
          rawFindingIds: ['raw-c1'],
          description: 'Already resolved conflict',
          firstSeen: observation(),
          lastSeen: observation(),
          resolvedAt: observation().timestamp,
        },
      ],
      findings: [substantiveFinding({ id: 'F-0002' })],
    });
    const snapshot = computeFixpointSnapshot(withRaws);
    expect(snapshot.unadjudicatedConflictEntries).toHaveLength(1);
    expect(snapshot.unadjudicatedConflictEntries[0]).toMatch(/^C-0001:/);
  });

  it('changes the conflict fixpoint entry when the reviewed worktree changes', () => {
    const scopeCwd = mkdtempSync(join(tmpdir(), 'takt-fixpoint-scope-'));
    try {
      mkdirSync(join(scopeCwd, 'src'), { recursive: true });
      writeFileSync(join(scopeCwd, 'src', 'a.ts'), 'export const value = 1;\n');
      initializeGitFixture(scopeCwd, ['src/a.ts']);
      const withConflict = ledger({
        findings: [substantiveFinding({ id: 'F-0002' })],
        rawFindings: [{
          rawFindingId: 'raw-c1',
          stepName: 'reviewers',
          reviewer: 'arch-review',
          familyTag: 'bug',
          severity: 'high',
          title: 'Conflicting claim',
          description: 'One reviewer says X, another says Y.',
        }],
        conflicts: [{
          id: 'C-0001',
          status: 'active',
          findingIds: ['F-0002'],
          rawFindingIds: ['raw-c1'],
          description: 'Unresolved disagreement',
          firstSeen: observation(),
          lastSeen: observation(),
        }],
      });
      const before = computeFixpointSnapshotWithCwd(withConflict, scopeCwd);

      writeFileSync(join(scopeCwd, 'src', 'a.ts'), 'export const value = 2;\n');
      const after = computeFixpointSnapshotWithCwd(withConflict, scopeCwd);

      expect(after.unadjudicatedConflictEntries).not.toEqual(before.unadjudicatedConflictEntries);
    } finally {
      rmSync(scopeCwd, { recursive: true, force: true });
    }
  });

  it('produces sorted, order-independent output (two different insertion orders yield the same snapshot)', () => {
    const a = provisionalFinding({ id: 'F-0001', provisional: { ...provisionalFinding().provisional!, stableKey: 'zzz' } });
    const b = provisionalFinding({ id: 'F-0002', provisional: { ...provisionalFinding().provisional!, stableKey: 'aaa' } });
    const snapshot1 = computeFixpointSnapshot(ledger({ findings: [a, b] }));
    const snapshot2 = computeFixpointSnapshot(ledger({ findings: [b, a] }));
    expect(snapshot1).toEqual(snapshot2);
    expect(snapshot1.provisionalKeys).toEqual(['aaa', 'zzz']);
  });

  it('treats a bounded recovery attempt as progress instead of a fixpoint', () => {
    const before = ledger({ findings: [provisionalFinding({
      provisional: {
        ...provisionalFinding().provisional!,
        kind: 'raw-adjudication-unresolved',
      },
    })] });
    const after = ledger({ findings: [provisionalFinding({
      provisional: {
        ...provisionalFinding().provisional!,
        kind: 'raw-adjudication-unresolved',
        adjudicationAttempts: [{
          attempt: 1,
          replayRawFindingId: 'replay-1',
          reason: 'no substantive outcome',
          at: observation(),
        }],
      },
    })] });

    expect(computeFixpointSnapshot(before).provisionalKeys).toEqual(['stable-key-a']);
    expect(computeFixpointSnapshot(after).provisionalKeys).toEqual([
      'stable-key-a:recovery:0:1:0:0',
    ]);
  });
});

describe('attachFixpointState', () => {
  it('is never reached on the first comparable round (no previous snapshot), even if the round already has open provisional findings', () => {
    const previous = ledger();
    const next = ledger({ findings: [provisionalFinding()] });
    const result = attachFixpointState(previous, next);
    expect(result.fixpoint?.reached).toBe(false);
    expect(result.fixpoint?.snapshot.provisionalKeys).toEqual(['stable-key-a']);
  });

  it('reaches fixpoint when the round is identical to the previous round and has at least one open provisional', () => {
    const withProvisional = ledger({ findings: [provisionalFinding()] });
    const previous = attachFixpointState(ledger(), withProvisional);
    const next = attachFixpointState(previous, withProvisional);
    expect(next.fixpoint?.reached).toBe(true);
  });

  it('does not reach fixpoint when there is no open provisional finding, even if the snapshot is otherwise unchanged', () => {
    const clean = ledger({ findings: [substantiveFinding({ status: 'resolved' })] });
    const previous = attachFixpointState(ledger(), clean);
    const next = attachFixpointState(previous, clean);
    expect(next.fixpoint?.reached).toBe(false);
    expect(next.fixpoint?.snapshot.provisionalKeys).toEqual([]);
  });

  it('breaks fixpoint when the provisional key set changes (a different observation replaces the old one)', () => {
    const round1 = ledger({ findings: [provisionalFinding({ provisional: { ...provisionalFinding().provisional!, stableKey: 'key-a' } })] });
    const round2 = ledger({ findings: [provisionalFinding({ provisional: { ...provisionalFinding().provisional!, stableKey: 'key-b' } })] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('breaks fixpoint when a substantive finding changes status between rounds (e.g. resolved)', () => {
    const round1 = ledger({ findings: [provisionalFinding(), substantiveFinding({ status: 'open' })] });
    const round2 = ledger({ findings: [provisionalFinding(), substantiveFinding({ status: 'resolved' })] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('breaks fixpoint when a new substantive finding is created between rounds', () => {
    const round1 = ledger({ findings: [provisionalFinding()] });
    const round2 = ledger({ findings: [provisionalFinding(), substantiveFinding()] });
    const previous = attachFixpointState(ledger(), round1);
    const next = attachFixpointState(previous, round2);
    expect(next.fixpoint?.reached).toBe(false);
  });

  it('always advances the stored snapshot to the current round, so a THIRD identical round reaches fixpoint after a differing round 2', () => {
    const stable = ledger({ findings: [provisionalFinding()] });
    const changed = ledger({ findings: [provisionalFinding(), substantiveFinding({ status: 'open' })] });
    const round1 = attachFixpointState(ledger(), stable);
    const round2 = attachFixpointState(round1, changed);
    expect(round2.fixpoint?.reached).toBe(false);
    const round3 = attachFixpointState(round2, changed);
    expect(round3.fixpoint?.reached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 往復ラウンドテスト: runFindingManagerForStep を実際に複数回呼ぶ
// ---------------------------------------------------------------------------

const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-fixpoint-fixtures-'));
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/real.ts', 60);
initializeGitFixture(FIXTURE_CWD, ['src/real.ts']);

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

function makeRoundHarness(initialLedger: FindingLedger): {
  currentLedger: () => FindingLedger;
  run: (reviewerRawFindings: Array<Record<string, unknown>>) => ReturnType<typeof runFindingManagerForStep>;
} {
  let ledgerState = initialLedger;
  const reservations = new Set<string>();
  const ledgerStore: FindingLedgerStore = {
    workflowName: 'peer-review',
    loadLedger: () => ledgerState,
    saveLedger: (next) => { ledgerState = next; },
    updateLedger: (mutator) => {
      const mutation = mutator(ledgerState);
      ledgerState = mutation.ledger;
      return Promise.resolve(mutation);
    },
    claimAdjudicationReservation: (token) => {
      if (reservations.has(token)) return false;
      reservations.add(token);
      return true;
    },
    releaseAdjudicationReservation: (token) => { reservations.delete(token); },
    createRunCopy: () => '/tmp/ledger-copy.json',
    saveRawFindings: () => '/tmp/raw-findings.json',
    saveManagerValidationReport: () => '/tmp/manager-report.json',
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
  };
  let round = 0;
  return {
    currentLedger: () => ledgerState,
    run: (reviewerRawFindings) => {
      round += 1;
      const subResults: FindingManagerSubStepResult[] = [{
        subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
        response: {
          status: 'done',
          content: '',
          structuredOutput: { rawFindings: reviewerRawFindings },
        } as unknown as AgentResponse,
      }];
      return runFindingManagerForStep({
        contract: contract as never,
        ledgerStore,
        optionsBuilder: optionsBuilder as never,
        stepExecutor: stepExecutor as never,
        cwd: FIXTURE_CWD,
        parentStep,
        stepIteration: round,
        subResults,
        workflowName: 'peer-review',
        runId: `run-${round}`,
        callNamespace: '',
        timestamp: `2026-07-0${round}T00:00:00.000Z`,
      });
    },
  };
}

/**
 * codex 対策#4: 幻覚 location（存在しないファイルへの claim）は
 * verbatimExcerpt 機械照合により reviewer anomaly（review-integrity 側、
 * product gate 非ブロッキング）へ隔離されるようになった — v3-r4 実測の架空指摘が
 * product gate を誤って塞いでいたバグそのものの修正。GREEN の直接的な固定は
 * finding-evidence-protocol-fixture.test.ts（実 v3-r4 ledger データを使った
 * 決定的 red/green fixture）が担う。ここでは fixpoint 機構自体の往復ラウンド
 * 検証を維持するため、同じ「gate-blocking な provisional を作る」役割を
 * 構造的に矛盾した persists 参照（raw-meaning-ambiguous）で代替する。
 */
function hallucinatedRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rawFindingId: 'hallucinated-1',
    familyTag: 'bug',
    severity: 'high',
    title: 'Nonexistent file has a null check bug',
    location: 'src/does-not-exist.ts:5',
    description: 'This describes a bug in a file that does not exist in the reviewed tree.',
    suggestion: 'Add a null check.',
    relation: 'new',
    ...overrides,
  };
}

/** ambiguous ladder の interpretation 呼び出しへの汎用応答（'provisional' 提案）。 */
function interpretationResponse(rawFindingId: string): AgentResponse {
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    structuredOutput: {
      interpretations: [
        { decision: 'provisional', rawFindingId, proofId: '', targetFindingId: '', reason: 'Cannot determine the identity of this re-report.' },
      ],
    },
    timestamp: new Date('2026-07-01T00:00:01.000Z'),
  } as unknown as AgentResponse;
}

/**
 * 構造的に矛盾した persists 参照（存在しない finding id への再報告）。
 * targetFindingId を変えると lineageKey が変わり churn を再現できる
 * （computeLineageKey は targetFindingId を最優先で使う）。executeAgentMock は
 * 汎用実装にしてあるので、このヘルパーを何回呼んでも manager 呼び出しの
 * mock 追加は不要（interpretation 応答は instruction から rawFindingId を
 * 抽出して動的に返す）。
 */
function ambiguousPersistsRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rawFindingId: 'ambiguous-1',
    familyTag: 'bug',
    severity: 'high',
    title: 'Re-report of a finding that was never actually opened',
    description: 'Claims to persist a finding id the ledger has never seen.',
    suggestion: '',
    relation: 'persists',
    targetFindingId: 'F-9001',
    ...overrides,
  };
}

describe('runFindingManagerForStep: hallucinated location lands as a non-blocking reviewer anomaly (codex 対策#4)', () => {
  it('a hallucinated finding against a nonexistent file is isolated as a reviewer anomaly, not a gate-blocking provisional, and needs no manager call', async () => {
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });

    const result = await harness.run([hallucinatedRaw()]);

    expect(executeAgentMock).not.toHaveBeenCalled();
    const ledger = harness.currentLedger();
    expect(ledger.findings).toHaveLength(0);
    const context = buildFindingsRuleContext(ledger);
    expect(context.provisional.count).toBe(0);
    expect(context.open.count).toBe(0);
    expect(context.reviewerAnomalies.count).toBe(1);
    expect(result.ledger.reviewerAnomalies?.[0]?.kind).toBe('quote-mismatch');
  });
});

describe('runFindingManagerForStep across rounds: provisional fixpoint mechanics (structurally ambiguous re-report vehicle)', () => {
  it('is not a fixpoint on the first round, even though a provisional is already open', async () => {
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });

    executeAgentMock.mockImplementationOnce(async (_persona, instruction) => {
      const rawId = extractRawFindingId(instruction as string, 'ambiguous-1');
      return interpretationResponse(rawId);
    });
    await harness.run([ambiguousPersistsRaw()]);

    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);
  });

  it('reaches fixpoint after the repeated claim consumes its second interpretation attempt', async () => {
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-again', 'ambiguous-1-final'],
      );
      return interpretationResponse(rawId);
    });
    await harness.run([ambiguousPersistsRaw()]);
    await harness.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-again' })]);
    await harness.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-final' })]);

    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.count).toBe(1);
    expect(context.provisional.fixpoint).toBe(true);
  });

  it('does not reach fixpoint when a different claim shows up on the second round instead', async () => {
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(instruction as string, ['ambiguous-1', 'ambiguous-2']);
      return interpretationResponse(rawId);
    });
    await harness.run([ambiguousPersistsRaw()]);
    await harness.run([ambiguousPersistsRaw({
      rawFindingId: 'ambiguous-2',
      title: 'A completely different structurally ambiguous claim',
      targetFindingId: 'F-9002',
    })]);

    // Both the round-1 and round-2 observations stay open (nothing resolved
    // them) — the provisional set grew, which is real change, not stagnation.
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.count).toBe(2);
    expect(context.provisional.fixpoint).toBe(false);
  });

  it('v3-r4 measured shape: a substantive finding resolving across rounds blocks fixpoint until it stabilizes, then the persistent ambiguous claim triggers it', async () => {
    // F-0001 pre-seeded as an already-open substantive finding (as if an
    // earlier round created it) — round 1 below is the round where it is
    // confirmed resolved by a mechanically-handled resolution_confirmation.
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 2, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'medium',
        title: 'Real, fixable issue',
        location: 'src/real.ts:10',
        description: 'A genuine issue that the fixer can and will resolve.',
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-seed'],
        firstSeen: observation('run-0'),
        lastSeen: observation('run-0'),
        revision: 1,
      }],
      rawFindings: [{
        rawFindingId: 'raw-seed',
        stepName: 'reviewers',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'medium',
        title: 'Real, fixable issue',
        location: 'src/real.ts:10',
        description: 'A genuine issue that the fixer can and will resolve.',
      }],
      conflicts: [],
    });

    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(instruction as string, ['ambiguous-1', 'ambiguous-1-r2', 'ambiguous-1-r3']);
      return interpretationResponse(rawId);
    });

    // Round 1: the ambiguous claim is first observed; the substantive finding
    // is untouched this round (still open — carried over from the seed).
    await harness.run([ambiguousPersistsRaw()]);
    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);

    // The substantive resolution and the second interpretation attempt both
    // represent real progress, so this round cannot be a fixpoint.
    await harness.run([
      ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-r2' }),
      {
        rawFindingId: 'confirm-1',
        familyTag: 'bug',
        severity: 'medium',
        title: 'Real, fixable issue',
        description: 'Verified: the fix removes the issue.',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        // codex 検証ブロッカー#2: confirmation は検証済み source_quote 証跡が
        // 無いと resolve できない（機械照合を通らず finding を閉じさせない）。
        ...verifiedSourceQuoteFields(FIXTURE_CWD, 'src/real.ts', 10),
      },
    ]);
    const afterRound2 = harness.currentLedger();
    expect(afterRound2.findings.find((finding) => finding.id === 'F-0001')?.status).toBe('resolved');
    expect(buildFindingsRuleContext(afterRound2).provisional.fixpoint).toBe(false);

    // Recovery is exhausted before round 3, so the unchanged blocker can now
    // form a stable snapshot instead of being mistaken for progress.
    await harness.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-r3' })]);
    const afterRound3 = harness.currentLedger();
    const context = buildFindingsRuleContext(afterRound3);
    expect(context.provisional.count).toBe(1);
    expect(context.provisional.fixpoint).toBe(true);
  });

  it('resume continuity: a fresh harness (simulating a new process) that inherits a ledger already carrying a matching fixpoint snapshot can reach fixpoint on its very first round', async () => {
    // Round A produced by an earlier "process" (e.g. before a resume).
    const priorProcess = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-prior-2', 'ambiguous-1-resumed'],
      );
      return interpretationResponse(rawId);
    });
    await priorProcess.run([ambiguousPersistsRaw()]);
    await priorProcess.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-prior-2' })]);
    const ledgerFromPriorProcess = priorProcess.currentLedger();
    expect(ledgerFromPriorProcess.fixpoint?.reached).toBe(false);

    // A brand new harness (simulating a fresh `takt` invocation / resume)
    // starts from that persisted ledger — not from an empty one — because
    // the fixpoint comparison lives on the ledger file, not in engine memory.
    const resumedProcess = makeRoundHarness(ledgerFromPriorProcess);
    await resumedProcess.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-resumed' })]);

    expect(buildFindingsRuleContext(resumedProcess.currentLedger()).provisional.fixpoint).toBe(true);
  });

  it('a human providing new review evidence after a fixpoint breaks it, routing back to replan instead of staying stuck', async () => {
    const harness = makeRoundHarness({
      version: 1, workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [], rawFindings: [], conflicts: [],
    });
    executeAgentMock.mockImplementation(async (_persona, instruction) => {
      const rawId = extractResidualRawIdFromEitherLocalId(
        instruction as string,
        ['ambiguous-1', 'ambiguous-1-r2', 'ambiguous-1-r3', 'ambiguous-1-r4', 'new-observation'],
      );
      return interpretationResponse(rawId);
    });
    await harness.run([ambiguousPersistsRaw()]);
    await harness.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-r2' })]);
    await harness.run([ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-r3' })]);
    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(true);

    // A new, different observation arrives (e.g. the human adjusted
    // something and a reviewer now reports something new) — the fixpoint
    // must not stay latched; it re-evaluates fresh each round.
    await harness.run([
      ambiguousPersistsRaw({ rawFindingId: 'ambiguous-1-r4' }),
      ambiguousPersistsRaw({
        rawFindingId: 'new-observation',
        title: 'A newly reported, different structurally ambiguous claim',
        targetFindingId: 'F-9099',
      }),
    ]);

    expect(buildFindingsRuleContext(harness.currentLedger()).provisional.fixpoint).toBe(false);
  });
});
