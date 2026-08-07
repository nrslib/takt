/**
 * 非承認判定と構造化 claim の整合ゲート。
 *
 * FC レビュアーは report 本文で APPROVE / REJECT を述べ、同じ判定の根拠を
 * structured raw findings として提出する契約になっている。REJECT を出しながら
 * raw findings を1件も出さない publication は、報告本文にどれだけ主張が書かれて
 * いても台帳へ何も残さないため、決定的ルールラダーからは「指摘ゼロ」と
 * 見分けがつかない。その状態を放置すると非承認判定が黙って捨てられる。
 *
 * ここでは reviewer anomaly（review-integrity 側の台帳）へ観測事実だけを記録する。
 * product finding は作らない — 「何が壊れているか」は engine には分からず、
 * 分かるのは「非承認判定に対応する機械可読な claim が提出されていない」という
 * 事実だけである。記録された anomaly は他の非 intake anomaly と同じライフサイクル
 * （同じレビュアー枠の次のレビューが台帳へ登録された時点で withdrawal 決着）に乗る。
 * エンジンがするのは記録だけで、遷移そのものは変えない — COMPLETE を回避できるのは、
 * ワークフローが `when(findings.reviewerAnomalies.count > 0)` 系の rule を COMPLETE の
 * rule より前に宣言している場合だけである（builtin の FC スイートは宣言済み）。
 *
 * 追記は findings-manager のコミット後に走るため、そのラウンドの
 * review-integrity 予算マーカーはここで進める。manager コミット時点では
 * 「前ラウンド分は withdrawal 済み・今ラウンド分は未記録」で未決着 0 件になり、
 * manager 側の attachReviewIntegrityState がマーカーを付けないまま素通りする。
 * それを放置すると budgetExhausted に永久に到達せず、review_budget ではなく
 * max_steps まで再レビューを焼く。marker は manager と同じ computeRoundMarker の
 * 値を共有するので、二重計上も crash/replay の二度付けも起きない。
 */
import type { AgentResponse, FindingContractConfig, WorkflowRule, WorkflowStep } from '../../models/types.js';
import {
  semanticLabelsOf,
  semanticRuleCandidatesOf,
} from '../../models/workflow-rule-condition.js';
import { createLogger } from '../../../shared/utils/index.js';
import { computeReviewerAnomalyStableKey, computeReviewerStableKey } from './raw-canonicalization.js';
import { RAW_FINDING_LIMITS } from './raw-finding-limits.js';
import { attachReviewIntegrityState, resolveReviewIntegrityLimits } from './review-integrity.js';
import { applyReviewerAnomalySpecsToLedger, type ReviewerAnomalySpec } from './reviewer-anomalies.js';
import type { CanonicalFindingReviewPublication } from './review-publication.js';
import type { FindingLedgerStore } from './store.js';

const log = createLogger('verdict-claims-integrity');

export const VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND = 'verdict-claims-mismatch' as const;

export interface ReviewerVerdict {
  /** 判定として選ばれた semantic label（エンジンが確定させた値をそのまま使う）。 */
  readonly label: string;
  /** ラダー先頭の承認枝が選ばれたか。 */
  readonly approving: boolean;
}

/**
 * ラベル語彙はワークフロー側の自由記述（`approved` / `needs_fix` にも
 * `No AI-specific issues` / `AI-specific issues found` にもなる）なので、
 * エンジンは語彙から承認枝を同定できない。同定できるのは「純粋な二値判定
 * ラダー」という形だけである。
 *
 * 純粋な二値判定ラダー = 全 rule が semantic 条件で、routing 効果（next /
 * return）を一切持たず、semantic 候補がちょうど2件。この形の rule は判定を
 * 表明する以外の役割を持たないので、先頭が承認・後続が非承認という宣言順が
 * 唯一の読み方になる（builtins/skill/references/yaml-schema.md の
 * 「Finding Contract レビュアーの判定ラダー」に明文化した位置依存契約）。
 *
 * この形を外れるラダー（`when(findings.*)` を混ぜる、rule が routing する等）は
 * 承認枝を同定できないため対象外にする。例えば merge-readiness の最終ゲートは
 * `needs_fix` を `approved` より前に宣言しており、宣言順で読むと承認と非承認が
 * 逆転する。形で弾くことで、その種の誤読を構造的に起こさない。
 */
