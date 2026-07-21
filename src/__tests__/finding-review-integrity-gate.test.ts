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
 *   2. bounded 再レビュー → NEEDS_ADJUDICATION: builtin 相当の配線
 *      （anomaly > 0 && !budgetExhausted → 再レビュー / budgetExhausted →
 *      NEEDS_ADJUDICATION）が、有限回だけ再レビューしてから人手裁定へ収束する。
 * を検証する。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  getProvider: vi.fn((provider: string) => ({ supportsStructuredOutput: provider !== 'cursor' })),
}));

vi.mock('../core/workflow/findings/snapshot.js', () => ({
  computeReviewScopeSnapshotId: vi.fn(() => 'test-review-snapshot'),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
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

import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';
import { resolveFindingLedgerRoot } from '../core/workflow/findings/store.js';

function createTestTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-review-integrity-'));
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  return dir;
}

// A hallucinated finding: a fresh claim citing a file that does not exist, with no
// verifiable evidence → the engine isolates it as a reviewer anomaly (never a
// product finding). The reviewer re-emits the same raw every round.
const HALLUCINATED_RAW = {
  rawFindingId: 'h-1',
  familyTag: 'security',
  severity: 'high',
  title: 'Hallucinated issue in a nonexistent file',
  location: 'src/does-not-exist.ts:99',
  description: 'Claims a bug in a file that is not part of the reviewed tree.',
  suggestion: '',
  relation: 'new',
  targetFindingId: '',
};

function mockReviewerEmitsHallucination(): void {
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
    const schemaText = options?.outputSchema ? JSON.stringify(options.outputSchema) : '';
    if (schemaText.includes('"rawFindings"')) {
      return {
        persona,
        status: 'done',
        content: 'Review report body.',
        structuredOutput: { rawFindings: [HALLUCINATED_RAW] },
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
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        reviewerStep([makeRule('when(findings.open.count == 0 && findings.conflicts.count == 0)', 'COMPLETE')]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // product gate は空（幻覚は anomaly に隔離され finding にならない）だが、
    // review-integrity gate が COMPLETE を拒否する。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('reviewer anomaly');

    // 台帳: product finding 0、未昇格 anomaly 1。
    const ledgerPath = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
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
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        reviewerStep([{ condition: 'when(findings.open.count == 0 && findings.conflicts.count == 0)', returnValue: 'done' }]),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // returnValue 終端でも gate を通り、completed にならず abort する。
    expect(result.status).toBe('aborted');
    expect(result.returnValue).toBeUndefined();
    expect(abortReason).toContain('reviewer anomaly');
  });

  it('allows an inherited-contract child to return an anomaly routing signal while the parent remains responsible for final completion', async () => {
    mockReviewerEmitsHallucination();

    const childConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-child',
      subworkflow: {
        callable: true,
        requiresFindingContract: true,
        returns: ['needs_review'],
      },
      maxSteps: 3,
      initialStep: 'reviewers',
      provider: 'claude',
      steps: [
        reviewerStep([{
          condition: 'when(findings.reviewerAnomalies.count > 0)',
          returnValue: 'needs_review',
        }]),
      ],
    };
    const parentConfig: WorkflowConfig = {
      name: 'finding-contract-final-gate-parent',
      maxSteps: 6,
      initialStep: 'final-gate',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        {
          name: 'final-gate',
          kind: 'workflow_call',
          call: childConfig.name,
          personaDisplayName: 'final-gate',
          instruction: '',
          passPreviousResponse: true,
          rules: [{ condition: 'needs_review', next: 'handle-review-signal' }],
        },
        makeStep({
          name: 'handle-review-signal',
          persona: 'handler',
          instruction: 'Handle the child routing signal.',
          rules: [makeRule('when(true)', 'NEEDS_ADJUDICATION')],
        }),
      ],
    };

    const engine = new WorkflowEngine(parentConfig, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
      workflowCallResolver: () => childConfig,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });

    const result = await engine.run();

    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('NEEDS_ADJUDICATION');
    expect(vi.mocked(runAgent).mock.calls.some(([persona]) => persona === 'handler')).toBe(true);
  });

  it('bounded 再レビュー → NEEDS_ADJUDICATION: anomaly が残る限り再レビューへ送り、review_budget を使い切ったら人手裁定へ収束する（有限で止まる）', async () => {
    mockReviewerEmitsHallucination();

    // builtin 相当の配線を最小化: reviewers は常に gate へ、gate が
    // review-integrity を評価する。review_budget=2 で「初回 + 1回の再レビュー」の
    // 2ラウンドで exhausted になる。
    const config: WorkflowConfig = {
      name: 'review-integrity-bounded',
      maxSteps: 12,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
        reviewBudget: { maxReviewRounds: 2 },
      },
      steps: [
        reviewerStep([makeRule('when(findings.conflicts.count == 0)', 'gate')]),
        makeStep({
          name: 'gate',
          persona: 'gatekeeper',
          instruction: 'Gate.',
          rules: [
            makeRule('when(findings.reviewerAnomalies.count > 0 && findings.reviewerAnomalies.budgetExhausted == true && findings.conflicts.count == 0)', 'NEEDS_ADJUDICATION'),
            makeRule('when(findings.reviewerAnomalies.count > 0 && findings.conflicts.count == 0)', 'reviewers'),
            makeRule('when(findings.open.count == 0 && findings.conflicts.count == 0)', 'COMPLETE'),
          ],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason: string) => { abortReason = reason; });
    const result = await engine.run();

    // COMPLETE には決して至らず、有限回の再レビューの後 NEEDS_ADJUDICATION へ。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('NEEDS_ADJUDICATION');
    // 停止理由が review-integrity 予算切れとして分類され、明細に anomaly が出る。
    expect(abortReason).toContain('review-integrity budget was exhausted');
    expect(abortReason).toContain('reviewer anomaly');

    // reviewers（rawFindings を出す呼び出し）が2回走った = 1回の再レビューが
    // 実際に起きた（初回だけで諦めていない）。
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"rawFindings"')
    ));
    expect(reviewerCalls).toHaveLength(2);

    // 台帳: 予算を使い切り、anomaly は監査に残る（消えない）。
    const ledgerPath = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'peer-review.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      findings: unknown[];
      reviewerAnomalies?: Array<{ occurrences: number; promotedFindingId?: string }>;
      reviewIntegrity?: { roundMarkers: string[]; exhausted: boolean };
    };
    expect(ledger.findings).toHaveLength(0);
    expect(ledger.reviewIntegrity?.exhausted).toBe(true);
    expect(ledger.reviewIntegrity?.roundMarkers).toHaveLength(2);
    // 再レビューを跨いでも anomaly は消えず、単一の監査レコードとして残る
    // （観測消去の禁止 — 複数レコードへ増殖もしない）。
    expect(ledger.reviewerAnomalies).toHaveLength(1);
    expect(ledger.reviewerAnomalies?.[0]?.promotedFindingId).toBeUndefined();
    expect(ledger.reviewerAnomalies?.[0]?.occurrences).toBeGreaterThanOrEqual(1);
  });

  it('final-gate supervisor は2つのFinding Contract報告を出しても、ステップごとに1回だけ取り込み、raw findingを重複保存しない', async () => {
    mockReviewerEmitsHallucination();
    const config: WorkflowConfig = {
      name: 'supervisor-two-reports',
      maxSteps: 4,
      initialStep: 'supervise',
      provider: 'claude',
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: { persona: 'findings-manager', instruction: 'findings-manager', outputContract: 'findings-manager' },
      },
      steps: [
        makeStep({
          name: 'supervise',
          persona: 'supervisor',
          instruction: 'Supervise the final gate.',
          outputContracts: [
            { name: 'supervisor-validation.md', format: 'validation', formatRef: 'supervisor-validation-finding-contract' },
            { name: 'supervisor-gate-summary.md', format: 'summary', formatRef: 'supervisor-gate-summary-finding-contract' },
          ],
          rules: [makeRule('approved', 'COMPLETE')],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => 0,
    });
    await engine.run();

    expect(ingestFindingContractResultsMock).toHaveBeenCalledOnce();
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema && JSON.stringify(options.outputSchema).includes('"rawFindings"')
    ));
    expect(reviewerCalls).toHaveLength(1);

    const rawFindingsDir = join(resolveFindingLedgerRoot(cwd), '.takt', 'findings', 'raw');
    const rawFindingFiles = readdirSync(rawFindingsDir);
    expect(rawFindingFiles).toHaveLength(1);
    const rawFindings = JSON.parse(readFileSync(join(rawFindingsDir, rawFindingFiles[0]), 'utf-8')) as Array<{ rawFindingId: string }>;
    expect(rawFindings).toHaveLength(1);
    expect(new Set(rawFindings.map((finding) => finding.rawFindingId)).size).toBe(rawFindings.length);
  });
});
