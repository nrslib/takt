/**
 * 有限停止予算（bounded stop budget; codex 裁定・対策バッチ B1 の拡張）の
 * 単体・往復ラウンドテスト。
 *
 * B1 の fixpoint 判定だけでは、レビュアーが毎ラウンド別の架空 provisional を
 * 1件でも生成し続けると provisional 集合が毎回変わり fixpoint が永久に成立
 * しない（実測済み）。ここでは「累積ラウンド数（と任意で経過時間）が上限を
 * 超えたら、fixpoint が成立していなくても有限停止を判断できるようにする」
 * モデル挙動に依存しない停止条件が正しく機能することを検証する。
 *
 * - 単体: resolveStopBudgetLimits / attachStopBudgetState の純粋なロジック
 * - 往復ラウンド: runFindingManagerForStep を実際に複数回呼び、churn
 *   （fixpoint が決して成立しない系列）でも budget が有限で発火すること、
 *   優先順位（fixpoint が budget より先に成立していれば fixpoint 側が勝つ）、
 *   進捗があっても予算がリセットされないこと、resume を跨いだ累積の継続、
 *   時間予算の発火を検証する
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { FindingContractStopBudgetConfig, FindingLedger } from '../core/workflow/findings/types.js';
import {
  DEFAULT_STOP_BUDGET,
  attachStopBudgetState,
  resolveStopBudgetLimits,
  stopBudgetRoundsCompleted,
  type ResolvedStopBudgetLimits,
} from '../core/workflow/findings/stop-budget.js';
import { computeRoundMarker } from '../core/workflow/findings/round-marker.js';
import { runFindingManagerForStep, type FindingManagerSubStepResult } from '../core/workflow/findings/manager-runner.js';
import {
  createFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
} from '../core/workflow/findings/review-publication.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { buildFindingsRuleContext as buildFindingsRuleContextWithCwd } from '../core/workflow/findings/context.js';
import { processInterpretationLiveClaims } from '../core/workflow/findings/interpretation-live-claims.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { createFindingManagerPublicationDouble, RevisionedFindingLedgerTestRepository } from './helpers/finding-manager-publication.js';
import {
  findingManagerTaskManifest,
  findingManagerTaskResponse,
} from './helpers/finding-manager-task-response.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

const { executeAgent } = await import('../agents/agent-usecases.js');
const executeAgentMock = vi.mocked(executeAgent);

function buildFindingsRuleContext(ledger: FindingLedger) {
  return buildFindingsRuleContextWithCwd(ledger, process.cwd(), new Map());
}

beforeEach(() => {
  executeAgentMock.mockReset();
  executeAgentMock.mockImplementation(async (_persona, instruction) => (
    managerRunAgentResponse(instruction as string)
  ));
});

// ---------------------------------------------------------------------------
// 純粋関数テスト: resolveStopBudgetLimits / attachStopBudgetState
// ---------------------------------------------------------------------------

function ledger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

describe('resolveStopBudgetLimits', () => {
  it('公開既定値を実行時にも変更不能にする', () => {
    expect(Object.isFrozen(DEFAULT_STOP_BUDGET)).toBe(true);
  });

  it('applies the rounds default and leaves the time cap off when finding_contract.stop_budget is entirely omitted (undefined must still stop in finite rounds)', () => {
    // 時間上限に既定値は無い: churn はラウンド数に現れる。時間の既定上限は
    // 「ラウンドは少ないが 1 ラウンドが重い健全な run」を誤停止させた実測がある。
    expect(resolveStopBudgetLimits(undefined)).toEqual({
      maxRounds: DEFAULT_STOP_BUDGET.maxRounds,
      maxMinutes: undefined,
    });
  });

  it('applies the maxRounds default when only maxMinutes is configured', () => {
    expect(resolveStopBudgetLimits({ maxMinutes: 30 })).toEqual({
      maxRounds: DEFAULT_STOP_BUDGET.maxRounds,
      maxMinutes: 30,
    });
  });

  it('leaves the time cap off when only maxRounds is configured (max_minutes is opt-in)', () => {
    expect(resolveStopBudgetLimits({ maxRounds: 5 })).toEqual({
      maxRounds: 5,
      maxMinutes: undefined,
    });
  });

  it('uses both configured values when both are provided (no default applied)', () => {
    expect(resolveStopBudgetLimits({ maxRounds: 5, maxMinutes: 10 })).toEqual({ maxRounds: 5, maxMinutes: 10 });
  });
});

describe('computeRoundMarker', () => {
  it('is stable for the same (runId, callNamespace, stepName, stepIteration) and distinct for different ones', () => {
    const a = computeRoundMarker({ runId: 'run-1', callNamespace: '', parentStepName: 'reviewers', stepIteration: 3, publicationIds: ['publication-1'] });
    const aAgain = computeRoundMarker({ runId: 'run-1', callNamespace: '', parentStepName: 'reviewers', stepIteration: 3, publicationIds: ['publication-1'] });
    const differentIteration = computeRoundMarker({ runId: 'run-1', callNamespace: '', parentStepName: 'reviewers', stepIteration: 4, publicationIds: ['publication-1'] });
    const differentRun = computeRoundMarker({ runId: 'run-2', callNamespace: '', parentStepName: 'reviewers', stepIteration: 3, publicationIds: ['publication-1'] });
    const differentPublication = computeRoundMarker({ runId: 'run-1', callNamespace: '', parentStepName: 'reviewers', stepIteration: 3, publicationIds: ['publication-2'] });
    expect(a).toBe(aAgain);
    expect(a).toContain('\0');
    expect(a).not.toBe(differentIteration);
    expect(a).not.toBe(differentRun);
    expect(a).not.toBe(differentPublication);
  });
});

describe('attachStopBudgetState', () => {
  const limits: ResolvedStopBudgetLimits = { maxRounds: 3, maxMinutes: 90 };
  const marker = (n: number) => computeRoundMarker({ runId: 'run-1', callNamespace: '', parentStepName: 'reviewers', stepIteration: n, publicationIds: ['publication-1'] });

  it('records the first round marker and firstRoundAt on the very first round', () => {
    const result = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z');
    expect(result.stopBudget).toEqual({
      roundMarkers: [marker(1)],
      firstRoundAt: '2026-07-01T00:00:00.000Z',
      exhausted: false,
    });
    expect(stopBudgetRoundsCompleted(result)).toBe(1);
  });

  it('adds one distinct marker per call, regardless of what changed in the ledger content', () => {
    const round1 = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z');
    const round2 = attachStopBudgetState(round1, ledger({ findings: [] }), limits, marker(2), '2026-07-01T00:01:00.000Z');
    expect(stopBudgetRoundsCompleted(round2)).toBe(2);
  });

  it('re-applying the SAME round marker is a no-op — the count neither double-counts nor rolls back (crash/replay idempotency)', () => {
    const round1 = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z');
    expect(stopBudgetRoundsCompleted(round1)).toBe(1);
    // Same invocation's mutator runs again (e.g. a retried updateLedger, or a
    // replayed commit of the identical round) — same marker → Set no-op.
    const replay = attachStopBudgetState(round1, round1, limits, marker(1), '2026-07-01T00:05:00.000Z');
    expect(stopBudgetRoundsCompleted(replay)).toBe(1);
    expect(replay.stopBudget?.roundMarkers).toEqual([marker(1)]);
    // firstRoundAt stays pinned to the original round even on the replay.
    expect(replay.stopBudget?.firstRoundAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('never overwrites firstRoundAt on later rounds (fixes the time-budget origin)', () => {
    const round1 = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z');
    const round2 = attachStopBudgetState(round1, ledger(), limits, marker(2), '2026-07-01T01:00:00.000Z');
    expect(round2.stopBudget?.firstRoundAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('marks exhausted once the distinct-marker count reaches maxRounds, not before', () => {
    let state = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z'); // round 1
    expect(state.stopBudget?.exhausted).toBe(false);
    state = attachStopBudgetState(state, state, limits, marker(2), '2026-07-01T00:01:00.000Z'); // round 2
    expect(state.stopBudget?.exhausted).toBe(false);
    state = attachStopBudgetState(state, state, limits, marker(3), '2026-07-01T00:02:00.000Z'); // round 3 === maxRounds
    expect(state.stopBudget?.exhausted).toBe(true);
  });

  it('does NOT mark exhausted when the same marker is replayed maxRounds times (replay must not fake exhaustion)', () => {
    let state = attachStopBudgetState(ledger(), ledger(), limits, marker(1), '2026-07-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      state = attachStopBudgetState(state, state, limits, marker(1), '2026-07-01T00:01:00.000Z');
    }
    expect(stopBudgetRoundsCompleted(state)).toBe(1);
    expect(state.stopBudget?.exhausted).toBe(false);
  });

  it('never exhausts by time when maxMinutes is left unset, no matter how much wall-clock passes', () => {
    const roundsOnly: ResolvedStopBudgetLimits = { maxRounds: 1000, maxMinutes: undefined };
    const round1 = attachStopBudgetState(ledger(), ledger(), roundsOnly, marker(1), '2026-07-01T00:00:00.000Z');
    const daysLater = attachStopBudgetState(round1, round1, roundsOnly, marker(2), '2026-07-08T00:00:00.000Z');
    expect(daysLater.stopBudget?.exhausted).toBe(false);
    expect(stopBudgetRoundsCompleted(daysLater)).toBe(2);
  });

  it('marks exhausted once elapsed minutes reach maxMinutes even while well under the round cap', () => {
    const generousRounds: ResolvedStopBudgetLimits = { maxRounds: 1000, maxMinutes: 90 };
    const round1 = attachStopBudgetState(ledger(), ledger(), generousRounds, marker(1), '2026-07-01T00:00:00.000Z');
    expect(round1.stopBudget?.exhausted).toBe(false);
    // 89 minutes later: still under the 90-minute cap.
    const stillWithin = attachStopBudgetState(round1, round1, generousRounds, marker(2), '2026-07-01T01:29:00.000Z');
    expect(stillWithin.stopBudget?.exhausted).toBe(false);
    // 90 minutes later: time budget fires even though only 3 rounds have run.
    const exhausted = attachStopBudgetState(stillWithin, stillWithin, generousRounds, marker(3), '2026-07-01T01:30:00.000Z');
    expect(exhausted.stopBudget?.exhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(exhausted)).toBe(3);
  });

  it('accounts for a leap second when the time budget crosses the one-minute boundary', () => {
    const timeLimited: ResolvedStopBudgetLimits = { maxRounds: 1000, maxMinutes: 1 };
    const startedInLeapSecond = ledger({
      stopBudget: {
        roundMarkers: [marker(1)],
        firstRoundAt: '2016-12-31T23:59:60.500Z',
        exhausted: false,
      },
    });

    const justBeforeBoundary = attachStopBudgetState(
      startedInLeapSecond,
      ledger(),
      timeLimited,
      marker(2),
      '2017-01-01T00:00:59.499Z',
    );
    const atBoundary = attachStopBudgetState(
      startedInLeapSecond,
      ledger(),
      timeLimited,
      marker(2),
      '2017-01-01T00:00:59.500Z',
    );
    const afterBoundary = attachStopBudgetState(
      startedInLeapSecond,
      ledger(),
      timeLimited,
      marker(2),
      '2017-01-01T00:00:59.501Z',
    );

    expect(justBeforeBoundary.stopBudget?.exhausted).toBe(false);
    expect(atBoundary.stopBudget?.exhausted).toBe(true);
    expect(afterBoundary.stopBudget?.exhausted).toBe(true);
  });

  it('should fail fast for an invalid stored time origin and honor a normalized offset origin', () => {
    const timeLimited: ResolvedStopBudgetLimits = { maxRounds: 1000, maxMinutes: 1 };
    const invalidPrevious = ledger({
      stopBudget: { roundMarkers: [marker(1)], firstRoundAt: 'not-a-timestamp', exhausted: false },
    });
    expect(() => attachStopBudgetState(
      invalidPrevious,
      ledger(),
      timeLimited,
      marker(2),
      '2026-07-01T00:10:00.000Z',
    )).toThrow('Expected an RFC 3339 timestamp');

    const offsetPrevious = ledger({
      stopBudget: { roundMarkers: [marker(1)], firstRoundAt: '2026-07-01T02:00:00+02:00', exhausted: false },
    });
    expect(attachStopBudgetState(
      offsetPrevious,
      ledger(),
      timeLimited,
      marker(2),
      '2026-07-01T00:01:00.000Z',
    ).stopBudget?.exhausted).toBe(true);
  });

  it('builds on the freshest persisted marker set, so a concurrent round that already added its own marker is preserved alongside this round (monotonic, no lost update)', () => {
    const concurrentMarker = computeRoundMarker({ runId: 'run-other', callNamespace: '', parentStepName: 'reviewers', stepIteration: 9, publicationIds: ['publication-1'] });
    const previous = ledger({ stopBudget: { roundMarkers: [marker(1), concurrentMarker], firstRoundAt: '2026-07-01T00:00:00.000Z', exhausted: false } });
    const result = attachStopBudgetState(previous, ledger(), limits, marker(2), '2026-07-01T00:10:00.000Z');
    expect(stopBudgetRoundsCompleted(result)).toBe(3);
    expect(result.stopBudget?.roundMarkers).toEqual([marker(1), marker(2), concurrentMarker].sort());
  });
});

// ---------------------------------------------------------------------------
// 往復ラウンドテスト: runFindingManagerForStep を実際に複数回呼ぶ
// ---------------------------------------------------------------------------

const FIXTURE_CWD = mkdtempSync(join(tmpdir(), 'takt-stop-budget-fixtures-'));
const publicationDirs = new Set<string>();
function makePublicationDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  publicationDirs.add(directory);
  return directory;
}
function writeFixtureFile(relativePath: string, lineCount: number): void {
  const fullPath = join(FIXTURE_CWD, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join('\n')}\n`);
}
writeFixtureFile('src/real.ts', 60);
execFileSync('git', ['init', '--quiet'], { cwd: FIXTURE_CWD });
execFileSync('git', ['add', 'src/real.ts'], { cwd: FIXTURE_CWD });
execFileSync('git', ['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: FIXTURE_CWD });

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
  for (const directory of publicationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeRoundHarness(
  initialLedger: FindingLedger,
  stopBudget?: FindingContractStopBudgetConfig,
  // A real `takt resume` mints a fresh run slug (= runId); resumed harnesses
  // pass a distinct prefix so their round markers do not collide with the
  // prior process's markers (which would wrongly dedupe a genuine new round).
  runIdPrefix = 'run',
): {
  currentLedger: () => FindingLedger;
  run: (reviewerRawFindings: Array<Record<string, unknown>>, timestamp: string) => ReturnType<typeof runFindingManagerForStep>;
} {
  const ledgerRepository = new RevisionedFindingLedgerTestRepository(
    initialLedger.findings.length > 0
      && (initialLedger.lifecycleEvents?.length ?? 0) === 0
      ? authorizeFindingLedgerFixture(initialLedger)
      : initialLedger,
  );
  const publicationReportDir = makePublicationDir('takt-stop-budget-publication-');
  const ledgerStore: FindingLedgerStore = {
    ledgerIdentity: '/test/finding-stop-budget/ledger.json',
    workflowName: 'peer-review',
    loadLedger: () => ledgerRepository.loadLedger(),
    updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
    interpretationLiveClaims: processInterpretationLiveClaims,
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
  const optionsBuilder = {
    buildAgentOptions: () => ({}),
    resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }),
  };
  const stepExecutor = {
    buildPhase1Instruction: (instruction: string) => instruction,
    normalizeStructuredOutput: (_step: WorkflowStep, response: AgentResponse) => response,
    recordSynthesizedAgentUsage: () => {},
  };
  const parentStep: WorkflowStep = { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep;
  const contract = {
    manager: {
      persona: 'findings-manager',
      instruction: 'Reconcile findings.',
      outputContract: 'Return JSON.',
    },
    adjudicator: { persona: 'findings-supervisor' },
    ...(stopBudget !== undefined ? { stopBudget } : {}),
  };
  let round = 0;
  return {
    currentLedger: () => ledgerRepository.loadLedger(),
    run: (reviewerRawFindings, timestamp) => {
      round += 1;
      const reportContent = [
        ...reviewerRawFindings.map((item) => String(item.rawExcerpt ?? '')),
        '**APPROVE**',
      ].join('\n');
      const subResults: FindingManagerSubStepResult[] = [{
        subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
        publication: createFindingReviewPublication({
          identity: {
            scopeIdentity: ledgerStore.ledgerIdentity,
            callNamespace: '',
            parentStepName: parentStep.name,
            stepIteration: round,
            reviewerStepName: 'arch-review',
            reportName: 'arch-review.md',
          },
          protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
          reportContent,
          rawFindings: reviewerRawFindings,
        }),
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
        workflowTask: 'Review the implementation.',
        runId: `${runIdPrefix}-${round}`,
        callNamespace: '',
        timestamp,
      });
    },
  };
}

// codex 対策#4: 幻覚 location（存在しないファイルへの claim）は verbatimExcerpt
// 機械照合により reviewer anomaly（review-integrity 側、product gate
// 非ブロッキング）へ隔離されるようになったため、この churn/budget e2e 群の
// 「gate-blocking な provisional を作る」役割はもう果たせない（意図した修正）。
// 構造的に矛盾した persists 参照（raw-meaning-ambiguous）で代替する — `path`
// 引数は実ファイルパスの代わりに識別用の distinguishing marker として使う
// （呼び出し側のシグネチャ・churn/repeat のセマンティクスは変えない）。
function hallucinatedRaw(rawFindingId: string, title: string, path: string): Record<string, unknown> {
  return reviewerRawExtractionFixture({
    rawFindingId,
    familyTag: 'bug',
    severity: 'high',
    title,
    description: `Claims to persist a finding id the ledger has never seen (${path}).`,
    suggestion: '',
    relation: 'persists',
    targetFindingId: `F-fake-${path}`,
    target: { kind: 'code', paths: [path] },
    evidenceRequests: [],
  });
}

/** ambiguous ladder の interpretation 呼び出しへの汎用応答（'provisional' 提案）。 */
function interpretationRunAgentResponse(instruction: string): AgentResponse {
  const match = /"caseId":\s*"([^"]+)"/.exec(instruction);
  const caseId = match?.[1];
  if (caseId === undefined) {
    throw new Error(`Test setup error: caseId not found in interpretation instruction: ${instruction}`);
  }
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    structuredOutput: {
      decisions: [
        {
          caseId,
          decision: {
            kind: 'provisional',
            reason: 'Cannot determine the identity of this re-report.',
          },
        },
      ],
    },
    timestamp: new Date(),
  } as unknown as AgentResponse;
}

