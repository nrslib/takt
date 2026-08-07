/**
 * Engine-level: 非承認判定 + 構造化 claim ゼロ件が review_budget を消費し、
 * 上限到達で need_replan 分岐へ実際に到達することを確かめる。
 *
 * verdict anomaly の追記は findings-manager のコミット後に走る。manager 側の
 * attachReviewIntegrityState はその時点で今ラウンドの anomaly をまだ見ておらず
 * （前ラウンド分は withdrawal 済み・今ラウンド分は未記録で未決着 0 件）、
 * マーカーを付けない。追記側で同じラウンドキーの marker を進めないと
 * budgetExhausted に永久に到達せず、review_budget ではなく max_steps まで
 * 再レビューを焼く。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn((provider: string) => ({
    supportsStructuredOutput: provider !== 'cursor',
    // 正規化係は隔離 structured 実行で走る。実 provider（claude）と同じ能力にする。
    supportsIsolatedStructuredExecution: provider !== 'cursor',
    keepsAllowedToolWithoutEdit: () => false,
  })),
}));

// 正規化係は provider.setupIsolatedStructured 経由で走り runAgent を通らない。
// FC レビュアーの raw findings はここだけが作る。
vi.mock('../agents/finding-intake-normalizer-usecase.js', () => ({
  normalizeFindingIntake: vi.fn(),
}));

vi.mock('../core/workflow/findings/snapshot.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/findings/snapshot.js')>(),
  computeReviewScopeSnapshotId: vi.fn(() => '1'.repeat(64)),
}));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/workflow/phase-runner.js')>(),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  // レビュアーの判定ラダーは [approved, needs_fix]。毎ラウンド非承認を選ぶ。
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: 'needs_fix', method: 'judge' }),
}));

import { WorkflowEngine } from './helpers/workflow-engine.js';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { normalizeFindingIntake } from '../agents/finding-intake-normalizer-usecase.js';
import { makeRule, makeStep } from './test-helpers.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { listFindingReviewPublications } from '../core/workflow/findings/review-publication.js';

const MAX_REVIEW_ROUNDS = 2;

function createTestTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-verdict-claims-budget-'));
  for (const rel of [
    ['reports'],
    ['context', 'knowledge'],
    ['context', 'policy'],
    ['context', 'previous_responses'],
    ['logs'],
  ]) {
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', ...rel), { recursive: true });
  }
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), '// line 1\n');
  initializeGitFixture(dir, ['src/a.ts']);
  return dir;
}

const REJECT_REPORT = '# Review\n## Result: REJECT\nThe feature is not wired.';

/** REJECT 相当の散文だけを返し、構造化 claim は1件も出さないレビュアー。 */
function mockReviewerRejectsWithoutClaims(): void {
  // レビュアーは markdown レポートしか書かない。claim ゼロ件は正規化係の
  // 抽出結果が空配列になることとして現れる。
  vi.mocked(normalizeFindingIntake).mockImplementation(async () => ({
    persona: 'finding-intake-normalizer',
    status: 'done',
    content: '',
    structuredOutput: { rawFindings: [] },
    timestamp: new Date('2026-08-01T00:00:01.500Z'),
  }));
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
    if (persona === 'architecture-reviewer' || persona === 'reviewer') {
      return {
        persona,
        status: 'done',
        content: REJECT_REPORT,
        timestamp: new Date('2026-08-01T00:00:01.000Z'),
      };
    }
    return {
      persona,
      status: 'done',
      content: 'approved',
      timestamp: new Date('2026-08-01T00:00:02.000Z'),
    };
  });
}

function reviewersStep(): WorkflowStep {
  return makeStep({
    name: 'reviewers',
    parallel: [{
      name: 'arch-review',
      persona: 'architecture-reviewer',
      instruction: 'Review.',
      edit: false,
      outputContracts: [{
        name: 'architect-review.md',
        format: 'resolved facet body',
        formatRef: 'architecture-review-finding-contract',
      }],
      // 純粋な二値判定ラダー。先頭が承認枝、2件目が非承認枝。
      rules: [makeRule('approved'), makeRule('needs_fix')],
    }] as unknown as WorkflowStep[],
    rules: [
      makeRule(
        'when(findings.open.count == 0 && findings.reviewerAnomalies.count > 0 && findings.reviewerAnomalies.budgetExhausted == true)',
        'replan',
      ),
      makeRule('when(findings.open.count == 0 && findings.reviewerAnomalies.count > 0)', 'reviewers'),
      makeRule('when(findings.open.count == 0)', 'COMPLETE'),
    ],
  });
}

