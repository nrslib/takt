/**
 * 非承認判定 + 構造化 claim ゼロ件の整合ゲート（verdict-claims-integrity.ts）。
 *
 * 実走行で観測した欠陥: REJECT レポートが rawFindings を空で出したため FC 台帳に
 * 何も残らず、決定的ルールラダーが COMPLETE を選び REJECT が黙殺された。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { resolveWorkflowStepFragments } from '../infra/config/loaders/workflowStepFragmentResolver.js';
import type { AgentResponse, FindingContractConfig, WorkflowStep } from '../core/models/types.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import {
  collectReviewSupersededReviewerAnomalyIds,
  isOutstandingReviewerAnomaly,
  withdrawReviewerAnomaliesSupersededByReview,
} from '../core/workflow/findings/reviewer-anomalies.js';
import type { CanonicalFindingReviewPublication } from '../core/workflow/findings/review-publication.js';
import { PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL } from '../core/workflow/findings/review-publication.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import {
  recordVerdictClaimsMismatchAnomalies,
  resolveReviewerVerdict,
  VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND,
} from '../core/workflow/findings/verdict-claims-integrity.js';

const REVIEWER = 'arch-review';
const REPORT = '# アーキテクチャレビュー\n## 結果: REJECT\n機能が未配線である。';

function makeLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: REVIEWER,
    persona: 'architecture-reviewer',
    instruction: 'review-arch',
    rules: [
      { condition: { kind: 'semantic', label: 'approved' } },
      { condition: { kind: 'semantic', label: 'needs_fix' } },
    ],
    ...overrides,
  } as WorkflowStep;
}

function makeResponse(matchedRuleIndex: number | undefined): AgentResponse {
  return {
    persona: REVIEWER,
    status: 'done',
    content: REPORT,
    timestamp: new Date('2026-08-01T00:00:00.000Z'),
    ...(matchedRuleIndex === undefined ? {} : { matchedRuleIndex }),
  };
}

const FINDING_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
  adjudicator: { persona: 'supervisor' },
  reviewBudget: { maxReviewRounds: 2 },
};

function makePublication(
  rawFindings: readonly unknown[],
  publicationId = 'a'.repeat(64),
): CanonicalFindingReviewPublication {
  return {
    scopeIdentity: 'finding-storage:db:authority',
    callNamespace: '',
    parentStepName: 'reviewers',
    stepIteration: 1,
    reviewerStepName: REVIEWER,
    reportName: 'architect-review.md',
    publicationId,
    protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    reportContent: REPORT,
    reportDigest: 'b'.repeat(64),
    rawFindings,
    presentationContext: {
      revision: 1,
      restatementRequests: [],
      presentedReviewerAnomalyIds: [],
    },
  };
}

function makeStore(initial: FindingLedger): {
  store: FindingLedgerStore;
  current: () => FindingLedger;
} {
  let ledger = initial;
  const store = {
    runId: 'run-1',
    ledgerIdentity: 'finding-storage:db:authority',
    workflowName: 'peer-review',
    interpretationLiveClaims: (() => {
      throw new Error('unused');
    }) as unknown as FindingLedgerStore['interpretationLiveClaims'],
    loadLedger: () => ledger,
    updateLedger: async <Result>(
      mutator: (current: FindingLedger) => { ledger: FindingLedger; result: Result },
    ) => {
      const mutation = mutator(ledger);
      ledger = mutation.ledger;
      return mutation;
    },
  } as unknown as FindingLedgerStore;
  return { store, current: () => ledger };
}

async function record(input: {
  step?: WorkflowStep;
  matchedRuleIndex: number | undefined;
  rawFindings: readonly unknown[];
  initial?: FindingLedger;
  publicationId?: string;
  roundMarker?: string;
}): Promise<{ ledger: FindingLedger; refreshed: number }> {
  const { store, current } = makeStore(input.initial ?? makeLedger());
  let refreshed = 0;
  await recordVerdictClaimsMismatchAnomalies({
    ledgerStore: store,
    findingContract: FINDING_CONTRACT,
    observations: [{
      step: input.step ?? makeStep(),
      response: makeResponse(input.matchedRuleIndex),
      publication: makePublication(input.rawFindings, input.publicationId),
    }],
    interactive: false,
    runId: 'run-1',
    parentStepName: 'reviewers',
    roundMarker: input.roundMarker ?? 'run-1\u0000\u0000reviewers\u00001\u0000' + (input.publicationId ?? 'a'.repeat(64)),
    timestamp: '2026-08-01T00:00:00.000Z',
    refreshFindingsState: () => {
      refreshed += 1;
    },
  });
  return { ledger: current(), refreshed };
}

describe('resolveReviewerVerdict', () => {
  it('先頭 semantic 候補が選ばれたときだけ承認判定になる', () => {
    expect(resolveReviewerVerdict(makeStep(), makeResponse(0), false))
      .toEqual({ label: 'approved', approving: true });
    expect(resolveReviewerVerdict(makeStep(), makeResponse(1), false))
      .toEqual({ label: 'needs_fix', approving: false });
  });

  it('判定ラダーを持たない step と rule 未一致の応答では判定が存在しない', () => {
    const singleRuleStep = makeStep({
      rules: [{ condition: { kind: 'semantic', label: 'approved' } }],
    } as Partial<WorkflowStep>);
    expect(resolveReviewerVerdict(singleRuleStep, makeResponse(0), false)).toBeUndefined();
    expect(resolveReviewerVerdict(makeStep(), makeResponse(undefined), false)).toBeUndefined();
  });

  // merge-readiness の最終ゲートは `needs_fix` を `approved` より前に宣言する。
  // 宣言順で読むと承認と非承認が逆転するので、この形は判定対象から外す。
  it('routing と when() を混ぜたゲートラダーは承認枝を同定できないので対象外', () => {
    const gateStep = makeStep({
      rules: [
        {
          condition: { kind: 'when', expression: 'findings.open.count > 0' },
          returnValue: 'needs_fix',
        },
        { condition: { kind: 'semantic', label: 'needs_fix' }, returnValue: 'needs_fix' },
        {
          condition: {
            kind: 'and',
            left: { kind: 'semantic', label: 'approved' },
            right: { kind: 'when', expression: 'findings.open.count == 0' },
          },
          next: 'supervise',
        },
      ],
    } as Partial<WorkflowStep>);

    expect(resolveReviewerVerdict(gateStep, makeResponse(1), false)).toBeUndefined();
    expect(resolveReviewerVerdict(gateStep, makeResponse(2), false)).toBeUndefined();
  });

  it('ラベルが自由記述でも純粋な二値ラダーなら宣言順で読める', () => {
    const aiStep = makeStep({
      rules: [
        { condition: { kind: 'semantic', label: 'No AI-specific issues' } },
        { condition: { kind: 'semantic', label: 'AI-specific issues found' } },
      ],
    } as Partial<WorkflowStep>);

    expect(resolveReviewerVerdict(aiStep, makeResponse(0), false)?.approving).toBe(true);
    expect(resolveReviewerVerdict(aiStep, makeResponse(1), false)?.approving).toBe(false);
  });
});

describe('recordVerdictClaimsMismatchAnomalies', () => {
  it('非承認判定 + rawFindings ゼロ件を claim-bearing な anomaly として台帳へ残す', async () => {
    const { ledger, refreshed } = await record({ matchedRuleIndex: 1, rawFindings: [] });

    expect(ledger.reviewerAnomalies).toHaveLength(1);
    const anomaly = ledger.reviewerAnomalies![0]!;
    expect(anomaly.kind).toBe(VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND);
    expect(anomaly.reviewers).toEqual([REVIEWER]);
    expect(anomaly.sourceRawFindingIds).toEqual([]);
    expect(anomaly.sourceIntakeIds).toEqual(['a'.repeat(64)]);
    expect(anomaly.intakeContract).toBeUndefined();
    // 言い直し要求が「非承認判定の根拠を構造化 claim として出せ」と伝わる形で
    // 判定と報告本文を保持する。
    expect(anomaly.claimedExcerpt).toContain('verdict: needs_fix');
    expect(anomaly.claimedExcerpt).toContain('## 結果: REJECT');
    expect(anomaly.mismatchReason).toContain('zero structured raw findings');
    expect(isOutstandingReviewerAnomaly(anomaly)).toBe(true);
    expect(refreshed).toBe(1);
  });

  it('承認判定 + rawFindings ゼロ件は正常なので台帳へ触れない', async () => {
    const { ledger, refreshed } = await record({ matchedRuleIndex: 0, rawFindings: [] });

    expect(ledger.reviewerAnomalies).toBeUndefined();
    expect(refreshed).toBe(0);
  });

  it('非承認判定でも claim を提出していれば台帳へ触れない', async () => {
    const { ledger, refreshed } = await record({
      matchedRuleIndex: 1,
      rawFindings: [{ title: 'wiring is missing' }],
    });

    expect(ledger.reviewerAnomalies).toBeUndefined();
    expect(refreshed).toBe(0);
  });

  it('未決着の間はワークフローの anomaly rule が COMPLETE より先に成立する', async () => {
    const { ledger } = await record({ matchedRuleIndex: 1, rawFindings: [] });
    const context = buildFindingsRuleContext(ledger, '/cwd', new Map());

    // takt-default-fc の決定的ラダーは
    // `open.count == 0 && reviewerAnomalies.count > 0` を COMPLETE より先に見る。
    expect(context.open.count).toBe(0);
    expect(context.reviewerAnomalies.count).toBe(1);
    // intake-contract 固有の提示予算経路（restatement / escalation / terminal）には
    // 乗らない。raw finding が1件も無いため restatement request を組めない。
    expect(context.reviewerAnomalies.requiresGuaranteedPresentationCount).toBe(0);
    expect(context.reviewerAnomalies.restatementReadyCount).toBe(0);
    expect(context.reviewerAnomalies.claimBearingTerminalCount).toBe(0);
  });

  it('同じレビュアー枠の後続レビュー登録で withdrawal 決着する', async () => {
    const { ledger } = await record({ matchedRuleIndex: 1, rawFindings: [] });
    const anomalyId = ledger.reviewerAnomalies![0]!.id;

    const superseded = collectReviewSupersededReviewerAnomalyIds(
      ledger,
      new Set([REVIEWER]),
    );
    expect([...superseded]).toEqual([anomalyId]);

    const withdrawn = withdrawReviewerAnomaliesSupersededByReview({
      ledger,
      candidateAnomalyIds: superseded,
      publicationIdsByReviewer: new Map([[REVIEWER, ['c'.repeat(64)]]]),
      observation: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-08-01T01:00:00.000Z' },
    });

    const settled = withdrawn.reviewerAnomalies![0]!;
    expect(settled.settlement).toMatchObject({
      kind: 'withdrawn_by_subsequent_review',
      supersedingPublications: [{ reviewer: REVIEWER, publicationId: 'c'.repeat(64) }],
    });
    expect(isOutstandingReviewerAnomaly(settled)).toBe(false);
    expect(buildFindingsRuleContext(withdrawn, '/cwd', new Map()).reviewerAnomalies.count).toBe(0);
  });

  it('決着後に同じレビュアーが再び非承認 + claim ゼロ件を出すと新しい episode を積む', async () => {
    const first = await record({ matchedRuleIndex: 1, rawFindings: [] });
    const anomalyId = first.ledger.reviewerAnomalies![0]!.id;
    const withdrawn = withdrawReviewerAnomaliesSupersededByReview({
      ledger: first.ledger,
      candidateAnomalyIds: new Set([anomalyId]),
      publicationIdsByReviewer: new Map([[REVIEWER, ['c'.repeat(64)]]]),
      observation: { runId: 'run-2', stepName: 'reviewers', timestamp: '2026-08-01T01:00:00.000Z' },
    });

    const { store, current } = makeStore(withdrawn);
    await recordVerdictClaimsMismatchAnomalies({
      ledgerStore: store,
      findingContract: FINDING_CONTRACT,
      observations: [{
        step: makeStep(),
        response: makeResponse(1),
        publication: {
          ...makePublication([], 'd'.repeat(64)),
          stepIteration: 2,
        },
      }],
      interactive: false,
      runId: 'run-2',
      parentStepName: 'reviewers',
      roundMarker: 'round-2',
      timestamp: '2026-08-01T02:00:00.000Z',
      refreshFindingsState: () => {},
    });

    const anomalies = current().reviewerAnomalies!;
    expect(anomalies).toHaveLength(2);
    expect(anomalies[1]!.id).not.toBe(anomalyId);
    expect(anomalies[1]!.settlement).toBeUndefined();
    expect(buildFindingsRuleContext(current(), '/cwd', new Map()).reviewerAnomalies.count).toBe(1);
  });

  /**
   * 追記は findings-manager コミットの後に走る。manager 側の
   * attachReviewIntegrityState はそのラウンドの verdict anomaly をまだ見ておらず
   * (前ラウンド分は withdrawal 済み・今ラウンド分は未記録で未決着 0 件)、
   * マーカーを付けない。ここで同じラウンドキーの marker を進めないと
   * budgetExhausted に永久に到達せず、review_budget ではなく max_steps まで
   * 再レビューを焼く。
   */
  it('同一レビュアーの REJECT+空が続くと review_budget の到達で budgetExhausted になる', async () => {
    const limit = FINDING_CONTRACT.reviewBudget!.maxReviewRounds!;
    let ledger = makeLedger();
    const budgetExhaustedByRound: boolean[] = [];

    for (let round = 1; round <= limit; round += 1) {
      const publicationId = String(round).repeat(64).slice(0, 64);
      // 前ラウンドの anomaly は次ラウンドの manager コミットで withdrawal 決着する。
      const supersededIds = collectReviewSupersededReviewerAnomalyIds(ledger, new Set([REVIEWER]));
      if (supersededIds.size > 0) {
        ledger = withdrawReviewerAnomaliesSupersededByReview({
          ledger,
          candidateAnomalyIds: supersededIds,
          publicationIdsByReviewer: new Map([[REVIEWER, [publicationId]]]),
          observation: {
            runId: 'run-1',
            stepName: 'reviewers',
            timestamp: `2026-08-0${round}T00:00:00.000Z`,
          },
        });
      }
      // このラウンドの manager コミット時点では未決着 anomaly が 0 件。
      expect((ledger.reviewerAnomalies ?? []).filter(isOutstandingReviewerAnomaly)).toHaveLength(0);

      const { ledger: next } = await record({
        matchedRuleIndex: 1,
        rawFindings: [],
        initial: ledger,
        publicationId,
        roundMarker: `round-${round}`,
      });
      ledger = next;
      budgetExhaustedByRound.push(
        buildFindingsRuleContext(ledger, '/cwd', new Map()).reviewerAnomalies.budgetExhausted,
      );
    }

    expect(ledger.reviewIntegrity?.roundMarkers).toHaveLength(limit);
    // 予算到達までは need_replan へ落ちず、到達した回で初めて落ちる。
    expect(budgetExhaustedByRound).toEqual([
      ...Array.from({ length: limit - 1 }, () => false),
      true,
    ]);
    // 到達時点でも未決着 anomaly は残っているので、COMPLETE ではなく
    // `open.count == 0 && reviewerAnomalies.count > 0 && budgetExhausted` の
    // need_replan 分岐が選ばれる。
    const context = buildFindingsRuleContext(ledger, '/cwd', new Map());
    expect(context.open.count).toBe(0);
    expect(context.reviewerAnomalies.count).toBe(1);
  });

  /**
   * 並列レビュアーは1ラウンド分の observation をまとめて渡す。spec ごとに
   * updateLedger を回すと、同じラウンドの marker が複数回・別トランザクションで
   * 積まれかねない。1回の排他区間で全件適用し marker は1件、が契約。
   */
  it('複数レビュアー分の observation を1回の updateLedger で適用し marker は1件だけ進める', async () => {
    const reviewers = ['arch-review', 'security-review', 'coding-review'] as const;
    const { store, current } = makeStore(makeLedger());
    let updateCalls = 0;
    const wrapped = new Proxy(store, {
      get: (target, key: string | symbol) => {
        if (key !== 'updateLedger') {
          return Reflect.get(target, key) as unknown;
        }
        return async (...args: Parameters<FindingLedgerStore['updateLedger']>) => {
          updateCalls += 1;
          return store.updateLedger(...args);
        };
      },
    });

    const specs = await recordVerdictClaimsMismatchAnomalies({
      ledgerStore: wrapped,
      findingContract: FINDING_CONTRACT,
      observations: reviewers.map((reviewer, index) => ({
        // 判定は非承認、claim はゼロ件。承認のレビュアーを1件混ぜて選別も見る。
        step: makeStep({ name: reviewer, persona: `${reviewer}-persona` } as Partial<WorkflowStep>),
        response: makeResponse(reviewer === 'coding-review' ? 0 : 1),
        publication: {
          ...makePublication([], String(index + 1).repeat(64).slice(0, 64)),
          reviewerStepName: reviewer,
        },
      })),
      interactive: false,
      runId: 'run-1',
      parentStepName: 'reviewers',
      roundMarker: 'round-parallel-1',
      timestamp: '2026-08-01T00:00:00.000Z',
      refreshFindingsState: () => {},
    });

    // 承認判定の1件は spec にならない。
    expect(specs).toHaveLength(2);
    expect(updateCalls).toBe(1);
    const ledger = current();
    expect(ledger.reviewerAnomalies).toHaveLength(2);
    expect(ledger.reviewerAnomalies!.map((anomaly) => anomaly.reviewers).flat().sort())
      .toEqual(['arch-review', 'security-review']);
    // レビュアーごとに別 stableKey（persona キーが違うため）。
    expect(new Set(ledger.reviewerAnomalies!.map((anomaly) => anomaly.stableKey)).size).toBe(2);
    // 同じラウンドなので marker は1件だけ。
    expect(ledger.reviewIntegrity?.roundMarkers).toEqual(['round-parallel-1']);
  });

  it('同じラウンドキーの再適用は marker を二重計上しない（crash/replay 冪等）', async () => {
    const first = await record({
      matchedRuleIndex: 1,
      rawFindings: [],
      roundMarker: 'round-1',
    });
    const replayed = await record({
      matchedRuleIndex: 1,
      rawFindings: [],
      initial: first.ledger,
      roundMarker: 'round-1',
    });

    expect(first.ledger.reviewIntegrity?.roundMarkers).toEqual(['round-1']);
    expect(replayed.ledger.reviewIntegrity?.roundMarkers).toEqual(['round-1']);
    expect(replayed.ledger.reviewerAnomalies).toHaveLength(1);
    expect(replayed.ledger.reviewerAnomalies![0]!.occurrences).toBe(1);
  });
});

