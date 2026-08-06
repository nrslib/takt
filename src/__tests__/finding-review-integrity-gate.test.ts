/**
 * Engine-level coverage for the review-integrity gate (codex 対策#4 の二系統台帳 +
 * codex 検証ブロッカー#1). 二系統台帳では、機械照合を通らない reviewer の主張は
 * product finding ではなく reviewer anomaly（review-integrity 側）へ隔離される。
 * だが「レビュー全体が anomaly に隔離された run」は product gate（open/provisional）
 * が空になり、そのままだと即 COMPLETE で実質レビューされずに通ってしまう。
 *
 * ここでは engine レベルで:
 *   1. fail-closed: 未昇格 anomaly が残るのに COMPLETE を指す custom workflow は、
 *      エンジンの completion gate が COMPLETE を拒否して abort する（配線漏れでも
 *      安全側）。
 *   2. bounded 再レビュー → replan: anomaly 予算を使い切ったら要件を維持した
 *      再計画へ進み、再計画後も解消不能な反復だけ loop monitor が停止する。
 * を検証する。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ingestFindingContractResultsMock } = vi.hoisted(() => ({
  ingestFindingContractResultsMock: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn((provider: string) => ({
    supportsStructuredOutput: provider !== 'cursor',
    keepsAllowedToolWithoutEdit: () => false,
  })),
}));

vi.mock('../core/workflow/findings/snapshot.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/findings/snapshot.js')>(),
  computeReviewScopeSnapshotId: vi.fn(() => '1'.repeat(64)),
}));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/phase-runner.js')>(),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: async (...args: Parameters<typeof actual.ingestFindingContractResults>) => {
      ingestFindingContractResultsMock();
      return actual.ingestFindingContractResults(...args);
    },
  };
});

import { WorkflowEngine } from './helpers/workflow-engine.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { reviewerRawExtractionFixture } from './helpers/finding-lifecycle-fixture.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

function createTestTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-review-integrity-'));
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  initializeGitFixture(dir, ['src/a.ts']);
  return dir;
}

// A hallucinated finding with a deterministically invalid locator. The reviewer
// re-emits the same raw every round.
const HALLUCINATED_RAW = reviewerRawExtractionFixture({
  rawFindingId: 'h-1',
  familyTag: 'security',
  severity: 'high',
  title: 'Hallucinated issue at an invalid source line',
  description: 'Claims a bug at a line outside the reviewed source file.',
  suggestion: null,
  relation: 'new',
  targetFindingId: null,
  evidence: [{
    kind: 'file_quote',
    path: 'src/a.ts',
    startLine: 99,
    endLine: 99,
    verbatimExcerpt: 'hallucinated source line',
    snapshotId: '1'.repeat(64),
  }],
  rawExcerpt: 'Review report body.',
});

function mockReviewerEmitsHallucination(): void {
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
    const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
    if (schemaText.includes('"rawFindings"')) {
      const isPublication = schemaText.includes('"reportContent"');
      return {
        persona,
        status: 'done',
        content: isPublication ? '' : 'Review report body.',
        structuredOutput: isPublication
          ? { reportContent: 'Review report body.', rawFindings: [HALLUCINATED_RAW] }
          : { rawFindings: [HALLUCINATED_RAW] },
        timestamp: new Date('2026-06-13T00:00:01.000Z'),
      };
    }
    // findings-manager is deterministic for an all-anomaly batch (no LLM decision
    // call), but mock it defensively; any other agent call just approves.
    return {
      persona,
      status: 'done',
      content: 'approved',
      timestamp: new Date('2026-06-13T00:00:02.000Z'),
    };
  });
}

function reviewerStep(rules: ReturnType<typeof makeRule>[]): ReturnType<typeof makeStep> {
  return makeStep({
    name: 'reviewers',
    persona: 'reviewer',
    instruction: 'Review.',
    outputContracts: [
      { name: 'review.md', format: 'resolved facet body', formatRef: 'review-finding-contract' },
    ],
    rules,
  });
}

function loadRootLedger(cwd: string, workflowName: string) {
  return createTestFindingLedgerStore({
    projectCwd: cwd,
    runId: 'test-report-dir',
    reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
    workflowName,
  }).loadLedger();
}

describe('review-integrity gate (engine level, codex 検証ブロッカー#1)', () => {
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

  it('fail-closed: 未昇格 anomaly が残るのに COMPLETE を指す custom workflow はエンジンの completion gate が拒否して abort する（配線漏れでも product gate 空で通さない）', async () => {
    mockReviewerEmitsHallucination();

    // 配線漏れのある custom workflow: anomaly の存在を無視し、product gate
    // （open == 0）だけを見て COMPLETE を指す。
    const config: WorkflowConfig = {
      name: 'review-integrity-failclosed',
      maxSteps: 4,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        adjudicator: { persona: 'supervisor' },
      },
      steps: [
        reviewerStep([makeRule('when(findings.open.count == 0 && findings.conflicts.count == 0)', 'COMPLETE')]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // product gate は空（幻覚は anomaly に隔離され finding にならない）だが、
    // review-integrity gate が COMPLETE を拒否する。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('reviewer anomaly');

    // 台帳: product finding 0、未昇格 anomaly 1。
    const ledger = loadRootLedger(cwd, config.name) as {
      findings: unknown[];
      reviewerAnomalies?: Array<{ kind: string; promotedFindingId?: string }>;
    };
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewerAnomalies?.filter((a) => a.promotedFindingId === undefined)).toHaveLength(1);
    expect(ledger.reviewerAnomalies?.[0]?.kind).toBe('quote-mismatch');
  });

  it('fail-closed: returnValue 終端（return: ...）で完了しようとしても、未昇格 anomaly が残る限り completion gate が拒否して abort する（codex 検証2巡目#1: gate を迂回する完了経路を塞ぐ）', async () => {
    mockReviewerEmitsHallucination();

    // reviewers の rule が next ではなく return（returnValue 終端）で完了しようと
    // する。かつては returnValue 終端が checkCompletionGate を呼ばず直接 completed に
    // していたため、この配線で anomaly を残したまま「成功終了」できた。
    const config: WorkflowConfig = {
      name: 'review-integrity-returnvalue',
      maxSteps: 4,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        adjudicator: { persona: 'supervisor' },
      },
      steps: [
        reviewerStep([makeRule(
          'when(findings.open.count == 0 && findings.conflicts.count == 0)',
          '',
          { returnValue: 'done' },
        )]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // returnValue 終端でも gate を通り、completed にならず abort する。
    expect(result.status).toBe('aborted');
    expect(result.returnValue).toBeUndefined();
    expect(abortReason).toContain('reviewer anomaly');
  });

  it('merge-readiness child の need_replan は親の replan → implement → reviewers へ進み write_tests を通らない', async () => {
    mockReviewerEmitsHallucination();

    const childConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-child',
      subworkflow: {
        callable: true,
        requiresFindingContract: true,
        returns: ['need_replan'],
      },
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      steps: [
        reviewerStep([makeRule(
          'when(findings.reviewerAnomalies.count > 0)',
          '',
          { returnValue: 'need_replan' },
        )]),
      ],
    };
    const parentConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-parent',
      maxSteps: 6,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        adjudicator: { persona: 'supervisor' },
      },
      steps: [
        {
          name: 'final-gate',
          kind: 'workflow_call',
          call: childConfig.name,
          personaDisplayName: 'final-gate',
          instruction: '',
          passPreviousResponse: true,
          rules: [makeRule('need_replan', 'replan')],
        },
        makeStep({
          name: 'replan',
          tags: ['plan'],
          persona: 'planner',
          instruction: 'Redefine the implementation approach without changing requirements.',
          rules: [makeRule('when(true)', 'implement')],
        }),
        makeStep({
          name: 'implement',
          persona: 'coder',
          instruction: 'Implement the revised approach.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
        makeStep({
          name: 'reviewers',
          persona: 'reviewer-after-replan',
          instruction: 'Review the revised implementation.',
          rules: [makeRule('when(true)', 'ABORT')],
        }),
      ],
    };

    const engine = new WorkflowEngine(parentConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      workflowCallResolver: () => childConfig,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });

    const result = await engine.run();

    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('Workflow aborted by step transition');
    const personas = vi.mocked(runAgent).mock.calls.map(([persona]) => persona);
    expect(personas).toEqual(expect.arrayContaining(['planner', 'coder', 'reviewer-after-replan']));
    expect(personas).not.toContain('test-writer');
  });

  it('review_budget 枯渇後は replan → implement → reviewers へ進み、write_tests を再実行せず loop monitor で有限停止する', async () => {
    mockReviewerEmitsHallucination();

    // builtin 相当の配線を最小化: gate は review_budget 枯渇までは再レビューし、
    // 枯渇後は replan へ戻す。sticky な枯渇状態による反復は loop monitor が止める。
    const config: WorkflowConfig = {
      name: 'review-integrity-bounded',
      maxSteps: 20,
      initialStep: 'reviewers',
      provider: 'claude',
      loopMonitors: [{
        cycle: ['replan', 'implement', 'reviewers', 'gate'],
        threshold: 2,
        judge: {
          persona: 'supervisor',
          instruction: 'Abort only when no feasible requirements-compliant approach remains.',
          rules: [
            makeRule('when(true)', 'ABORT'),
          ],
        },
      }],
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        adjudicator: { persona: 'supervisor' },
        reviewBudget: { maxReviewRounds: 2 },
      },
      steps: [
        reviewerStep([makeRule('when(findings.conflicts.count == 0)', 'gate')]),
        makeStep({
          name: 'gate',
          persona: 'gatekeeper',
          instruction: 'Gate.',
          rules: [
            makeRule('when(findings.reviewerAnomalies.count > 0 && findings.reviewerAnomalies.budgetExhausted == true && findings.conflicts.count == 0)', 'replan'),
            makeRule('when(findings.reviewerAnomalies.count > 0 && findings.conflicts.count == 0)', 'reviewers'),
            makeRule('when(findings.open.count == 0 && findings.conflicts.count == 0)', 'COMPLETE'),
          ],
        }),
        makeStep({
          name: 'replan',
          tags: ['plan'],
          persona: 'planner',
          instruction: 'Redefine the implementation approach without changing requirements.',
          rules: [makeRule('when(true)', 'implement')],
        }),
        makeStep({
          name: 'implement',
          persona: 'coder',
          instruction: 'Implement the revised approach.',
          rules: [makeRule('when(true)', 'reviewers')],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // COMPLETE には至らず、再計画を試した後に loop monitor が有限停止する。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('Workflow aborted by step transition');

    const stepNames = vi.mocked(runAgent).mock.calls.map(([persona]) => persona);
    expect(stepNames).toContain('planner');
    expect(stepNames).toContain('coder');
    expect(stepNames).not.toContain('test-writer');

    // 初回だけで諦めず再レビューし、その後も再計画した実装をレビューしている。
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"rawFindings"')
    ));
    expect(reviewerCalls.length).toBeGreaterThan(2);

    // 台帳: 予算を使い切り、anomaly は監査に残る（消えない）。
    const ledger = loadRootLedger(cwd, config.name) as {
      findings: unknown[];
      reviewerAnomalies?: Array<{
        occurrences: number;
        reviewers: string[];
        promotedFindingId?: string;
        settlement?: {
          kind: string;
          supersedingPublications?: Array<{ reviewer: string; publicationId: string }>;
        };
      }>;
      reviewIntegrity?: { roundMarkers: string[]; exhausted: boolean };
    };
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewIntegrity?.exhausted).toBe(true);
    expect(ledger.reviewIntegrity?.roundMarkers.length).toBeGreaterThanOrEqual(2);
    // 再レビューを跨いでも観測は消えない（観測消去の禁止）。ただし各 episode は
    // 「そのレビュアーの次の完全なレビューが登録された」時点で取り下げとして決着し、
    // 同じ主張の再観測は新しい episode として記録される — 未決着はつねに 1 件。
    const anomalies = ledger.reviewerAnomalies ?? [];
    expect(anomalies.length).toBeGreaterThanOrEqual(2);
    expect(anomalies.every((anomaly) => anomaly.promotedFindingId === undefined)).toBe(true);
    expect(anomalies.every((anomaly) => anomaly.occurrences >= 1)).toBe(true);
    const outstanding = anomalies.filter((anomaly) => anomaly.settlement === undefined);
    expect(outstanding).toHaveLength(1);
    for (const settled of anomalies.filter((anomaly) => anomaly.settlement !== undefined)) {
      expect(settled.settlement?.kind).toBe('withdrawn_by_subsequent_review');
      // 決着根拠は観測者全員分（この構成では単一レビュアー "reviewers"）。
      expect(settled.settlement?.supersedingPublications?.map(({ reviewer }) => reviewer))
        .toEqual([...settled.reviewers].sort());
    }
  }, 30_000);

  it('final-gate supervisor の単一Finding Contract報告を1回だけ取り込み、raw findingを重複保存しない', async () => {
    mockReviewerEmitsHallucination();
    const config: WorkflowConfig = {
      name: 'supervisor-single-report',
      maxSteps: 4,
      initialStep: 'supervise',
      provider: 'claude',
      findingContract: {
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        adjudicator: { persona: 'supervisor' },
      },
      steps: [
        makeStep({
          name: 'supervise',
          persona: 'supervisor',
          instruction: 'Supervise the final gate.',
          outputContracts: [
            { name: 'supervisor-validation.md', format: 'validation', formatRef: 'supervisor-validation-finding-contract' },
          ],
          rules: [makeRule('approved', 'COMPLETE')],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
    });
    await engine.run();

    expect(ingestFindingContractResultsMock).toHaveBeenCalledOnce();
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"rawFindings"')
    ));
    expect(reviewerCalls).toHaveLength(2);
    const publicationCalls = reviewerCalls.filter(([, , options]) => (
      JSON.stringify(options?.outputSchema).includes('"reportContent"')
    ));
    expect(publicationCalls).toHaveLength(1);

    const rawFindings = loadRootLedger(cwd, config.name).rawFindings;
    expect(rawFindings).toHaveLength(1);
    expect(new Set(rawFindings.map((finding) => finding.rawFindingId)).size).toBe(rawFindings.length);
  });
});
