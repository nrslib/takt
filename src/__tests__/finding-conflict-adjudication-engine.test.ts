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
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  // cursor は structured output 非対応の provider として振る舞わせる
  // （rate-limit fallback 先の capability 判定テストで使う）。
  getProvider: vi.fn((provider: string) => ({ supportsStructuredOutput: provider !== 'cursor' })),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
}));

// 実装をそのまま通しつつ、WorkflowEngine が runner へ渡す deps（特に
// workflowName — 継承時は台帳 store の正準名でなければならない）を観測する。
vi.mock('../core/workflow/findings/adjudication-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/adjudication-runner.js')>();
  return {
    ...actual,
    createFindingConflictAdjudicationRunner: vi.fn(actual.createFindingConflictAdjudicationRunner),
  };
});

import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import { createFindingLedgerStore, resolveFindingLedgerRoot } from '../core/workflow/findings/store.js';
import { createFindingConflictAdjudicationRunner } from '../core/workflow/findings/adjudication-runner.js';
import { computeConflictEvidenceHash } from '../core/workflow/findings/adjudication-evidence.js';
import { computeReviewScopeSnapshotId } from '../core/workflow/findings/snapshot.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

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

function getAuthoritativeLedgerPath(cwd: string): string {
  return join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
}

function baseConfig(cwd: string, rules: ReturnType<typeof makeRule>[]): WorkflowConfig {
  return {
    name: 'adjudication-engine-test',
    maxSteps: 6,
    initialStep: 'reviewers',
    provider: 'claude',
    findingContract: {
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
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

  const seedLedger = (findingLocation: string, workflowName = 'adjudication-engine-test'): void => {
    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      workflowName,
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Disputed issue',
        location: findingLocation,
        reviewers: ['coding-review'],
        rawFindingIds: ['raw-1'],
        firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      rawFindings: [],
      conflicts: [{
        id: 'C-0001',
        status: 'active',
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'Reviewers disagree about F-0001.',
        firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
    }, null, 2), 'utf-8');
  };

  const rules = [
    makeRule('when(findings.conflicts.count > 0 && findings.conflicts.unadjudicated.count > 0)', 'finding-conflict-adjudication'),
    makeRule('approved', 'COMPLETE'),
    makeRule('when(findings.conflicts.count == 0 && findings.open.count == 0)', 'COMPLETE'),
    makeRule('when(findings.conflicts.count > 0)', 'ABORT'),
  ];

  it('finding_stale adjudication resolves the finding, resolves the conflict, and returns to reviewers which then completes', async () => {
    seedLedger('src/a.ts:5');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
    }).run();

    expect(result.status).toBe('completed');

    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string; adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it.each([
    ['undetermined'],
    // finding_valid with an EMPTY actionableFix demonstrates no fixability and
    // must land on the ABORT side exactly like undetermined (codex design).
    ['finding_valid'],
  ] as const)('%s adjudication without an actionable fix keeps the conflict active and routes to ABORT', async (outcome) => {
    seedLedger('src/a.ts:5');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome,
            findingTransition: 'keep_open',
            evidence: ['Cannot state a concrete resolution from the evidence available.'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
    }).run();

    expect(result.status).toBe('aborted');

    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      conflicts: Array<{ id: string; status: string; adjudications?: unknown[] }>;
    };
    expect(ledger.conflicts[0]?.status).toBe('active');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
    // Adjudication for this conflict ran exactly once: only one call carried
    // the adjudication output schema (the "1回制限" gate holding within a
    // single run — a second reviewers pass never happens here because ABORT
    // terminates the workflow immediately).
    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"findingTransition"')
    ));
    expect(adjudicationCalls).toHaveLength(1);
  });

  it('runSingleIteration でも合成ステップが Unknown step にならず実行・遷移できる (codex B4)', async () => {
    seedLedger('src/a.ts:5');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
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

    const ledger = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
  });

  it('workflow_call 継承: 裁定 runner の workflowName は store の正準名（親名）を使い、台帳の workflowName が親名のまま保存される', async () => {
    // 親の台帳（workflowName: parent-workflow）を継承する子エンジンを模す。
    seedLedger('src/a.ts:5', 'parent-workflow');
    const parentLedgerStore = createFindingLedgerStore({
      projectCwd: cwd,
      reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
      workflowName: 'parent-workflow',
      ledgerPath: '.takt/findings/peer-review.json',
      rawFindingsPath: '.takt/findings/raw',
    });

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
      inheritedFindingContract: { contract: inheritedContract!, ledgerStore: parentLedgerStore },
    }).run();

    expect(result.status).toBe('completed');

    // WorkflowEngine は runner へ store の正準名（親名）を渡す。子の
    // config.name（child-of-parent）を渡すと reconcile 文脈が親の台帳の
    // workflowName と食い違う。
    const runnerDeps = vi.mocked(createFindingConflictAdjudicationRunner).mock.calls.at(-1)?.[0];
    expect(runnerDeps?.workflowName).toBe('parent-workflow');

    // 裁定適用と保存を経ても ledger.workflowName は親名のまま
    // （store の assertLedgerWorkflowName 検証を通る）。
    const ledger = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      workflowName: string;
      findings: Array<{ id: string; status: string }>;
      conflicts: Array<{ id: string; status: string }>;
    };
    expect(ledger.workflowName).toBe('parent-workflow');
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
  });

  it('resume 相互作用: 裁定途中で中断しても attempt が台帳に残り、再開後に同一 evidence で再裁定されない', async () => {
    seedLedger('src/a.ts:5');

    // 1走目: 裁定 LLM が中断相当の例外で死ぬ → run は runtime_error abort。
    // ただし attempt は LLM 呼び出しの前に台帳へ記録済み。
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
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
      detectRuleIndex: () => -1,
    }).run();
    expect(firstRun.status).toBe('aborted');

    const ledgerAfterInterrupt = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      conflicts: Array<{ adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledgerAfterInterrupt.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledgerAfterInterrupt.conflicts[0]?.adjudications ?? []).toHaveLength(0);

    // 2走目（resume 相当・同一 evidence）: 裁定 LLM は呼ばれず、
    // unadjudicated.count == 0 のため ABORT 側に落ちる。
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        throw new Error('the adjudicator must not be invoked again for the same evidence');
      }
      return {
        persona,
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-06-13T03:00:01.000Z'),
      };
    });

    // 別 run（異なる runId）として再開: pending attempt は封鎖として働く
    const secondRun = await new WorkflowEngine(baseConfig(cwd, rules), cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir-resume',
      detectRuleIndex: () => -1,
    }).run();
    expect(secondRun.status).toBe('aborted');
    const adjudicatorCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"findingTransition"')
    ));
    expect(adjudicatorCalls).toHaveLength(0);
  });

  it('R1: 複数配線構成の resume（previousStep なし）でも pending attempt の originStep へ正しく戻る', async () => {
    // reviewers と final-gate の両方が adjudication を配線する構成。中断前の
    // run（同一 runId）は final-gate から遷移していた。resume が合成ステップ
    // から直接始まると previousStep が無く、旧実装は「配線元の最初」
    // （reviewers）へ誤遷移していた — attempt に永続化した originStep が
    // final-gate へ正しく戻す。
    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const finding = {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-1'],
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    };
    const rawFinding = {
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      description: 'The bug is present.',
      relation: 'new',
    };
    const conflictBase = {
      id: 'C-0001',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Reviewers disagree about F-0001.',
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    };
    const evidenceHash = computeConflictEvidenceHash(
      conflictBase as never,
      { findings: [finding as never], rawFindings: [rawFinding as never] },
      computeReviewScopeSnapshotId(cwd),
    );
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [finding],
      rawFindings: [rawFinding],
      conflicts: [{
        ...conflictBase,
        // 中断した同一 run（runId = reportDirName）の pending attempt。
        // originStep が耐久記録として final-gate を指す。
        adjudicationAttempts: [{
          evidenceHash,
          reservationToken: 'reservation-final-gate',
          startedAt: { runId: 'test-report-dir', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T01:00:00.000Z' },
          originStep: 'final-gate',
        }],
      }],
    }, null, 2), 'utf-8');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
    }).run();

    expect(result.status).toBe('completed');
    // origin は attempt の originStep（final-gate）— 配線元の最初（reviewers）ではない
    expect(result.stepOutputs.has('final-gate')).toBe(true);
    expect(result.stepOutputs.has('reviewers')).toBe(false);

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    // 同一 run の pending attempt は予約として再利用され、二重記録されない (R2)
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('R1: origin が一切解決できず配線元が複数なら推測せず ABORT する', async () => {
    // R1 テストと同じ複数配線構成だが、pending attempt に originStep が無い
    // （旧データ相当）。previousStep も runner 由来の origin も無く、配線元が
    // 2つで曖昧 — 推測して誤遷移する代わりに ABORT へ落とす。
    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const finding = {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      reviewers: ['coding-review'],
      rawFindingIds: ['raw-1'],
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    };
    const rawFinding = {
      rawFindingId: 'raw-1',
      stepName: 'reviewers',
      reviewer: 'coding-review',
      familyTag: 'bug',
      severity: 'high',
      title: 'Disputed issue',
      location: 'src/a.ts:5',
      description: 'The bug is present.',
      relation: 'new',
    };
    const conflictBase = {
      id: 'C-0001',
      status: 'active',
      findingIds: ['F-0001'],
      rawFindingIds: [],
      description: 'Reviewers disagree about F-0001.',
      firstSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
      lastSeen: { runId: 'run-0', stepName: 'reviewers', timestamp: '2026-06-13T00:00:00.000Z' },
    };
    const evidenceHash = computeConflictEvidenceHash(
      conflictBase as never,
      { findings: [finding as never], rawFindings: [rawFinding as never] },
      computeReviewScopeSnapshotId(cwd),
    );
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [finding],
      rawFindings: [rawFinding],
      conflicts: [{
        ...conflictBase,
        adjudicationAttempts: [{
          evidenceHash,
          reservationToken: 'reservation-without-origin',
          startedAt: { runId: 'test-report-dir', stepName: 'finding-conflict-adjudication', timestamp: '2026-06-13T01:00:00.000Z' },
          // originStep なし
        }],
      }],
    }, null, 2), 'utf-8');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
    }).run();

    // 裁定自体は適用されるが、戻り先が曖昧なため ABORT（誤遷移しない）
    expect(result.status).toBe('aborted');
    expect(result.stepOutputs.has('reviewers')).toBe(false);
    expect(result.stepOutputs.has('final-gate')).toBe(false);
  });

  it('R2(a): rate_limited → 同一 run の fallback 再実行が予約を引き継ぎ、代替 provider で裁定が完走する', async () => {
    seedLedger('src/a.ts:5');

    let adjudicationCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
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
            conflictId: 'C-0001',
            outcome: 'finding_stale',
            findingTransition: 'resolved',
            evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
            actionableFix: '',
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
      detectRuleIndex: () => -1,
      rateLimitFallback: { switchChain: [{ provider: 'codex' }] },
    }).run();

    expect(result.status).toBe('completed');
    expect(adjudicationCallCount).toBe(2);
    // 2回目の裁定呼び出しは fallback の代替 provider（codex）で実行される
    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"findingTransition"')
    ));
    expect(adjudicationCalls[1]![2]?.resolvedProvider).toBe('codex');

    const ledger = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudicationAttempts?: unknown[]; adjudications?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    // 予約は再利用され attempt は1件のまま
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
  });

  it('R2(a) 変形: structured output 非対応 provider（cursor）への fallback でフェンス方式の指示注入と正規化が代替 provider 基準で行われる', async () => {
    seedLedger('src/a.ts:5');

    let adjudicationCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      const isAdjudicationCall = schemaText.includes('"findingTransition"')
        || instruction.includes('conflict C-0001');
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
          conflictId: 'C-0001',
          outcome: 'finding_stale',
          findingTransition: 'resolved',
          evidence: ['Verified fixed against current code.', 'src/a.ts:5'],
          actionableFix: '',
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
      detectRuleIndex: () => -1,
      rateLimitFallback: { switchChain: [{ provider: 'cursor' }] },
    }).run();

    expect(result.status).toBe('completed');
    expect(adjudicationCallCount).toBe(2);

    const adjudicationCalls = vi.mocked(runAgent).mock.calls.filter(([, instruction, options]) => (
      (options?.outputSchema && JSON.stringify(options.outputSchema).includes('"findingTransition"'))
      || instruction.includes('conflict C-0001')
    ));
    // 1回目（claude・ネイティブ対応）: フェンス方式の契約は注入されない
    expect(adjudicationCalls[0]![1]).not.toContain('Return exactly one fenced JSON block');
    // 2回目（cursor・非対応）: JSON Schema 指示（フェンス方式）が代替 provider
    // 基準で注入される
    expect(adjudicationCalls[1]![2]?.resolvedProvider).toBe('cursor');
    expect(adjudicationCalls[1]![1]).toContain('Return exactly one fenced JSON block');
    expect(adjudicationCalls[1]![1]).toContain('"findingTransition"');

    // フェンス JSON の正規化（cursor 基準）を経て裁定が適用されている
    const ledger = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      findings: Array<{ status: string }>;
      conflicts: Array<{ status: string; adjudications?: unknown[]; adjudicationAttempts?: unknown[] }>;
    };
    expect(ledger.findings[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.adjudications).toHaveLength(1);
    expect(ledger.conflicts[0]?.adjudicationAttempts).toHaveLength(1);
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
      detectRuleIndex: () => -1,
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
      detectRuleIndex: () => -1,
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
            { condition: 'still fixable', next: 'fix' },
            { condition: 'needs adjudication', next: 'finding-conflict-adjudication' },
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
      detectRuleIndex: () => -1,
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
      detectRuleIndex: () => -1,
    })).toThrow(/requires finding_contract/);
  });

  it('parallel サブステップの合成名配線は finding_contract + adjudicator があれば検証を通る', () => {
    const config: WorkflowConfig = {
      name: 'parallel-sub-with-contract-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
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
      detectRuleIndex: () => -1,
    })).not.toThrow();
  });

  it('loop monitor judge 経由の配線でも finding_contract + adjudicator があれば合成ステップが注入され検証を通る', () => {
    const config: WorkflowConfig = {
      name: 'adjudication-engine-test',
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
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
            { condition: 'still fixable', next: 'fix' },
            { condition: 'needs adjudication', next: 'finding-conflict-adjudication' },
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
      detectRuleIndex: () => -1,
    })).not.toThrow();
  });

  it('finding_valid + actionableFix: conflict をレビュア側支持で解消し fix へ遷移、修正後の reviewers で COMPLETE まで到達する', async () => {
    seedLedger('src/a.ts:5');

    let reviewerCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (persona === 'findings-manager') {
        // run 1 の manager: 残余 raw なし・active conflict の裁定待ちだけがある。
        // keep（未解決のまま）を返し、裁定は adjudication ステップに委ねる。
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [{ conflictId: 'C-0001', decision: 'keep', evidence: 'Reviewers still disagree.' }],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
          timestamp: new Date('2026-06-13T00:00:02.000Z'),
        };
      }
      const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
      if (schemaText.includes('"findingTransition"')) {
        return {
          persona,
          status: 'done',
          content: '{}',
          structuredOutput: {
            conflictId: 'C-0001',
            outcome: 'finding_valid',
            findingTransition: 'keep_open',
            evidence: ['The reviewer is right: the guard is still missing at src/a.ts:5.'],
            actionableFix: 'Add the missing null guard before the dereference.',
          },
          timestamp: new Date('2026-06-13T02:00:00.000Z'),
        };
      }
      if (schemaText.includes('"rawFindings"')) {
        reviewerCallCount += 1;
        if (reviewerCallCount === 1) {
          // run 1: 新しい raw は無い（conflict の裁定待ちだけの状態を再現）。
          return {
            persona,
            status: 'done',
            content: 'Review report body.',
            structuredOutput: { rawFindings: [] },
            timestamp: new Date('2026-06-13T00:00:01.000Z'),
          };
        }
        // run 2（fix 後）: F-0001 の解消確認。機械分類だけで resolved になる。
        return {
          persona,
          status: 'done',
          content: 'Confirmed the fix.',
          structuredOutput: {
            rawFindings: [{
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
              ...verifiedSourceQuoteFields(cwd, 'src/a.ts', 5),
            }],
          },
          timestamp: new Date('2026-06-13T03:00:01.000Z'),
        };
      }
      // fix ステップ本体
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
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
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

    const result = await new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    }).run();

    expect(result.status).toBe('completed');
    // 裁定後の遷移先が fix（reviewers 再実行ではなく直接 fix ルート）
    expect(result.stepOutputs.has('fix')).toBe(true);

    // codex B1: unadjudicated conflict がある間は fix に直行しない —
    // fix ステップの実行は必ず裁定呼び出しの後。
    const calls = vi.mocked(runAgent).mock.calls;
    const adjudicationCallIndex = calls.findIndex(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"findingTransition"')
    ));
    const fixCallIndex = calls.findIndex(([, instruction]) => instruction.includes('Fix.'));
    expect(adjudicationCallIndex).toBeGreaterThanOrEqual(0);
    expect(fixCallIndex).toBeGreaterThan(adjudicationCallIndex);

    // codex B6: 裁定呼び出しは supervisor facet の personaPath を伴う
    // （facet 本文を system prompt に載せるための経路）。
    const adjudicationOptions = calls[adjudicationCallIndex]![2];
    expect(adjudicationOptions?.personaPath).toBe(supervisorPersonaPath(cwd));

    const ledger = JSON.parse(readFileSync(getAuthoritativeLedgerPath(cwd), 'utf-8')) as {
      findings: Array<{ id: string; status: string; suggestion?: string }>;
      conflicts: Array<{ id: string; status: string; resolvedEvidence?: string; adjudications?: Array<{ actionableFix: string }> }>;
    };
    // conflict はレビュア側支持で解消され、裁定記録に actionableFix が残る
    expect(ledger.conflicts[0]?.status).toBe('resolved');
    expect(ledger.conflicts[0]?.resolvedEvidence).toContain('in favor of the reviewer');
    expect(ledger.conflicts[0]?.adjudications?.[0]?.actionableFix).toContain('null guard');
    // finding は fix 後の解消確認で resolved。suggestion には fix ステップが
    // 読んだ actionableFix の追記が残っている
    const finding = ledger.findings.find((entry) => entry.id === 'F-0001');
    expect(finding?.status).toBe('resolved');
    expect(finding?.suggestion).toContain('[adjudicated fix] Add the missing null guard');
  });

  it('レビュア突き返し: correction で persists に直っても taint は消えず、target へ吸収されずに conflict + provisional に着地する（攻撃4対策）', async () => {
    // conflict なし・open F-0001 だけの台帳。reviewer が同じ問題を relation=new で
    // 再報告してくる（弱いモデルの典型挙動）ケース。
    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Secret is logged',
        location: 'src/secret.ts:12',
        description: 'The code logs a token.',
        reviewers: ['review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      rawFindings: [],
      conflicts: [],
    }, null, 2), 'utf-8');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (instruction.includes('contradictory relation/targetFindingId labeling')) {
        // 突き返し呼び出し: relation を persists に直して全量再出力
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: {
            rawFindings: [{
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
              ...verifiedSourceQuoteFields(cwd, 'src/secret.ts', 40),
            }],
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
        return {
          persona,
          status: 'done',
          content: 'Review report body.',
          structuredOutput: {
            rawFindings: [{
              rawFindingId: 'raw-1',
              familyTag: 'security',
              severity: 'high',
              title: 'Secret is logged',
              location: 'src/secret.ts:40',
              description: 'Token logging is still present, observed at a new line.',
              suggestion: '',
              relation: 'new',
              targetFindingId: '',
            }],
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
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
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
      detectRuleIndex: () => -1,
    }).run();

    // v2 梯子設計: correction で persists に直っても taint は消えない（攻撃4:
    // persists 洗浄の防止）。targetFindingId が書かれているだけでは F-0001 に
    // 吸収されず、manager 提案（open_conflict）に従い conflict + provisional に
    // 着地する。provisional が残るため COMPLETE はエンジン最終不変条件で拒否
    // される（fail-fast abort）。
    expect(result.status).toBe('aborted');
    // 突き返しが1回だけ走った
    const regenerationCalls = vi.mocked(runAgent).mock.calls.filter(([, instruction]) => (
      instruction.includes('contradictory relation/targetFindingId labeling')
    ));
    expect(regenerationCalls).toHaveLength(1);

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ id: string; status: string; rawFindingIds: string[]; provisional?: { kind: string } }>;
      conflicts: Array<{ status: string; findingIds: string[] }>;
    };
    // F-0001 は不変（rawFindingIds へも合流していない = 洗浄されていない）。
    const target = ledger.findings.find((f) => f.id === 'F-0001');
    expect(target?.status).toBe('open');
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    // 観測は provisional として保持され、target との active conflict が立つ。
    const provisional = ledger.findings.find((f) => f.provisional !== undefined);
    expect(provisional?.status).toBe('open');
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');
    expect(ledger.conflicts.some((c) => c.status === 'active' && c.findingIds.includes('F-0001'))).toBe(true);
  });

  it('レビュア突き返し: 突き返し後も relation=new のままなら確定 finding にせず gate-blocking provisional として台帳に残す', async () => {
    const ledgerPath = getAuthoritativeLedgerPath(cwd);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      workflowName: 'adjudication-engine-test',
      nextId: 2,
      updatedAt: '2026-06-13T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Secret is logged',
        location: 'src/secret.ts:12',
        description: 'The code logs a token.',
        reviewers: ['review'],
        rawFindingIds: ['raw-existing'],
        firstSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
        lastSeen: { runId: 'run-0', stepName: 'review', timestamp: '2026-06-13T00:00:00.000Z' },
      }],
      rawFindings: [],
      conflicts: [],
    }, null, 2), 'utf-8');

    const incoherentOutput = {
      rawFindings: [{
        rawFindingId: 'raw-1',
        familyTag: 'security',
        severity: 'high',
        title: 'Secret is logged',
        description: 'Token logging is still present, observed at a new line.',
        suggestion: '',
        relation: 'new',
        targetFindingId: '',
        // typed evidence protocol（codex 対策#4）: この試験の主眼は「訂正しても
        // relation が直らない raw が ladder で provisional に着地する」ことで
        // あって admission ではないため、機械照合済み evidence を与えて
        // admission を通す（無いと ladder に届く前に anomaly へ隔離される）。
        ...verifiedSourceQuoteFields(cwd, 'src/secret.ts', 40),
      }],
    };
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      if (instruction.includes('contradictory relation/targetFindingId labeling')) {
        // 突き返しでも直さない（relation=new のまま返してくる）
        return {
          persona,
          status: 'done',
          content: '',
          structuredOutput: incoherentOutput,
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
          content: 'Review report body.',
          structuredOutput: incoherentOutput,
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
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
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
      detectRuleIndex: () => -1,
    }).run();

    // v2: 直らなかった raw は drop されず provisional として台帳に残り、
    // COMPLETE はエンジン最終不変条件で拒否される。
    expect(result.status).toBe('aborted');

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: Array<{ id: string; rawFindingIds: string[]; provisional?: { kind: string } }>;
    };
    // 確定 finding としては立たず、F-0001 にも合流していない（不採用）。
    // ただし監査 JSON だけに残して台帳から消すこともない — provisional が立つ。
    const target = ledger.findings.find((f) => f.id === 'F-0001');
    expect(target?.rawFindingIds).toEqual(['raw-existing']);
    const provisional = ledger.findings.find((f) => f.provisional !== undefined);
    expect(provisional?.provisional?.kind).toBe('raw-meaning-ambiguous');

    // 検証レポートに provisional 着地の監査記録が残る
    const reportPath = join(cwd, '.takt', 'runs', 'test-report-dir', 'reports', 'findings-manager-validation.review.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      provisionalLandings?: Array<{ kind: string; sourceRawFindingIds: string[] }>;
    };
    expect(report.provisionalLandings?.some((landing) => (
      landing.sourceRawFindingIds.some((id) => id.endsWith(':raw-1'))
    ))).toBe(true);
  });
});