/**
 * ゲートが効くのは「純粋な二値判定ラダー」を宣言した FC レビュアーだけで、
 * 承認枝の同定は宣言順にしか依存しない。builtin の FC レビュアーが形か順序を
 * 崩すと、非承認判定が黙殺される(形崩れ)か、承認が非承認として誤検知される
 * (順序反転)。走査で全件拾い、順序まで固定する。
 *
 * 対象は「FC 台帳へ寄稿するレビュアー」= `*-finding-contract` の output contract を
 * 持つ並列サブステップだけに絞る(エンジンの hasFindingContractFormat と同じ判定)。
 * FC ワークフロー内の非レビュアー並列ステップが将来3分岐を宣言しても誤爆しない。
 */
describe('builtin FC parallel reviewer verdict ladders', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-fc-ladder-pin-'));
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** 承認枝として宣言してよいラベル。ラダー先頭はこの集合に属さなければならない。 */
  const APPROVING_LABELS = new Set([
    'approved',
    'No AI-specific issues',
    'AI特有の問題なし',
  ]);
  /** 非承認枝として宣言してよいラベル。ラダー2件目はこの集合に属さなければならない。 */
  const NON_APPROVING_LABELS = new Set([
    'needs_fix',
    'AI-specific issues found',
    'AI特有の問題あり',
  ]);
  /** 走査が静かに 0 件へ退化していないことを確かめる下限。 */
  const EXPECTED_WORKFLOWS = [
    'finding-contract-boundary-review',
    'finding-contract-local-review',
    'peer-review-suite-finding-contract-base',
    'review-fix-takt-default-high',
    'takt-default-high',
    'takt-default-team-high',
  ] as const;

  interface RawRule {
    condition?: string;
    next?: string;
    return?: string;
  }
  interface RawSubStep {
    name?: string;
    rules?: RawRule[];
    output_contracts?: { report?: Array<{ format?: string }> };
  }
  interface RawStep {
    name?: string;
    parallel?: RawSubStep[];
  }
  interface RawWorkflow {
    finding_contract?: unknown;
    subworkflow?: { requires_finding_contract?: boolean };
    steps?: RawStep[];
  }

  /** エンジンの hasFindingContractFormat と同じ判定（formatRef の命名規約）。 */
  function contributesToFindingContract(subStep: RawSubStep): boolean {
    return (subStep.output_contracts?.report ?? []).some(
      (contract) => contract.format?.endsWith('-finding-contract') === true,
    );
  }

  function collectFindingContractReviewerLadders(lang: 'en' | 'ja'): Array<{
    workflow: string;
    step: string;
    reviewer: string;
    conditions: (string | undefined)[];
    rules: RawRule[];
  }> {
    const dir = join(process.cwd(), 'builtins', lang, 'workflows');
    return readdirSync(dir)
      .filter((file) => file.endsWith('.yaml'))
      .flatMap((file) => {
        const workflowPath = join(dir, file);
        const parsed = parseYaml(readFileSync(workflowPath, 'utf-8')) as RawWorkflow | null;
        if (parsed === null || typeof parsed !== 'object') {
          return [];
        }
        const usesFindingContract = parsed.finding_contract !== undefined
          || parsed.subworkflow?.requires_finding_contract === true;
        if (!usesFindingContract) {
          return [];
        }
        // `uses:` の step fragment を展開する。展開後はサブステップが output contract と
        // 自分の判定ラダーを直接持つ（親の rules.parallel はここへ畳まれる）。
        // 展開しないと「どれが FC レビュアーか」を判定できない。
        const raw = resolveWorkflowStepFragments(parsed, {
          candidateDirs: buildStepFragmentLookupDirs({ lang }),
          context: { lang, projectDir },
          workflowPath,
        }).raw as RawWorkflow;
        return (raw.steps ?? []).flatMap((step) => (
          (step.parallel ?? [])
            .filter((subStep) => contributesToFindingContract(subStep) && subStep.rules !== undefined)
            .map((subStep) => ({
              workflow: file.replace(/\.yaml$/u, ''),
              step: step.name ?? '(unnamed)',
              reviewer: subStep.name ?? '(unnamed)',
              conditions: subStep.rules!.map((rule) => rule.condition),
              rules: subStep.rules!,
            }))
        ));
      });
  }

  it.each(['en', 'ja'] as const)('covers every finding-contract reviewer that declares a parallel ladder (%s)', (lang) => {
    const workflows = new Set(collectFindingContractReviewerLadders(lang).map(({ workflow }) => workflow));
    for (const expected of EXPECTED_WORKFLOWS) {
      expect([...workflows], `${expected} (${lang}) is no longer discovered`).toContain(expected);
    }
  });

  it.each(['en', 'ja'] as const)('declares the approving branch first in a routing-free two-branch ladder (%s)', (lang) => {
    const ladders = collectFindingContractReviewerLadders(lang);
    expect(ladders.length).toBeGreaterThan(0);
    for (const ladder of ladders) {
      const where = `${ladder.workflow} (${lang}) / ${ladder.step} / ${ladder.reviewer}`;
      expect(ladder.rules, where).toHaveLength(2);
      for (const rule of ladder.rules) {
        expect(rule.next, where).toBeUndefined();
        expect(rule.return, where).toBeUndefined();
        expect(rule.condition, where).toBeTypeOf('string');
        expect(rule.condition, where).not.toMatch(/^(when|all|any)\(/u);
      }
      // 順序が契約。先頭が承認枝、2件目が非承認枝。
      expect(
        APPROVING_LABELS.has(ladder.conditions[0]!),
        `${where}: leading branch "${ladder.conditions[0]}" must be the approving branch`,
      ).toBe(true);
      expect(
        NON_APPROVING_LABELS.has(ladder.conditions[1]!),
        `${where}: trailing branch "${ladder.conditions[1]}" must be the non-approving branch`,
      ).toBe(true);
    }
  });
});