describe('verdict/claims mismatch consumes the review-integrity budget', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTestTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('REJECT+claim ゼロ件の反復が max_review_rounds で budgetExhausted になり need_replan へ抜ける', async () => {
    mockReviewerRejectsWithoutClaims();

    const config: WorkflowConfig = {
      name: 'verdict-claims-budget',
      // 予算(2)より十分大きくして、抜けたのが max_steps ではなく予算であることを示す。
      maxSteps: 20,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: { persona: 'supervisor' },
        reviewBudget: { maxReviewRounds: MAX_REVIEW_ROUNDS },
      },
      steps: [
        reviewersStep(),
        makeStep({
          name: 'replan',
          tags: ['plan'],
          persona: 'planner',
          instruction: 'Redefine the approach without changing requirements.',
          rules: [makeRule('when(true)', 'ABORT')],
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

    // need_replan 分岐（replan step）に実際に到達している。
    expect(result.status).toBe('aborted');
    expect(abortReason).toContain('Workflow aborted by step transition');
    const personas = vi.mocked(runAgent).mock.calls.map(([persona]) => persona);
    expect(personas).toContain('planner');

    const ledger = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'test-report-dir',
      reportDir: join(cwd, '.takt', 'runs', 'test-report-dir', 'reports'),
      workflowName: config.name,
    }).loadLedger();

    // 予算は verdict anomaly 経由で実際に消費されている。
    expect(ledger.reviewIntegrity?.roundMarkers.length).toBe(MAX_REVIEW_ROUNDS);
    expect(ledger.reviewIntegrity?.exhausted).toBe(true);
    expect((ledger.reviewerAnomalies ?? []).map((anomaly) => anomaly.kind))
      .toContain('verdict-claims-mismatch');
    // 予算ぶんのレビューだけで抜けている（max_steps まで焼いていない）。
    // 正規化係はレビュアー1人につきラウンド1回なので、そのままラウンド数になる。
    expect(vi.mocked(normalizeFindingIntake).mock.calls.length).toBe(MAX_REVIEW_ROUNDS);
  });

  /**
   * 保存済み publication からの再開（クラッシュ後の resume）は、レビュアーを
   * 呼び直さずに判定だけを確定させる副経路。ここを配線し忘れると、resume した
   * ラウンドだけ非承認判定が台帳に何も残さず消える。
   *
   * 1回目は routing 付きラダー（＝形ガードでゲート対象外）で publication だけを
   * 残し、2回目に同じ publication を routing-free ラダーで resume する。
   * 台帳は引き継ぐので、2回目に現れた anomaly は resume 経路が作ったものだけ。
   */
  it('resume 経路（保存済み publication）でも非承認判定 + claim ゼロ件を台帳へ残す', async () => {
    mockReviewerRejectsWithoutClaims();

    const reviewerConfig = (rules: WorkflowConfig['steps'][number]['rules']): WorkflowConfig => ({
      name: 'verdict-claims-resume',
      maxSteps: 2,
      initialStep: 'reviewers',
      provider: 'claude',
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: { persona: 'supervisor' },
        reviewBudget: { maxReviewRounds: 1 },
      },
      steps: [
        // 単独 FC レビュアー step（parallel ではない resume 分岐を通す）。
        makeStep({
          name: 'reviewers',
          persona: 'architecture-reviewer',
          instruction: 'Review.',
          edit: false,
          outputContracts: [{
            name: 'architect-review.md',
            format: 'resolved facet body',
            formatRef: 'architecture-review-finding-contract',
          }],
          rules,
        }),
      ],
    });
    const runEngine = async (config: WorkflowConfig): Promise<void> => {
      const engine = new WorkflowEngine(config, cwd, 'task', {
        projectCwd: cwd,
        provider: 'claude',
        reportDirName: 'test-report-dir',
      });
      await engine.run();
    };
    const reportDir = join(cwd, '.takt', 'runs', 'test-report-dir', 'reports');
    const anomalyKinds = (): string[] => createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'test-report-dir',
      reportDir,
      workflowName: 'verdict-claims-resume',
    }).loadLedger().reviewerAnomalies?.map((anomaly) => anomaly.kind) ?? [];

    // 1回目: routing 付きラダーなのでゲートは働かない。publication だけが残る。
    await runEngine(reviewerConfig([
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'COMPLETE'),
    ]));
    expect(listFindingReviewPublications(reportDir).length).toBeGreaterThan(0);
    expect(anomalyKinds()).not.toContain('verdict-claims-mismatch');
    vi.mocked(runAgent).mockClear();

    // 2回目: 同じ publication を routing-free ラダーで resume する。
    await runEngine(reviewerConfig([makeRule('approved'), makeRule('needs_fix')]));

    // レビュアーは呼び直されていない（＝ resume 分岐を通った）。
    const reviewerCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => (
      options?.outputSchema !== undefined
      && JSON.stringify(options.outputSchema).includes('"reportContent"')
    ));
    expect(reviewerCalls).toHaveLength(0);
    // resume でも判定は確定するので、anomaly はここで台帳へ残らなければならない。
    expect(anomalyKinds()).toContain('verdict-claims-mismatch');
  });
});