function isBinaryVerdictLadder(
  rules: readonly WorkflowRule[],
  candidateCount: number,
): boolean {
  return candidateCount === 2
    && rules.every((rule) => (
      rule.condition.kind === 'semantic'
      && rule.next === undefined
      && rule.returnValue === undefined
    ));
}

/**
 * レビュアー step の判定を、エンジンが既に確定させた値だけから読み取る。
 *
 * 判定の正本は rule 評価結果（`matchedRuleIndex`）であり、report 散文を
 * 読み直すことはしない。承認枝を同定できないラダーと、rule が一致しなかった
 * 応答では `undefined` を返す。ゲートが無言で消えないよう、判定ラダーは
 * あるのに形が合わずゲートを外す場合は警告を残す。
 */
export function resolveReviewerVerdict(
  step: WorkflowStep,
  response: AgentResponse,
  interactive: boolean,
): ReviewerVerdict | undefined {
  const rules = step.rules;
  const matchedRuleIndex = response.matchedRuleIndex;
  if (rules === undefined || matchedRuleIndex === undefined) {
    return undefined;
  }
  const matchedRule = rules[matchedRuleIndex];
  const label = matchedRule === undefined
    ? undefined
    : semanticLabelsOf(matchedRule.condition)[0];
  if (label === undefined) {
    return undefined;
  }
  const candidates = semanticRuleCandidatesOf(rules, interactive);
  const approvalLabel = candidates[0]?.label;
  if (approvalLabel === undefined || !isBinaryVerdictLadder(rules, candidates.length)) {
    log.warn(
      'Reviewer verdict ladder is not a routing-free two-branch ladder; '
      + 'the verdict/claims integrity gate is disabled for this reviewer',
      {
        step: step.name,
        matchedLabel: label,
        semanticCandidateCount: candidates.length,
      },
    );
    return undefined;
  }
  return { label, approving: label === approvalLabel };
}

function boundedClaimedExcerpt(verdictLabel: string, reportContent: string): string {
  const claim = `verdict: ${verdictLabel}\n\n${reportContent}`.trim();
  return claim.slice(0, RAW_FINDING_LIMITS.maxDescriptionChars);
}

/**
 * 非承認判定 + claim ゼロ件のときだけ spec を返す。承認判定（claim ゼロ件が正常）と
 * claim を提出した非承認判定では `undefined` を返す。
 */
export function verdictClaimsMismatchAnomalySpec(input: {
  readonly publication: CanonicalFindingReviewPublication;
  readonly verdict: ReviewerVerdict;
  readonly workflowName: string;
  readonly reviewerPersonaKey: string;
}): ReviewerAnomalySpec | undefined {
  if (input.verdict.approving || input.publication.rawFindings.length > 0) {
    return undefined;
  }
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: input.workflowName,
    callNamespace: input.publication.callNamespace,
    parentStepName: input.publication.parentStepName,
    reviewerPersonaKey: input.reviewerPersonaKey,
  });
  // claim が1件も無いので raw 由来の lineage は存在しない。product finding 側の
  // lineage と衝突しない専用の名前空間で採番し、誤昇格を構造的に防ぐ。
  const lineageKey = computeReviewerAnomalyStableKey({
    reviewerStableKey,
    lineageKey: VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND,
    anomalyKind: VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND,
  });
  return {
    kind: VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND,
    stableKey: computeReviewerAnomalyStableKey({
      reviewerStableKey,
      lineageKey,
      anomalyKind: VERDICT_CLAIMS_MISMATCH_ANOMALY_KIND,
    }),
    lineageKey,
    sourceRawFindingIds: [],
    sourceIntakeIds: [input.publication.publicationId],
    reviewers: [input.publication.reviewerStepName],
    title: `Non-approving review without structured claims: ${input.publication.reviewerStepName}`,
    claimedExcerpt: boundedClaimedExcerpt(
      input.verdict.label,
      input.publication.reportContent,
    ),
    mismatchReason: `Reviewer "${input.publication.reviewerStepName}" selected the non-approving verdict "${input.verdict.label}" but published zero structured raw findings, so the report's claims never reached the ledger; restate the basis of that verdict as structured claims`,
  };
}