function entityBindingRunAgentResponse(instruction: string): AgentResponse {
  const manifest = findingManagerTaskManifest(instruction) as ReturnType<
    typeof findingManagerTaskManifest
  > & { ownedRawFindingIds: string[] };
  const groupRawFindingId = manifest.ownedRawFindingIds[0];
  if (groupRawFindingId === undefined) {
    throw new Error('Test setup error: entity binding task owns no raw findings');
  }
  return {
    persona: 'findings-manager',
    status: 'done',
    content: '',
    structuredOutput: {
      taskId: manifest.taskId,
      decisions: manifest.ownedRawFindingIds.map((rawFindingId) => ({
        rawFindingId,
        decision: 'new_entity',
        findingId: '',
        groupRawFindingId,
        reason: 'The raw observation requires lifecycle interpretation.',
      })),
    },
    timestamp: new Date(),
  } as AgentResponse;
}

function semanticLifecycleRunAgentResponse(instruction: string): AgentResponse {
  const match = /## Owned raw findings\n(`{3,})json\n([\s\S]*?)\n\1/.exec(instruction);
  if (match?.[2] === undefined) {
    throw new Error('Test setup error: semantic lifecycle task input is missing');
  }
  const rawFindings = JSON.parse(match[2]) as Array<{
    rawFindingId: string;
    relation: string;
    targetFindingId: string | null;
  }>;
  return findingManagerTaskResponse(instruction, {
    rawDecisions: rawFindings.map((rawFinding) => {
      if (
        rawFinding.relation !== 'resolution_confirmation'
        || rawFinding.targetFindingId === null
      ) {
        throw new Error('Test setup error: unexpected semantic lifecycle raw finding');
      }
      return {
        decision: 'resolved',
        rawFindingId: rawFinding.rawFindingId,
        findingId: rawFinding.targetFindingId,
        evidence: 'The materialized quote satisfies the original failure mode and required fix.',
      };
    }),
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  });
}

