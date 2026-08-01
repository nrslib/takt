/**
 * Engine-level coverage for the finding-conflict-adjudication synthetic step
 * (Phase B of the Finding Contract convergence design): a workflow rule
 * pointing `next: finding-conflict-adjudication` must run the detour
 * (core/workflow/engine/WorkflowRunLoop.ts's runFindingConflictAdjudicationDetour)
 * without ever needing a literal "finding-conflict-adjudication" entry in
 * config.steps, apply the outcome to the ledger, and resume the state machine
 * at the originating step (finding_stale/evidence_invalid), the fix path
 * (finding_valid with an actionableFix), or ABORT (undetermined / finding_valid
 * without a fix) — mirroring the real "no rule matched -> abort" shape used
 * throughout WorkflowEngine. Also covers the reviewer relation-coherence
 * regeneration (design item 3 remainder) through the single-step intake path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  // cursor は structured output 非対応の provider として振る舞わせる
  // （rate-limit fallback 先の capability 判定テストで使う）。
  getProvider: vi.fn((provider: string) => ({ supportsStructuredOutput: provider !== 'cursor' })),
}));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/phase-runner.js')>();
  return {
    ...actual,
    runReportPhase: vi.fn().mockResolvedValue(undefined),
    runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
  };
});

// 実装をそのまま通しつつ、WorkflowEngine が runner へ渡す deps（特に
// workflowName — 継承時は台帳 store の正準名でなければならない）を観測する。
vi.mock('../core/workflow/findings/adjudication-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/adjudication-runner.js')>();
  return {
    ...actual,
    createFindingConflictAdjudicationRunner: vi.fn(actual.createFindingConflictAdjudicationRunner),
  };
});

import { WorkflowEngine } from './helpers/workflow-engine.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { createFindingConflictAdjudicationRunner } from '../core/workflow/findings/adjudication-runner.js';
import { reserveFindingConflictAdjudication } from '../core/workflow/findings/adjudication-reservation.js';
import {
  verifiedFindingEvidenceFixture,
  verifiedSourceQuoteFields,
} from './helpers/finding-evidence.js';
import {
  authorizeFindingLedgerFixture,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

function isAdjudicationSchema(outputSchema: unknown): boolean {
  if (outputSchema === undefined) {
    return false;
  }
  const schemaText = JSON.stringify(outputSchema);
  return (
    schemaText.includes('"outcome"')
    && schemaText.includes('"finding_stale"')
    && schemaText.includes('"evidence_invalid"')
  );
}

function managerTaskManifest(instruction: string): Record<string, unknown> | undefined {
  const match = /## Task manifest\s+```json\s+([\s\S]*?)\s+```/.exec(instruction);
  if (match?.[1] === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function conflictAdjudicationReservations(ledger: {
  lifecycleReservations: Array<{
    mutationId: string;
    context: { kind: string; originStep?: string | null };
  }>;
}) {
  return ledger.lifecycleReservations.filter(
    (reservation) => reservation.context.kind === 'conflict_adjudication',
  );
}

function conflictAdjudicationEvents(ledger: {
  lifecycleEvents: Array<{
    mutationId: string;
    outcome: { kind: string };
  }>;
}) {
  return ledger.lifecycleEvents.filter(
    (event) => event.outcome.kind === 'conflict_adjudication',
  );
}

function createTestTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-adjudication-engine-'));
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(dir, 'src', 'secret.ts'), Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  mkdirSync(join(dir, 'personas'), { recursive: true });
  writeFileSync(join(dir, 'personas', 'supervisor.md'), SUPERVISOR_PERSONA_BODY);
  initializeGitFixture(dir, ['src/a.ts', 'src/secret.ts', 'personas/supervisor.md']);
  return dir;
}

// codex B6: the adjudication step must load the supervisor facet BODY (via
// personaPath), not just carry the persona name. The engine tests assert the
// path reaches the (mocked) runner; the un-mocked prompt assembly is covered
// in finding-conflict-adjudication-runner.test.ts.
const SUPERVISOR_PERSONA_BODY = '# Supervisor\nYou are the supervising adjudicator persona used in tests.\n';

function supervisorPersonaPath(cwd: string): string {
  return join(cwd, 'personas', 'supervisor.md');
}

function reviewerExtraction(
  raw: Record<string, unknown>,
  rawExcerpt: string,
): Record<string, unknown> {
  const finding = raw as Partial<import('../core/workflow/findings/types.js').RawFinding>;
  return reviewerRawExtractionFixture({
    rawFindingId: typeof finding.rawFindingId === 'string' ? finding.rawFindingId : null,
    familyTag: typeof finding.familyTag === 'string' ? finding.familyTag : null,
    severity: finding.severity ?? null,
    title: typeof finding.title === 'string' ? finding.title : null,
    description: typeof finding.description === 'string' ? finding.description : null,
    suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : null,
    relation: finding.relation ?? null,
    targetFindingId: typeof finding.targetFindingId === 'string' && finding.targetFindingId !== ''
      ? finding.targetFindingId
      : null,
    target: finding.target,
    evidence: finding.evidence,
    rawExcerpt,
  });
}

function createLedgerStore(
  cwd: string,
  workflowName = 'adjudication-engine-test',
  runId = 'test-report-dir',
): FindingLedgerStore {
  return createTestFindingLedgerStore({
    projectCwd: cwd,
    runId,
    reportDir: join(cwd, '.takt', 'runs', runId, 'reports'),
    workflowName,
  });
}

function baseConfig(cwd: string, rules: ReturnType<typeof makeRule>[]): WorkflowConfig {
  return {
    name: 'adjudication-engine-test',
    maxSteps: 6,
    initialStep: 'reviewers',
    provider: 'claude',
    findingContract: {
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
      adjudicator: {
        persona: 'supervisor',
        personaPath: supervisorPersonaPath(cwd),
        personaDisplayName: 'supervisor',
        providerRoutingPersonaKey: 'supervisor',
      },
    },
    steps: [
      makeStep({
        name: 'reviewers',
        persona: 'coding-reviewer',
        instruction: 'Review the code.',
        rules,
      }),
    ],
  };
}

describe('finding-conflict-adjudication engine detour', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTestTmpDir();
    vi.clearAllMocks();
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  const seedLedger = async (
    workflowName = 'adjudication-engine-test',
  ): Promise<FindingLedgerStore> => {
    const evidence = verifiedFindingEvidenceFixture({
      cwd,
      path: 'src/a.ts',
      startLine: 5,
      title: 'Disputed issue',
      description: 'Reviewers disagree about F-0001.',
      familyTag: 'bug',
      targetFindingId: 'F-0001',
    });
    const seededLedger = authorizeFindingLedgerFixture({
      workflowName,
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'high',
        title: 'Disputed issue',
        evidenceIds: [evidence.record.evidenceId],
        reviewers: ['coding-review'],
        rawFindingIds: ['raw-1'],
        firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      evidenceRecords: [evidence.record],
      rawFindings: [{
        rawFindingId: 'raw-1',
        stepName: 'reviewers',
        reviewer: 'coding-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Disputed issue',
        description: 'Reviewers disagree about F-0001.',
        suggestion: null,
        relation: 'persists',
        targetFindingId: 'F-0001',
        targetPrecondition: {
          targetFindingId: 'F-0001',
          targetRevision: 1,
          targetStatus: 'open',
          targetEvidenceHash: '0'.repeat(64),
        },
        evidence: [evidence.evidence],
      }],
      conflicts: [{
        id: 'C-FA2947446963',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: ['raw-1'],
        description: 'Reviewers disagree about F-0001.',
        firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        revision: 1,
      }],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawRecoveryAttempts: [],
      rawRecoveryResults: [],
      interpretations: [],
    });
    const store = createLedgerStore(cwd, workflowName);
    await store.updateLedger(() => ({ ledger: seededLedger, result: undefined }));
    return store;
  };

  const rules = [
    makeRule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
    makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
    makeRule('approved', 'COMPLETE'),
    makeRule('when(findings.conflicts.count == 0 && findings.open.count == 0)', 'COMPLETE'),
  ];

  it('finding_stale adjudication resolves the finding, resolves the conflict, and returns to reviewers which then completes', async () => {
    await seedLedger();

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      // reviewers' own phase 1 response, and its second pass after the
      // detour returns control here — both times it approves.
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const result = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();

    expect(result.status).toBe('completed');

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string; adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it.each([
    ['undetermined'],
    // finding_valid with a null actionableFix demonstrates no fixability and
    // must land on the ABORT side exactly like undetermined (codex design).
    ['finding_valid'],
  ] as const)('%s adjudication without an actionable fix keeps the conflict active and routes to ABORT', async (outcome) => {
    await seedLedger();

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome,
            actionableFix: null,
            rationale: 'Cannot state a concrete resolution from the evidence available.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const result = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();

    expect(result.status).toBe('aborted');

    const ledger = createLedgerStore(cwd).loadLedger() as {
      conflicts: Array<{ id: string; status: string; adjudications?: unknown[] }>;
    };
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
    // Adjudication for this conflict ran exactly once: only one call carried
    // the adjudication output schema (the "1回制限" gate holding within a
    // single run — a second reviewers pass never happens here because ABORT
    // terminates the workflow immediately).
    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      isAdjudicationSchema(options?.outputSchema)
    ));
    expect(adjudicationCalls).toHaveLength(1);
  });

  it('runSingleIteration でも合成ステップが Unknown step にならず実行・遷移できる (codex B4)', async () => {
    await seedLedger();

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const engine = new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });

    // 1回目: reviewers を実行し、遷移先が合成ステップになる
    const first = await engine.runSingleIteration();
    expect(first.isComplete).toBe(false);
    expect(first.nextStep).toBe('finding-conflict-adjudication');

    // 2回目: 合成ステップ自体が Unknown step エラーなく実行され、
    // finding_stale の結果 origin（reviewers）へ戻る
    const second = await engine.runSingleIteration();
    expect(second.nextStep).toBe('reviewers');
    expect(second.isComplete).toBe(false);

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
  });

  it('workflow_call 継承: 裁定 runner の workflowName は store の正準名（親名）を使い、台帳の workflowName が親名のまま保存される', async () => {
    // 親の台帳（workflowName: parent-workflow）を継承する子エンジンを模す。
    await seedLedger('parent-workflow');
    const parentLedgerStore = createLedgerStore(cwd, 'parent-workflow');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    // 子は自前の finding_contract を持たず、親から契約と store を継承する。
    const { findingContract: inheritedContract, ...childBase } = baseConfig(cwd, rules);
    const childConfig: WorkflowConfig = { ...childBase, name: 'child-of-parent' };

    const result = await new WorkflowEngine(childConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      inheritedFindingContract: {
        contract: inheritedContract!,
        ledgerStore: parentLedgerStore,
        managerAuthority: 'standard',
      },
    }).run();

    expect(result.status).toBe('completed');

    // WorkflowEngine は runner へ store の正準名（親名）を渡す。子の
    // config.name（child-of-parent）を渡すと reconcile 文脈が親の台帳の
    // workflowName と食い違う。
    const runnerDeps = vi.mocked(createFindingConflictAdjudicationRunner).mock.calls.at(-1)?.[0];
    expect(runnerDeps?.workflowName).toBe('parent-workflow');

    // 裁定適用と保存を経ても ledger.workflowName は親名のまま
    // （store の assertLedgerWorkflowName 検証を通る）。
    const ledger = createLedgerStore(cwd, 'parent-workflow').loadLedger() as {
      workflowName: string;
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string }>;
    };
    expect(ledger.workflowName).toBe('parent-workflow');
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
  });

  it('resume 相互作用: 別 run に継承した pending reservation を再利用して裁定を完遂する', async () => {
    await seedLedger();

    // 1走目: 裁定 LLM が中断相当の例外で死ぬ → run は runtime_error abort。
    // ただし lifecycle reservation は LLM 呼び出しの前に台帳へ記録済み。
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        throw new Error('interrupted mid-adjudication');
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const firstRun = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();
    expect(firstRun.status).toBe('aborted');

    const ledgerAfterInterrupt = createLedgerStore(cwd).loadLedger() as {
      lifecycleReservations: Array<{
        mutationId: string;
        context: { kind: string; originStep?: string | null };
      }>;
      lifecycleEvents: Array<{
        mutationId: string;
        outcome: { kind: string };
      }>;
    };
    expect(conflictAdjudicationReservations(ledgerAfterInterrupt)).toHaveLength(1);
    expect(conflictAdjudicationEvents(ledgerAfterInterrupt)).toHaveLength(0);

    // 2走目（resume 相当・同一 evidence）: 別 run に複製された pending reservation
    // を同じ mutationId のまま引き継ぎ、裁定を完遂する。
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T03:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T03:00:01.000Z'),
      };
    });

    // 別 run（異なる runId）として再開
    const secondRun = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir-resume',
      resumeSource: {
        sourceRunSlug: 'test-report-dir',
        resumeMode: 'retry',
      },
    }).run();
    expect(secondRun.status).toBe('completed');
    const adjudicatorCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      isAdjudicationSchema(options?.outputSchema)
    ));
    expect(adjudicatorCalls).toHaveLength(1);
    const resumedLedger = createLedgerStore(
      cwd,
      'adjudication-engine-test',
      'test-report-dir-resume',
    ).loadLedger();
    const reservations = conflictAdjudicationReservations(resumedLedger);
    const events = conflictAdjudicationEvents(resumedLedger);
    expect(reservations).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.mutationId).toBe(reservations[0]?.mutationId);
  });

  it('R1: 複数配線構成の resume（previousStep なし）でも pending attempt の originStep へ正しく戻る', async () => {
    // reviewers と final-gate の両方が adjudication を配線する構成。中断前の
    // run（同一 runId）は final-gate から遷移していた。resume が合成ステップ
    // から直接始まると previousStep が無く、旧実装は「配線元の最初」
    // （reviewers）へ誤遷移していた — reservation に永続化した originStep が
    // final-gate へ正しく戻す。
    await seedLedger();
    const ledgerStore = createLedgerStore(cwd);
    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore,
      conflictId: 'C-FA2947446963',
      requestedOriginStep: 'final-gate',
      runId: 'test-report-dir',
      observation: {
        runId: 'test-report-dir',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-13T01:00:00.000Z',
      },
      cwd,
    });
    expect(reservation.result.started).toBe(true);

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'gate ok',
        timestamp: new Date('2026-06-13T02:30:00.000Z'),
      };
    });

    const wiringRules = [
      makeRule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
      makeRule('when(findings.conflicts.count == 0 && findings.open.count == 0)', 'COMPLETE'),
      makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
    ];
    const config: WorkflowConfig = {
      ...baseConfig(cwd, wiringRules),
      steps: [
        makeStep({
          name: 'reviewers',
          persona: 'coding-reviewer',
          instruction: 'Review the code.',
          rules: wiringRules,
        }),
        makeStep({
          name: 'final-gate',
          persona: 'merge-readiness-reviewer',
          instruction: 'Judge merge readiness.',
          rules: wiringRules,
        }),
      ],
    };

    // resume 相当: 合成ステップから直接開始（previousStep なし）、同一 runId
    const result = await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      startStep: 'finding-conflict-adjudication',
    }).run();

    expect(result.status).toBe('completed');
    // origin は attempt の originStep（final-gate）— 配線元の最初（reviewers）ではない
    expect(result.stepOutputs.has('final-gate')).toBe(true);
    expect(result.stepOutputs.has('reviewers')).toBe(false);

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
      lifecycleReservations: Array<{
        mutationId: string;
        context: { kind: string; originStep?: string | null };
      }>;
      lifecycleEvents: Array<{
        mutationId: string;
        outcome: { kind: string };
      }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    // 同一 run の pending reservation は再利用され、二重記録されない (R2)
    const adjudicationReservations = conflictAdjudicationReservations(ledger);
    const adjudicationEvents = conflictAdjudicationEvents(ledger);
    expect(adjudicationReservations).toHaveLength(1);
    expect(adjudicationReservations[0]?.context.originStep).toBe('final-gate');
    expect(adjudicationEvents).toHaveLength(1);
    expect(adjudicationEvents[0]?.mutationId).toBe(adjudicationReservations[0]?.mutationId);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('R1: origin が一切解決できず配線元が複数なら推測せず ABORT する', async () => {
    // R1 テストと同じ複数配線構成だが、pending reservation に originStep が無い。
    // previousStep も runner 由来の origin も無く、配線元が
    // 2つで曖昧 — 推測して誤遷移する代わりに ABORT へ落とす。
    await seedLedger();
    const ledgerStore = createLedgerStore(cwd);
    const reservation = await reserveFindingConflictAdjudication({
      ledgerStore,
      conflictId: 'C-FA2947446963',
      requestedOriginStep: undefined,
      runId: 'test-report-dir',
      observation: {
        runId: 'test-report-dir',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-06-13T01:00:00.000Z',
      },
      cwd,
    });
    expect(reservation.result.started).toBe(true);

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'gate ok',
        timestamp: new Date('2026-06-13T02:30:00.000Z'),
      };
    });

    const wiringRules = [
      makeRule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
      makeRule('when(findings.conflicts.count == 0 && findings.open.count == 0)', 'COMPLETE'),
      makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
    ];
    const config: WorkflowConfig = {
      ...baseConfig(cwd, wiringRules),
      steps: [
        makeStep({ name: 'reviewers', persona: 'coding-reviewer', instruction: 'Review the code.', rules: wiringRules }),
        makeStep({ name: 'final-gate', persona: 'merge-readiness-reviewer', instruction: 'Judge merge readiness.', rules: wiringRules }),
      ],
    };

    const result = await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      startStep: 'finding-conflict-adjudication',
    }).run();

    // 裁定自体は適用されるが、戻り先が曖昧なため ABORT（誤遷移しない）
    expect(result.status).toBe('aborted');
    expect(result.stepOutputs.has('reviewers')).toBe(false);
    expect(result.stepOutputs.has('final-gate')).toBe(false);
  });

  it('R2(a): rate_limited → 同一 run の fallback 再実行が予約を引き継ぎ、代替 provider で裁定が完走する', async () => {
    await seedLedger();

    let adjudicationCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (isAdjudicationSchema(options?.outputSchema)) {
        adjudicationCallCount += 1;
        if (adjudicationCallCount === 1) {
          return {
            persona,
            status: 'rate_limited',
            content: '',
            error: 'Rate limit exceeded',
            timestamp: new Date('2026-06-13T02:00:00.000Z'),
          };
        }
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_stale',
            actionableFix: null,
            rationale: 'Verified fixed against current code at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:05:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const result = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      rateLimitFallback: { switchChain: [{ provider: 'codex' }] },
    }).run();

    expect(result.status).toBe('completed');
    expect(adjudicationCallCount).toBe(2);
    // 2回目の裁定呼び出しは fallback の代替 provider（codex）で実行される
    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      isAdjudicationSchema(options?.outputSchema)
    ));
    expect(adjudicationCalls[1]![2]?.resolvedProvider).toBe('codex');

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
      lifecycleReservations: Array<{
        mutationId: string;
        context: { kind: string; originStep?: string | null };
      }>;
      lifecycleEvents: Array<{
        mutationId: string;
        outcome: { kind: string };
      }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    // fallback は同じ lifecycle reservation を再利用し、完了 event も同じ mutation を参照する。
    const adjudicationReservations = conflictAdjudicationReservations(ledger);
    const adjudicationEvents = conflictAdjudicationEvents(ledger);
    expect(adjudicationReservations).toHaveLength(1);
    expect(adjudicationEvents).toHaveLength(1);
    expect(adjudicationEvents[0]?.mutationId).toBe(adjudicationReservations[0]?.mutationId);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('R2(a) 変形: structured output 非対応 provider（cursor）への fallback でフェンス方式の指示注入と正規化が代替 provider 基準で行われる', async () => {
    await seedLedger();

    let adjudicationCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const isAdjudicationCall = isAdjudicationSchema(options?.outputSchema)
        || instruction.includes('conflict C-FA2947446963');
      if (isAdjudicationCall) {
        adjudicationCallCount += 1;
        if (adjudicationCallCount === 1) {
          return {
            persona,
            status: 'rate_limited',
            content: '',
            error: 'Rate limit exceeded',
            timestamp: new Date('2026-06-13T02:00:00.000Z'),
          };
        }
        // cursor（非対応 provider）基準の呼び出し: structuredOutput フィールドは
        // 返さず、フェンス JSON を本文に載せる。正規化が cursor 基準で
        // 行われなければ（= claude 基準のままなら）structured output 欠落として
        // 落ち、run は完走できない。
        const fenced = JSON.stringify({
          conflictId: 'C-FA2947446963',
          outcome: 'finding_stale',
          actionableFix: null,
          rationale: 'Verified fixed against current code at src/a.ts:5.',
        }, null, 2);
        return {
          persona,
          status: 'done',
          content: '```json\n' + fenced + '\n```',
          timestamp: new Date('2026-06-13T02:05:00.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    });

    const result = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      rateLimitFallback: { switchChain: [{ provider: 'cursor' }] },
    }).run();

    expect(result.status).toBe('completed');
    expect(adjudicationCallCount).toBe(2);

    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, instruction, options]) => (
      isAdjudicationSchema(options?.outputSchema)
      || instruction.includes('conflict C-FA2947446963')
    ));
    // 1回目（claude・ネイティブ対応）: フェンス方式の契約は注入されない
    expect(adjudicationCalls[0]![1]).not.toContain('Return exactly one fenced JSON block');
    // 2回目（cursor・非対応）: JSON Schema 指示（フェンス方式）が代替 provider
    // 基準で注入される
    expect(adjudicationCalls[1]![2]?.resolvedProvider).toBe('cursor');
    expect(adjudicationCalls[1]![1]).toContain('Return exactly one fenced JSON block');
    expect(adjudicationCalls[1]![1]).toContain('"outcome"');
    expect(adjudicationCalls[1]![1]).not.toContain('"findingTransition"');

    // フェンス JSON の正規化（cursor 基準）を経て裁定が適用されている
    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[] }>;
      lifecycleReservations: Array<{
        mutationId: string;
        context: { kind: string; originStep?: string | null };
      }>;
      lifecycleEvents: Array<{
        mutationId: string;
        outcome: { kind: string };
      }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
    const adjudicationReservations = conflictAdjudicationReservations(ledger);
    const adjudicationEvents = conflictAdjudicationEvents(ledger);
    expect(adjudicationReservations).toHaveLength(1);
    expect(adjudicationEvents).toHaveLength(1);
    expect(adjudicationEvents[0]?.mutationId).toBe(adjudicationReservations[0]?.mutationId);
  });

  it('予約名: ユーザー定義の finding-conflict-adjudication ステップは設定エラー (codex B7)', () => {
    const config: WorkflowConfig = {
      name: 'reserved-name-test',
      maxSteps: 3,
      initialStep: 'finding-conflict-adjudication',
      provider: 'claude',
      steps: [
        makeStep({
          name: 'finding-conflict-adjudication',
          persona: 'someone',
          instruction: 'Impersonate the synthetic step.',
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).toThrow(/reserved/);
  });

  it('finding_contract なしで next: finding-conflict-adjudication を使うと設定エラー', () => {
    const config: WorkflowConfig = {
      name: 'no-contract-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      steps: [
        makeStep({
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'Review.',
          rules: [
            makeRule('needs adjudication', 'finding-conflict-adjudication'),
            makeRule('when(true)', 'COMPLETE'),
          ],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).toThrow(/requires finding_contract/);
  });

  it('loop monitor judge の rules からの合成名遷移も finding_contract を要求する (codex B7)', () => {
    const config: WorkflowConfig = {
      name: 'loop-judge-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      loopMonitors: [{
        cycle: ['reviewers', 'fix'],
        threshold: 2,
        judge: {
          persona: 'supervisor',
          personaDisplayName: 'supervisor',
          instruction: 'Judge the loop.',
          rules: [
            makeRule('still fixable', 'fix'),
            makeRule('needs adjudication', 'finding-conflict-adjudication'),
          ],
        },
      }],
      steps: [
        makeStep({
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'Review.',
          rules: [makeRule('when(true)', 'fix')],
        }),
        makeStep({
          name: 'fix',
          persona: 'coder',
          instruction: 'Fix.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).toThrow(/requires finding_contract/);
  });

  // サブステップの next はエンジンの遷移としては消費されない（ParallelRunner が
  // 集約し、遷移は親ステップの rules だけが決める）が、合成名への配線はステップ
  // 注入の条件に数えられるため、契約なしの配線は機構が無効なままの死んだ設定と
  // して validator が弾く（doctor 側の同じ境界チェックと揃える）。
  it('parallel サブステップの rules からの合成名遷移も finding_contract を要求する', () => {
    const config: WorkflowConfig = {
      name: 'parallel-sub-no-contract-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      steps: [
        makeStep({
          name: 'reviewers',
          parallel: [
            makeStep({
              name: 'sub-review',
              persona: 'reviewer',
              instruction: 'Review.',
              rules: [
                makeRule('needs adjudication', 'finding-conflict-adjudication'),
                makeRule('approved', 'COMPLETE'),
              ],
            }),
          ],
          rules: [makeRule('when(true)', 'COMPLETE')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).toThrow(/requires finding_contract/);
  });

  it('parallel サブステップの合成名配線は finding_contract + adjudicator があれば検証を通る', () => {
    const config: WorkflowConfig = {
      name: 'parallel-sub-with-contract-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: {
          persona: 'supervisor',
          personaPath: supervisorPersonaPath(cwd),
          personaDisplayName: 'supervisor',
          providerRoutingPersonaKey: 'supervisor',
        },
      },
      steps: [
        makeStep({
          name: 'reviewers',
          parallel: [
            makeStep({
              name: 'sub-review',
              persona: 'reviewer',
              instruction: 'Review.',
              outputContracts: [
                { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
              ],
              rules: [
                makeRule('needs adjudication', 'finding-conflict-adjudication'),
                makeRule('approved', 'COMPLETE'),
              ],
            }),
          ],
          rules: [
            // finding_contract 付き parallel 親に必須の invalid manager output
            // ルール（non-AI next: fix）。
            makeRule('needs_fix', 'fix'),
            makeRule('when(true)', 'COMPLETE'),
          ],
        }),
        makeStep({
          name: 'fix',
          persona: 'coder',
          instruction: 'Fix.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).not.toThrow();
  });

  it('loop monitor judge 経由の配線でも finding_contract + adjudicator があれば合成ステップが注入され検証を通る', () => {
    const config: WorkflowConfig = {
      name: 'adjudication-engine-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: {
          persona: 'supervisor',
          personaPath: supervisorPersonaPath(cwd),
          personaDisplayName: 'supervisor',
          providerRoutingPersonaKey: 'supervisor',
        },
      },
      loopMonitors: [{
        cycle: ['reviewers', 'fix'],
        threshold: 2,
        judge: {
          persona: 'supervisor',
          personaDisplayName: 'supervisor',
          instruction: 'Judge the loop.',
          rules: [
            makeRule('still fixable', 'fix'),
            makeRule('needs adjudication', 'finding-conflict-adjudication'),
          ],
        },
      }],
      steps: [
        makeStep({
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'Review.',
          rules: [makeRule('when(true)', 'fix')],
        }),
        makeStep({
          name: 'fix',
          persona: 'coder',
          instruction: 'Fix.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    })).not.toThrow();
  });

  it('finding_valid + actionableFix: conflict をレビュア側支持で解消し fix へ遷移、修正後の reviewers で COMPLETE まで到達する', async () => {
    await seedLedger();

    let reviewerCallCount = 0;
    let fixApplied = false;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (persona === 'findings-manager') {
        const manifest = managerTaskManifest(instruction);
        const rawFindings = Array.isArray(manifest?.rawFindings)
          ? manifest.rawFindings.filter(
              (item): item is Record<string, unknown> => (
                typeof item === 'object' && item !== null
              ),
            )
          : [];
        if (typeof manifest?.taskId === 'string' && rawFindings.length > 0) {
          return {
            persona,
            status: 'done',
            content: '',
            structuredOutput: {
              taskId: manifest.taskId,
              decisions: rawFindings.map((raw) => ({
                componentId: raw.componentId,
                rawFindingId: raw.rawFindingId,
                decision: typeof raw.rawFindingId === 'string'
                  && raw.rawFindingId.endsWith('raw-confirm')
                  ? 'resolved'
                  : 'same',
                findingId: 'F-0001',
                evidence: typeof raw.rawFindingId === 'string'
                  && raw.rawFindingId.endsWith('raw-confirm')
                  ? 'The null guard now prevents the disputed dereference.'
                  : 'This observation is the existing disputed finding.',
              })),
            },
            timestamp: new Date('2026-06-13T03:00:02.000Z'),
          };
        }
        const candidateIntents = Array.isArray(manifest?.candidateIntents)
          ? manifest.candidateIntents.filter(
              (item): item is Record<string, unknown> => (
                typeof item === 'object' && item !== null
              ),
            )
          : [];
        const conflictIntent = candidateIntents.find((intent) => intent.kind === 'conflict');
        if (
          typeof manifest?.taskId !== 'string'
          || typeof conflictIntent?.intentId !== 'string'
          || typeof conflictIntent.entityId !== 'string'
        ) {
          throw new Error(`Expected current conflict control task: ${instruction}`);
        }
        // active conflict は keep とし、合成 adjudication ステップへ委ねる。
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: {
            taskId: manifest.taskId,
            evaluations: [{
              intentId: conflictIntent.intentId,
              result: {
                kind: 'keep',
                conflictId: conflictIntent.entityId,
                evidence: 'Reviewers still disagree.',
              },
            }],
            selectedIntentId: conflictIntent.intentId,
          },
          timestamp: new Date('2026-06-13T00:00:02.000Z'),
        };
      }
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (isAdjudicationSchema(options?.outputSchema)) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-FA2947446963',
            outcome: 'finding_valid',
            actionableFix: 'Add the missing null guard before the dereference.',
            rationale: 'The reviewer is right: the guard is still missing at src/a.ts:5.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      if (schemaText.includes('"rawFindings"')) {
        reviewerCallCount += 1;
        if (!fixApplied) {
          // fix 前: 新しい raw は無い（conflict の裁定待ちだけの状態を再現）。
          return {
            persona,
            status: 'done',
            content: 'Review report body.',
            structuredOutput: {
              reportContent: 'Review report body.',
              rawFindings: [],
            },
            timestamp: new Date('2026-06-13T00:00:01.000Z'),
          };
        }
        // run 2（fix 後）: F-0001 の解消確認。機械分類だけで resolved になる。
        return {
          persona,
          status: 'done',
          content: 'Confirmed the fix.',
          structuredOutput: {
            reportContent: 'Confirmed the fix.',
            rawFindings: [reviewerExtraction({
              rawFindingId: 'raw-confirm',
              familyTag: 'bug',
              severity: 'high',
              title: 'Disputed issue',
              description: 'Verified the null guard is now present.',
              suggestion: '',
              relation: 'resolution_confirmation',
              targetFindingId: 'F-0001',
              // typed evidence protocol（codex 対策#4）: admission を通すには
              // 機械照合済み verbatimExcerpt が要る。無いと A-1 の audit-only
              // 経路に落ち、F-0001 が解消されない。
              evidence: [verifiedSourceQuoteFields(cwd, 'src/a.ts', 5)],
            }, 'Confirmed the fix.')],
          },
          timestamp: new Date('2026-06-13T03:00:01.000Z'),
        };
      }
      // fix ステップ本体
      if (persona === 'coder') {
        fixApplied = true;
      }
      return {
        persona,
        status: 'done',
        content: 'Applied the null guard fix.',
        timestamp: new Date('2026-06-13T02:30:00.000Z'),
      };
    });

    const config: WorkflowConfig = {
      name: 'adjudication-engine-test',
      maxSteps: 8,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: {
          persona: 'supervisor',
          personaPath: supervisorPersonaPath(cwd),
          personaDisplayName: 'supervisor',
          providerRoutingPersonaKey: 'supervisor',
        },
      },
      steps: [
        makeStep({
          name: 'reviewers',
          persona: 'coding-reviewer',
          instruction: 'Review the code.',
          outputContracts: [
            { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
          ],
          rules: [
            makeRule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
            makeRule('when(findings.conflicts.count == 0 && findings.open.count == 0)', 'COMPLETE'),
            makeRule('when(findings.conflicts.count == 0 && findings.open.count > 0)', 'fix'),
            makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
          ],
        }),
        makeStep({
          name: 'fix',
          persona: 'coder',
          instruction: 'Fix.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const result = await engine.run();

    expect(
      result.status,
      JSON.stringify({ abortReasons, reviewerCallCount }, null, 2),
    ).toBe('completed');
    // 裁定後の遷移先が fix（reviewers 再実行ではなく直接 fix ルート）
    expect(result.stepOutputs.has('fix')).toBe(true);

    // codex B1: unadjudicated conflict がある間は fix に直行しない —
    // fix ステップの実行は必ず裁定呼び出しの後。
    const calls = vi.mocked(runAgent).mock.calls;
    const adjudicationCallIndex = calls.findIndex(([, , options]) => (
      isAdjudicationSchema(options?.outputSchema)
    ));
    const fixCallIndex = calls.findIndex(([, instruction]) => instruction.includes('Fix.'));
    expect(adjudicationCallIndex).toBeGreaterThanOrEqual(0);
    expect(fixCallIndex).toBeGreaterThan(adjudicationCallIndex);

    // codex B6: 裁定呼び出しは supervisor facet の personaPath を伴う
    // （facet 本文を system prompt に載せるための経路）。
    const adjudicationOptions = calls[adjudicationCallIndex]![2];
    expect(adjudicationOptions?.personaPath).toBe(supervisorPersonaPath(cwd));

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ id: string; status: string; suggestion?: string }>;
      conflicts: Array<{
        id: string;
        status: string;
        resolvedEvidence?: string;
        adjudications?: Array<{ outcome: string; actionableFix: string; rationale?: string }>;
      }>;
    };
    // conflict は finding_valid の裁定で解消され、閉じた outcome と actionableFix が残る。
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.resolvedEvidence).toContain(': finding_valid');
    expect(ledger.conflicts[0]?.adjudications?.[0]?.outcome).toBe('finding_valid');
    expect(ledger.conflicts[0]?.adjudications?.[0]?.actionableFix).toContain('null guard');
    // finding は fix 後の解消確認で resolved。suggestion には fix ステップが
    // 読んだ actionableFix の追記が残っている
    const finding = ledger.findings.find((entry) => entry.id === 'F-0001');
    expect(finding?.status).toBe('resolved');
    expect(finding?.suggestion).toContain('[adjudicated fix] Add the missing null guard');
  });

  it('レビュア突き返し: correction で persists に直っても taint は消えず、target を変えず監査だけに残す（攻撃4対策）', async () => {
    // conflict なし・open F-0001 だけの台帳。reviewer が同じ問題を relation=new で
    // 再報告してくる（弱いモデルの典型挙動）ケース。
    const evidence = verifiedFindingEvidenceFixture({
      cwd,
      path: 'src/secret.ts',
      startLine: 12,
      title: 'Secret is logged',
      description: 'The code logs a token.',
      familyTag: 'security',
      targetFindingId: null,
    });
    const seededLedger = authorizeFindingLedgerFixture({
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'high',
        title: 'Secret is logged',
        target: { kind: 'code', paths: ['src/secret.ts'] },
        evidenceIds: [evidence.record.evidenceId],
        description: 'The code logs a token.',
        reviewers: ['review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      evidenceRecords: [evidence.record],
      rawFindings: [],
      conflicts: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawRecoveryAttempts: [],
      rawRecoveryResults: [],
      interpretations: [],
    });
    await createLedgerStore(cwd).updateLedger(() => ({
      ledger: seededLedger,
      result: undefined,
    }));

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (instruction.includes('contradictory relation/targetFindingIds labeling')) {
        // 突き返し呼び出し: relation を persists に直して全量再出力
        const rawExcerpt = 'Token logging is still present, observed at a new line.';
        return {
          persona,
          status: 'done',
          content: rawExcerpt,
          structuredOutput: {
            reportContent: rawExcerpt,
            rawFindings: [reviewerExtraction({
              rawFindingId: 'raw-1',
              familyTag: 'security',
              severity: 'high',
              title: 'Secret is logged',
              description: 'Token logging is still present, observed at a new line.',
              suggestion: '',
              relation: 'persists',
              targetFindingId: 'F-0001',
              // typed evidence protocol（codex 対策#4）: この raw は admission を
              // 通す必要がある（本テストの主眼は admission 後の taint 保持であって
              // admission 自体ではない）。評価対象は「証跡が成立しても taint は
              // 残る」ことなので、機械照合済み evidence を与える。
              evidence: [verifiedSourceQuoteFields(cwd, 'src/secret.ts', 40)],
            }, rawExcerpt)],
          },
          timestamp: new Date('2026-06-13T00:00:02.000Z'),
        };
      }
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"interpretations"')) {
        // ambiguous ladder の解釈フェーズ: taint された persists は target と
        // 関係があるが同一性は確定できない → open_conflict 提案（§5 規則3）。
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: {
            interpretations: [{
              decision: 'open_conflict',
              rawFindingId: instruction.match(/"rawFindingId":\s*"([^"]+raw-1)"/)?.[1] ?? '',
              proofId: '',
              targetFindingId: 'F-0001',
              reason: '',
            }],
          },
          timestamp: new Date('2026-06-13T00:00:02.500Z'),
        };
      }
      if (schemaText.includes('"rawFindings"')) {
        const rawExcerpt = 'Token logging is still present, observed at a new line.';
        return {
          persona,
          status: 'done',
          content: rawExcerpt,
          structuredOutput: {
            reportContent: rawExcerpt,
            rawFindings: [reviewerExtraction({
              rawFindingId: 'raw-1',
              familyTag: 'security',
              severity: 'high',
              title: 'Secret is logged',
              description: 'Token logging is still present, observed at a new line.',
              suggestion: '',
              relation: 'new',
              targetFindingId: 'F-0001',
              evidence: [verifiedSourceQuoteFields(cwd, 'src/secret.ts', 40)],
            }, rawExcerpt)],
          },
          timestamp: new Date('2026-06-13T00:00:01.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'ok',
        timestamp: new Date('2026-06-13T00:00:03.000Z'),
      };
    });

    const config: WorkflowConfig = {
      name: 'adjudication-engine-test',
      maxSteps: 3,
      initialStep: 'review',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        makeStep({
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review.',
          outputContracts: [
            { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
          ],
          rules: [
            makeRule('when(true)', 'COMPLETE'),
          ],
        }),
      ],
    };

    const result = await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();

    // correction で persists に直っても taint は消えない（攻撃4:
    // persists 洗浄の防止）。曖昧起源の lifecycle claim は product finding を
    // 変更せず、独立 finding / conflict / provisional を増殖させず監査だけに残す。
    expect(result.status).toBe('completed');
    // 突き返しが1回だけ走った
    const regenerationCalls = vi.mocked(runAgent).mock.calls.filter(([, instruction]) => (
      instruction.includes('contradictory relation/targetFindingIds labeling')
    ));
    expect(regenerationCalls).toHaveLength(1);

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ id: string; status: string; rawFindingIds: string[]; provisional?: { kind: string } }>;
      conflicts: Array<{ status: string; findingIds: string[] }>;
      rawFindings: Array<{ rawFindingId: string; relation: string; targetFindingId: string | null }>;
    };
    // F-0001 は不変（rawFindingIds へも合流していない = 洗浄されていない）。
    const target = ledger.findings.find((f) => f.id === 'F-0001');
    expect(target?.status).toBe('open');
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    expect(ledger.findings.some((f) => f.provisional !== undefined)).toBe(false);
    expect(ledger.conflicts).toEqual([]);
    expect(ledger.rawFindings.some((raw) => (
      raw.rawFindingId.endsWith(':raw-1')
      && raw.relation === 'persists'
      && raw.targetFindingId === 'F-0001'
    ))).toBe(true);

    const reportPath = join(cwd, '.takt', 'runs', 'test-report-dir', 'reports', 'findings-manager-validation.review.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      unsupportedRawFindings?: Array<{ rawFindingId: string; targetFindingId: string; evidence: string }>;
    };
    expect(report.unsupportedRawFindings?.some((entry) => (
      entry.rawFindingId.endsWith(':raw-1')
      && entry.targetFindingId === 'F-0001'
      && entry.evidence.includes('recorded for audit only')
    ))).toBe(true);
  });

  it('レビュア突き返し: 突き返し後も relation=new + target のままなら product finding を増やさず監査だけに残す', async () => {
    const evidence = verifiedFindingEvidenceFixture({
      cwd,
      path: 'src/secret.ts',
      startLine: 12,
      title: 'Secret is logged',
      description: 'The code logs a token.',
      familyTag: 'security',
      targetFindingId: null,
    });
    const seededLedger = authorizeFindingLedgerFixture({
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: 'high',
        title: 'Secret is logged',
        target: { kind: 'code', paths: ['src/secret.ts'] },
        evidenceIds: [evidence.record.evidenceId],
        description: 'The code logs a token.',
        reviewers: ['review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      evidenceRecords: [evidence.record],
      rawFindings: [],
      conflicts: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawRecoveryAttempts: [],
      rawRecoveryResults: [],
      interpretations: [],
    });
    await createLedgerStore(cwd).updateLedger(() => ({
      ledger: seededLedger,
      result: undefined,
    }));

    const incoherentRawExcerpt = 'Token logging is still present, observed at a new line.';
    const incoherentOutput = {
      rawFindings: [reviewerExtraction({
        rawFindingId: 'raw-1',
        familyTag: 'security',
        severity: 'high',
        title: 'Secret is logged',
        description: 'Token logging is still present, observed at a new line.',
        suggestion: '',
        relation: 'new',
        targetFindingId: 'F-0001',
        // typed evidence protocol（codex 対策#4）: この試験の主眼は「訂正しても
        // relation が直らない raw が ladder で provisional に着地する」ことで
        // あって admission ではないため、機械照合済み evidence を与えて
        // admission を通す（無いと ladder に届く前に anomaly へ隔離される）。
        evidence: [verifiedSourceQuoteFields(cwd, 'src/secret.ts', 40)],
      }, incoherentRawExcerpt)],
    };
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (instruction.includes('contradictory relation/targetFindingIds labeling')) {
        // 突き返しでも直さない（relation=new のまま返してくる）
        return {
          persona,
          status: 'done',
          content: incoherentRawExcerpt,
          structuredOutput: {
            reportContent: incoherentRawExcerpt,
            ...incoherentOutput,
          },
          timestamp: new Date('2026-06-13T00:00:02.000Z'),
        };
      }
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"interpretations"')) {
        // 解釈フェーズ: manager も判定不能 → provisional 提案。
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: {
            interpretations: [{
              decision: 'provisional',
              rawFindingId: instruction.match(/"rawFindingId":\s*"([^"]+raw-1)"/)?.[1] ?? '',
              proofId: '',
              targetFindingId: '',
              reason: 'Cannot determine whether this is the same issue as F-0001.',
            }],
          },
          timestamp: new Date('2026-06-13T00:00:02.500Z'),
        };
      }
      if (schemaText.includes('"rawFindings"')) {
        return {
          persona,
          status: 'done',
          content: incoherentRawExcerpt,
          structuredOutput: {
            reportContent: incoherentRawExcerpt,
            ...incoherentOutput,
          },
          timestamp: new Date('2026-06-13T00:00:01.000Z'),
        };
      }
      return {
        persona,
        status: 'done',
        content: 'ok',
        timestamp: new Date('2026-06-13T00:00:03.000Z'),
      };
    });

    const config: WorkflowConfig = {
      name: 'adjudication-engine-test',
      maxSteps: 3,
      initialStep: 'review',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
      },
      steps: [
        makeStep({
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review.',
          outputContracts: [
            { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
          ],
          rules: [
            makeRule('when(true)', 'COMPLETE'),
          ],
        }),
      ],
    };

    const result = await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    }).run();

    // 直らなかった raw は監査 raw として残るが、曖昧起源の lifecycle claim に
    // product finding を作成・変更する権限はないため通常完了できる。
    expect(result.status).toBe('completed');

    const ledger = createLedgerStore(cwd).loadLedger() as {
      findings: Array<{ id: string; rawFindingIds: string[]; provisional?: { kind: string } }>;
      conflicts: Array<unknown>;
      rawFindings: Array<{ rawFindingId: string; relation: string; targetFindingId: string | null }>;
    };
    // 確定 finding としては立たず、F-0001 にも合流していない。
    const target = ledger.findings.find((f) => f.id === 'F-0001');
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    expect(ledger.findings.some((f) => f.provisional !== undefined)).toBe(false);
    expect(ledger.conflicts).toEqual([]);
    expect(
      ledger.rawFindings.some((raw) => raw.rawFindingId.endsWith(':raw-1')),
      JSON.stringify(ledger.rawFindings, null, 2),
    ).toBe(true);

    // 検証レポートに audit-only の記録が残る。
    const reportPath = join(cwd, '.takt', 'runs', 'test-report-dir', 'reports', 'findings-manager-validation.review.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      unsupportedRawFindings?: Array<{ rawFindingId: string; targetFindingId: string; evidence: string }>;
    };
    expect(report.unsupportedRawFindings?.some((entry) => (
      entry.rawFindingId.endsWith(':raw-1')
      && entry.targetFindingId === 'F-0001'
      && entry.evidence.includes('recorded for audit only')
    ))).toBe(true);
  });
});