export interface VerdictClaimsMismatchObservation {
  readonly step: WorkflowStep;
  readonly response: AgentResponse;
  readonly publication: CanonicalFindingReviewPublication;
}

function reviewerPersonaKeyOf(step: WorkflowStep): string {
  return (step as { persona?: string }).persona ?? step.name;
}

/**
 * このラウンドのレビュアー判定を台帳へ突き合わせ、非承認 + claim ゼロ件だけを
 * anomaly として追記し、同じ排他区間でそのラウンドの review-integrity 予算を
 * 進める。manager の取り込みとは独立した engine 専用の決定的追記なので、
 * LLM の判断は一切介在しない。
 *
 * 監査可視性の注記: 台帳の JSON スナップショット（findings-ledger.json）は
 * findings-manager のコミット時にだけ書き出される。ここで追記した anomaly は
 * SQLite 台帳には即時反映されるが、スナップショットには次の manager ラウンドまで
 * 現れない。ルーティング（when(findings.*)）は SQLite 側を読むので判断は正しく、
 * ずれるのは監査用スナップショットの鮮度だけである。
 */
export async function recordVerdictClaimsMismatchAnomalies(input: {
  readonly ledgerStore: FindingLedgerStore | undefined;
  readonly findingContract: FindingContractConfig;
  readonly observations: readonly VerdictClaimsMismatchObservation[];
  readonly interactive: boolean;
  readonly runId: string;
  readonly parentStepName: string;
  /** findings-manager が使ったのと同じラウンドキー（FindingManagerRunResult.roundMarker）。 */
  readonly roundMarker: string;
  readonly timestamp: string;
  readonly refreshFindingsState: () => void;
}): Promise<readonly ReviewerAnomalySpec[]> {
  const ledgerStore = input.ledgerStore;
  if (ledgerStore === undefined) {
    throw new Error('Finding contract is configured but finding ledger store is not available');
  }
  const specs = input.observations.flatMap((observation) => {
    const verdict = resolveReviewerVerdict(
      observation.step,
      observation.response,
      input.interactive,
    );
    if (verdict === undefined) {
      return [];
    }
    const spec = verdictClaimsMismatchAnomalySpec({
      publication: observation.publication,
      verdict,
      workflowName: ledgerStore.workflowName,
      reviewerPersonaKey: reviewerPersonaKeyOf(observation.step),
    });
    return spec === undefined ? [] : [spec];
  });
  if (specs.length === 0) {
    return specs;
  }
  const limits = resolveReviewIntegrityLimits(input.findingContract.reviewBudget);
  await ledgerStore.updateLedger((ledger) => {
    const withAnomalies = applyReviewerAnomalySpecsToLedger(
      ledger,
      specs,
      {
        workflowName: ledgerStore.workflowName,
        runId: input.runId,
        stepName: input.parentStepName,
        timestamp: input.timestamp,
      },
      new Set(),
    );
    return {
      ledger: attachReviewIntegrityState(
        ledger,
        withAnomalies,
        limits,
        input.roundMarker,
        input.timestamp,
      ),
      result: undefined,
    };
  });
  input.refreshFindingsState();
  return specs;
}
