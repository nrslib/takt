/**
 * レビュー報告そのものが取り込みプロトコルを満たさなかったときの記録。
 *
 * 一本道の FC レビュアーは「通常の markdown 散文で報告を書く」ことだけが契約で、
 * 正規化係はその報告本文から claim を抽出する。実走で観測された病理は、レビュアーが
 * その契約を無視して報告本文そのものを JSON（raw findings 形式）で出力し、正規化係が
 * エスケープを解いて抽出したために source binding（rawExcerpt が報告本文に byte-exact で
 * ちょうど一度現れること）がゼロ一致で失敗する、というものだった。
 *
 * この失敗は**報告側**に原因があるので、正規化係を別 provider へ乗り換えても解消しない。
 * ラン全体を fail-loud で落とすのではなく、そのレビュアーの protocol anomaly として
 * 台帳へ記録し、既存の言い直し経路へ載せる（#1193 の「報告不成立は計上せず再提示」）。
 * kind は既存の `protocol-anomaly` をそのまま使う — 「主張の真偽を検証する前提となる
 * engine protocol が成立していない」という既存の意味にそのまま当てはまるため、
 * 新 kind も wire 変更も要らない。
 *
 * product finding は作らない。engine に分かるのは「報告が機械可読な取り込み契約を
 * 満たさなかった」という事実だけで、報告の主張が正しいかどうかではない。
 */
import type { AgentResponse, FindingContractConfig } from '../../models/types.js';
import { computeReviewerAnomalyStableKey, computeReviewerStableKey } from './raw-canonicalization.js';
import { RAW_FINDING_LIMITS } from './raw-finding-limits.js';
import { attachReviewIntegrityState, resolveReviewIntegrityLimits } from './review-integrity.js';
import { applyReviewerAnomalySpecsToLedger, type ReviewerAnomalySpec } from './reviewer-anomalies.js';
import { computeRoundMarker } from './round-marker.js';
import type { FindingLedgerStore } from './store.js';

export const REVIEW_REPORT_PROTOCOL_ANOMALY_KIND = 'protocol-anomaly' as const;

/** 正規化が報告側の原因で成立しなかった1レビュアー分の観測。 */
export interface ReviewReportProtocolRejection {
  readonly reviewerStepName: string;
  readonly reviewerPersonaKey: string;
  readonly reportContent: string;
  /** 正規化係が返した具体的な失敗理由（どの item がどの検証に落ちたか）。 */
  readonly reason: string;
}

/**
 * 報告拒否時にルール評価へ渡す応答。
 *
 * 初回実行でも保存済み報告からの resume でも、ルールが読む本文は「拒否された
 * その報告」でなければならない。初回だけ Phase 1 の作業ログを渡すと、同じ状況で
 * 経路によって別のラベルが確定し、all() / any() の集計とルーティングが揺れる。
 */
export function reviewReportProtocolRejectionResponse(input: {
  readonly stepName: string;
  readonly reportContent: string;
}): AgentResponse {
  return {
    persona: input.stepName,
    status: 'done',
    content: input.reportContent,
    timestamp: new Date(),
  };
}

function boundedReportExcerpt(reportContent: string): string {
  return reportContent.trim().slice(0, RAW_FINDING_LIMITS.maxDescriptionChars);
}

export function reviewReportProtocolAnomalySpec(input: {
  readonly rejection: ReviewReportProtocolRejection;
  readonly workflowName: string;
  readonly callNamespace: string;
  readonly parentStepName: string;
}): ReviewerAnomalySpec {
  const reviewerStableKey = computeReviewerStableKey({
    workflowName: input.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStepName,
    reviewerPersonaKey: input.rejection.reviewerPersonaKey,
  });
  // claim は1件も成立していないので raw 由来の lineage は無い。product finding 側の
  // lineage と衝突しない専用の名前空間で採番し、誤昇格を構造的に防ぐ。
  const lineageKey = computeReviewerAnomalyStableKey({
    reviewerStableKey,
    lineageKey: 'review-report-protocol',
    anomalyKind: REVIEW_REPORT_PROTOCOL_ANOMALY_KIND,
  });
  return {
    kind: REVIEW_REPORT_PROTOCOL_ANOMALY_KIND,
    stableKey: computeReviewerAnomalyStableKey({
      reviewerStableKey,
      lineageKey,
      anomalyKind: REVIEW_REPORT_PROTOCOL_ANOMALY_KIND,
    }),
    lineageKey,
    sourceRawFindingIds: [],
    sourceIntakeIds: [],
    reviewers: [input.rejection.reviewerStepName],
    title: `Review report did not satisfy the intake protocol: ${input.rejection.reviewerStepName}`,
    claimedExcerpt: boundedReportExcerpt(input.rejection.reportContent),
    mismatchReason:
      `Reviewer "${input.rejection.reviewerStepName}" published a report the normalizer could not bind to `
      + 'its own text, so no claim reached the ledger. Rewrite the report as ordinary Markdown prose — '
      + 'plain sentences, not JSON and not a structured-output payload — and state each issue in its own '
      + `sentence so the extractor can quote it verbatim. Normalizer detail: ${input.rejection.reason}`,
  };
}

/**
 * 報告側原因の正規化失敗を anomaly として追記し、そのラウンドの review-integrity
 * 予算を進める。
 *
 * roundMarker は findings-manager と同じ `computeRoundMarker` を同じ入力で計算する。
 * publication が1件でも成立したラウンドでは manager と同じ値になり `addRoundMarker`
 * が重複を潰すので二重計上しない。全レビュアーが報告側原因で落ちたラウンドは manager が
 * 走らないため、ここで進めないと予算が永久に減らず max_steps まで再レビューを焼く。
 */
export async function recordReviewReportProtocolAnomalies(input: {
  readonly ledgerStore: FindingLedgerStore | undefined;
  readonly findingContract: FindingContractConfig;
  readonly rejections: readonly ReviewReportProtocolRejection[];
  /** そのラウンドで成立した publication の ID 全件（0件でもよい）。 */
  readonly publicationIds: readonly string[];
  readonly runId: string;
  readonly callNamespace: string;
  readonly parentStepName: string;
  readonly stepIteration: number;
  readonly timestamp: string;
  readonly refreshFindingsState: () => void;
}): Promise<readonly ReviewerAnomalySpec[]> {
  if (input.rejections.length === 0) {
    return [];
  }
  const ledgerStore = input.ledgerStore;
  if (ledgerStore === undefined) {
    throw new Error('Finding contract is configured but finding ledger store is not available');
  }
  const specs = input.rejections.map((rejection) => reviewReportProtocolAnomalySpec({
    rejection,
    workflowName: ledgerStore.workflowName,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStepName,
  }));
  const roundMarker = computeRoundMarker({
    runId: input.runId,
    callNamespace: input.callNamespace,
    parentStepName: input.parentStepName,
    stepIteration: input.stepIteration,
    publicationIds: input.publicationIds,
  });
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
        roundMarker,
        input.timestamp,
      ),
      result: undefined,
    };
  });
  input.refreshFindingsState();
  return specs;
}