function managerRunAgentResponse(instruction: string): AgentResponse {
  if (instruction.startsWith('Adjudicate the durable provisional finding below.')) {
    return {
      persona: 'findings-supervisor',
      status: 'done',
      content: '{}',
      structuredOutput: {
        proposal: {
          kind: 'undetermined',
          rationale: 'The stop-budget fixture supplies no exact terminal authority.',
        },
      },
      timestamp: new Date(),
    } as AgentResponse;
  }
  if (instruction.includes('entity-binding contract below replaces')) {
    return entityBindingRunAgentResponse(instruction);
  }
  if (instruction.includes('## Owned raw findings')) {
    return semanticLifecycleRunAgentResponse(instruction);
  }
  return interpretationRunAgentResponse(instruction);
}

function emptyLedger(): FindingLedger {
  return {
    workflowName: 'peer-review', nextId: 1, updatedAt: '2026-07-01T00:00:00.000Z',
    findings: [], evidenceRecords: [], rawFindings: [], conflicts: [],
    ...emptyFindingAuthorityProjection(),
  };
}

describe('runFindingManagerForStep across rounds: churn that never reaches fixpoint', () => {
  it('a churn series (a new, different hallucination every round) never reaches fixpoint, but the round budget stops it in finite rounds', async () => {
    const harness = makeRoundHarness(emptyLedger(), { maxRounds: 3 });

    await harness.run([hallucinatedRaw('r1', 'Bug in file A', 'src/does-not-exist-a.ts')], '2026-07-01T00:00:00.000Z');
    let context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.rounds.budgetExhausted).toBe(false);

    await harness.run([hallucinatedRaw('r2', 'Bug in file B', 'src/does-not-exist-b.ts')], '2026-07-01T00:01:00.000Z');
    context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.rounds.budgetExhausted).toBe(false);

    await harness.run([hallucinatedRaw('r3', 'Bug in file C', 'src/does-not-exist-c.ts')], '2026-07-01T00:02:00.000Z');
    context = buildFindingsRuleContext(harness.currentLedger());
    // Churn is real: the reviewer-anomaly set is different every round, while
    // provisional fixpoint intentionally ignores that separate ledger.
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.provisional.count).toBe(0);
    // Every round's review registration settles that reviewer's earlier anomalies as
    // withdrawn, so only the newest observation is still outstanding — the audit records
    // themselves are never removed.
    expect(context.reviewerAnomalies.count).toBe(1);
    const anomalies = harness.currentLedger().reviewerAnomalies ?? [];
    expect(anomalies).toHaveLength(3);
    expect(anomalies.filter((anomaly) => anomaly.settlement?.kind === 'withdrawn_by_subsequent_review'))
      .toHaveLength(2);
    // The bounded stop budget fires independently of reviewer-anomaly intake:
    // 3 completed rounds reached the configured maxRounds.
    expect(context.rounds.budgetExhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(3);
  });

  it('repeated intake anomalies do not create a provisional fixpoint before the round budget', async () => {
    const harness = makeRoundHarness(emptyLedger(), { maxRounds: 10 });

    await harness.run([hallucinatedRaw('r1', 'Same bug', 'src/does-not-exist.ts')], '2026-07-01T00:00:00.000Z');
    await harness.run([hallucinatedRaw('r2', 'Same bug', 'src/does-not-exist.ts')], '2026-07-01T00:01:00.000Z');
    await harness.run([hallucinatedRaw('r3', 'Same bug', 'src/does-not-exist.ts')], '2026-07-01T00:02:00.000Z');
    await harness.run([hallucinatedRaw('r4', 'Same bug', 'src/does-not-exist.ts')], '2026-07-01T00:03:00.000Z');
    await harness.run([], '2026-07-01T00:04:00.000Z');
    await harness.run([], '2026-07-01T00:05:00.000Z');

    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.provisional.count).toBe(0);
    // The repeated claim is re-recorded as a fresh episode every round it is observed and
    // settled as withdrawn by the next registered review; the two clean rounds at the end
    // leave nothing outstanding.
    expect(context.reviewerAnomalies.count).toBe(0);
    const anomalies = harness.currentLedger().reviewerAnomalies ?? [];
    expect(anomalies.length).toBeGreaterThanOrEqual(4);
    expect(anomalies.every((anomaly) => (
      anomaly.settlement?.kind === 'withdrawn_by_subsequent_review'
    ))).toBe(true);
    expect(context.rounds.budgetExhausted).toBe(false);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(6);
  });

  it('progress (a substantive finding resolving) does not reset the round budget — it accumulates monotonically alongside the churn', async () => {
    const seedRaw = canonicalRawFindingFixture({
      rawFindingId: 'raw-seed',
      stepName: 'reviewers',
      reviewer: 'arch-review',
      familyTag: 'bug',
      severity: 'medium',
      title: 'Real, fixable issue',
      description: 'A genuine issue that the fixer can and will resolve.',
      suggestion: null,
      relation: 'new',
      targetFindingId: null,
      target: { kind: 'code', paths: ['src/real.ts'] },
      evidence: [],
    });
    const seeded: FindingLedger = {
      workflowName: 'peer-review', nextId: 2, updatedAt: '2026-07-01T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        target: seedRaw.target,
        targetIdentityHash: seedRaw.targetIdentityHash,
        claimIdentityHash: seedRaw.claimIdentityHash,
        semanticClaimIdentityHash: seedRaw.semanticClaimIdentityHash,
        severity: 'medium',
        title: 'Real, fixable issue',
        evidenceIds: [],
        description: 'A genuine issue that the fixer can and will resolve.',
        reviewers: ['arch-review'],
        rawFindingIds: ['raw-seed'],
        firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-07-01T00:00:00.000Z' },
        revision: 1,
      }],
      evidenceRecords: [],
      rawFindings: [seedRaw],
      conflicts: [],
      ...emptyFindingAuthorityProjection(),
    };
    const harness = makeRoundHarness(seeded, { maxRounds: 3 });

    // Round 1: churn hallucination + real progress (F-0001 confirmed resolved).
    await harness.run([
      hallucinatedRaw('r1', 'Bug in file A', 'src/does-not-exist-a.ts'),
      reviewerRawExtractionFixture({
        rawFindingId: 'confirm-1',
        familyTag: 'bug',
        severity: 'medium',
        title: 'Real, fixable issue',
        description: 'Verified: the fix removes the issue.',
        suggestion: null,
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        // confirmation は検証済み file_quote 証跡が
        // 無いと resolve できない。
        evidence: [verifiedSourceQuoteFields(FIXTURE_CWD, 'src/real.ts', 10)],
      }),
    ], '2026-07-01T00:00:00.000Z');
    expect(harness.currentLedger().findings.find((f) => f.id === 'F-0001')?.status).toBe('resolved');
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(1);

    await harness.run([hallucinatedRaw('r2', 'Bug in file B', 'src/does-not-exist-b.ts')], '2026-07-01T00:01:00.000Z');
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(2);

    await harness.run([hallucinatedRaw('r3', 'Bug in file C', 'src/does-not-exist-c.ts')], '2026-07-01T00:02:00.000Z');
    // The real progress in round 1 did NOT reset the counter — it still hit
    // the configured maxRounds of 3 on schedule, and the churn keeps fixpoint
    // from ever firing.
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.rounds.budgetExhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(3);
  });

  it('resume continuity: a fresh harness (new run slug) inheriting a ledger that already carries rounds continues accumulating instead of resetting to 1', async () => {
    const priorProcess = makeRoundHarness(emptyLedger(), { maxRounds: 3 });
    await priorProcess.run([hallucinatedRaw('r1', 'Bug in file A', 'src/does-not-exist-a.ts')], '2026-07-01T00:00:00.000Z');
    await priorProcess.run([hallucinatedRaw('r2', 'Bug in file B', 'src/does-not-exist-b.ts')], '2026-07-01T00:01:00.000Z');
    const ledgerFromPriorProcess = priorProcess.currentLedger();
    expect(stopBudgetRoundsCompleted(ledgerFromPriorProcess)).toBe(2);
    expect(ledgerFromPriorProcess.stopBudget?.exhausted).toBe(false);

    // A brand new harness (simulating `takt resume`, which mints a fresh run
    // slug) starts from the persisted ledger, not from an empty one — its new
    // review round carries a distinct marker and is counted once more.
    const resumedProcess = makeRoundHarness(ledgerFromPriorProcess, { maxRounds: 3 }, 'resume');
    await resumedProcess.run([hallucinatedRaw('r3', 'Bug in file C', 'src/does-not-exist-c.ts')], '2026-07-01T00:02:00.000Z');

    expect(stopBudgetRoundsCompleted(resumedProcess.currentLedger())).toBe(3);
    expect(buildFindingsRuleContext(resumedProcess.currentLedger()).rounds.budgetExhausted).toBe(true);
  });

  it('crash/replay idempotency: replaying the IDENTICAL round (same runId/step/iteration) through runFindingManagerForStep does not double-count the round', async () => {
    // A harness whose `run` reuses the same runId+stepIteration every call
    // models the exact "commit the same round twice" crash/replay: the ledger
    // was persisted (round counted), then the identical invocation re-runs and
    // re-commits before the workflow checkpoint advanced.
    const ledgerRepository = new RevisionedFindingLedgerTestRepository(emptyLedger());
    const publicationReportDir = makePublicationDir('takt-stop-budget-replay-publication-');
    const ledgerStore: FindingLedgerStore = {
      ledgerIdentity: '/test/finding-stop-budget/integrity-ledger.json',
      workflowName: 'peer-review',
      loadLedger: () => ledgerRepository.loadLedger(),
      updateLedger: (mutator) => ledgerRepository.updateLedger(mutator),
      interpretationLiveClaims: processInterpretationLiveClaims,
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
    const contract = {
      manager: { persona: 'findings-manager', instruction: 'Reconcile.', outputContract: 'JSON.' },
      adjudicator: { persona: 'findings-supervisor' },
      stopBudget: { maxRounds: 5 },
    };
    const sameRoundRawFindings = [hallucinatedRaw('r1', 'Bug in file A', 'src/does-not-exist-a.ts')];
    const sameRoundPublication = createFindingReviewPublication({
      identity: {
        scopeIdentity: ledgerStore.ledgerIdentity,
        callNamespace: '',
        parentStepName: 'reviewers',
        stepIteration: 1,
        reviewerStepName: 'arch-review',
        reportName: 'arch-review.md',
      },
      protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
      reportContent: String(sameRoundRawFindings[0]!.rawExcerpt),
      rawFindings: sameRoundRawFindings,
    });
    const runSameRound = (timestamp: string) => runFindingManagerForStep({
      contract: contract as never,
      ledgerStore,
      optionsBuilder: { buildAgentOptions: () => ({}), resolveStepProviderModel: () => ({ provider: 'codex', model: 'gpt-test' }) } as never,
      stepExecutor: { buildPhase1Instruction: (i: string) => i, normalizeStructuredOutput: (_s: WorkflowStep, r: AgentResponse) => r } as never,
      cwd: FIXTURE_CWD,
      parentStep: { kind: 'agent', name: 'reviewers', persona: 'reviewer', edit: false } as WorkflowStep,
      // Same stepIteration + same runId on every call = the same round identity.
      stepIteration: 1,
      subResults: [{
        subStep: { kind: 'agent', name: 'arch-review', persona: 'arch', edit: false } as WorkflowStep,
        publication: sameRoundPublication,
      }],
      workflowName: 'peer-review',
      workflowTask: 'Review the implementation.',
      runId: 'run-crashed',
      callNamespace: '',
      timestamp,
    });

    await runSameRound('2026-07-01T00:00:00.000Z');
    expect(stopBudgetRoundsCompleted(ledgerRepository.loadLedger())).toBe(1);
    // Replay the identical round (post-crash, pre-checkpoint re-execution).
    await runSameRound('2026-07-01T00:05:00.000Z');
    expect(stopBudgetRoundsCompleted(ledgerRepository.loadLedger())).toBe(1);
    // A third replay still does not advance the counter.
    await runSameRound('2026-07-01T00:10:00.000Z');
    expect(stopBudgetRoundsCompleted(ledgerRepository.loadLedger())).toBe(1);
    expect(ledgerRepository.loadLedger().stopBudget?.roundMarkers).toHaveLength(1);
  });

  it('time budget: a churn series that stays well under the round cap is still stopped once elapsed wall-clock time exceeds maxMinutes', async () => {
    const harness = makeRoundHarness(emptyLedger(), { maxRounds: 1000, maxMinutes: 30 });

    await harness.run([hallucinatedRaw('r1', 'Bug in file A', 'src/does-not-exist-a.ts')], '2026-07-01T00:00:00.000Z');
    expect(buildFindingsRuleContext(harness.currentLedger()).rounds.budgetExhausted).toBe(false);

    // 29 minutes after the first round: still within the time budget.
    await harness.run([hallucinatedRaw('r2', 'Bug in file B', 'src/does-not-exist-b.ts')], '2026-07-01T00:29:00.000Z');
    expect(buildFindingsRuleContext(harness.currentLedger()).rounds.budgetExhausted).toBe(false);

    // 30 minutes after the first round: the time budget fires even though
    // only 3 of the 1000 allotted rounds have run.
    await harness.run([hallucinatedRaw('r3', 'Bug in file C', 'src/does-not-exist-c.ts')], '2026-07-01T00:30:00.000Z');
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.provisional.fixpoint).toBe(false);
    expect(context.rounds.budgetExhausted).toBe(true);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(3);
  });

  it('an all-clear round never marks the budget exhausted purely from round count on round 1 (sanity: budget requires actually reaching the configured threshold)', async () => {
    const harness = makeRoundHarness(emptyLedger(), { maxRounds: 3 });
    await harness.run([], '2026-07-01T00:00:00.000Z');
    const context = buildFindingsRuleContext(harness.currentLedger());
    expect(context.rounds.budgetExhausted).toBe(false);
    expect(stopBudgetRoundsCompleted(harness.currentLedger())).toBe(1);
  });
});
