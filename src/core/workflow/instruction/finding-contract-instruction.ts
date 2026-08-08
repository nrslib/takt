import type { Language } from '../../models/types.js';
import type { FindingContractInstructionContext } from './instruction-context.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Finding Contract の指示文を組み立てる。
 *
 * 文面は src/shared/prompts/{en,ja}/parts/finding_contract_instruction.md に置く。
 * `## Disputed Findings` と `findingId` は散文ではなくプロトコルトークンで、
 * manager-output-validation.ts の hasDisputeClaimsHeading() / hasDisputeClaimFor()
 * が英語リテラルで照合する。ja テンプレートは散文だけを訳し、トークンは英語のまま
 * 書くよう明示している。
 *
 * テンプレートエンジンは {{#if}} の入れ子を扱えないため、条件はここで畳んでから渡す。
 */

export interface FindingContractInstructionInput {
  contract: FindingContractInstructionContext;
  language: Language;
  renderFencedJsonBlock: (value: unknown) => string;
}

function renderFindingContractInstruction(input: {
  contract: FindingContractInstructionContext;
  language: Language;
  renderFencedJsonBlock: (value: unknown) => string;
  reportPhase: boolean;
}): string {
  const {
    contract,
    language,
    renderFencedJsonBlock,
    reportPhase,
  } = input;
  const reviewer = contract.reviewer;
  const isReviewer = reviewer !== undefined;
  const restatementRequests = reviewer?.presentationContext?.revision === 2
    ? reviewer.presentationContext.restatementRequests
    : [];
  // テンプレートエンジンは {{#if}} の入れ子を扱えない（{{#unless}} も無い）ため、
  // 「再提示専用レビューでは通常のレビュー指示を出さない」という入れ子条件は
  // ここで各フラグへ畳んでから渡す。
  //
  // 判定は呼び出し側が渡す mode だけを見る。request 件数から導出すると、
  // 「言い直し request 付きの完全な再レビュー」が言い直し専用指示に化け、その
  // publication で withdrawal（後続レビュー成立による取り下げ）が走ってしまう。
  const hasRestatementRequests = restatementRequests.length > 0;
  // request が1件も無い呼び出しは、mode が restatement-only でも「言い直しだけ」に
  // ならない（指示が空になる）。抑止は request が実在するときだけ効かせる。
  const restatementOnly = reviewer?.mode === 'restatement-only' && hasRestatementRequests;
  const restatementAlongsideReview = hasRestatementRequests && !restatementOnly;

  // review-integrity protocol: reviewer context は必ず reviewScopeSnapshotId と
  // セットで生成される（WorkflowEngineSetup.ts の
  // buildFindingContractInstructionContext 参照）。reviewer 用の
  // FindingContractInstructionContext を組む経路が reviewScopeSnapshotId の配線を
  // 落とすと engine が evidence request を現在の review scope に束縛できない。
  // 引用が完全に正確でも product finding へ絶対に昇格できず、reviewer
  // anomaly に落ち続けるという重大な machine-detectable な配線バグであるにも
  // かかわらず、`?? ''` によるサイレントな空文字 fallback はこれを不可視にする
  // （実際に ParallelRunner が inline で context を組み立てて発生させていた）。
  // このモジュール一帯は fail-closed 方針（ledger store 欠落等は throw）を取って
  // おり、ここも唯一の発見場所として throw で止める。呼び出し側は
  // optionsBuilder.buildFindingContractInstructionContext(step, true) 経由で
  // context を組み立てる限りこの分岐に到達しない。
  if (
    isReviewer
    && (
      typeof reviewer.reviewScopeSnapshotId !== 'string'
      || reviewer.reviewScopeSnapshotId.length === 0
    )
  ) {
    throw new Error(
      'Finding contract reviewer instruction is missing reviewScopeSnapshotId. This is a wiring bug '
      + 'in the caller that built the FindingContractInstructionContext: a reviewer context must '
      + 'always carry reviewScopeSnapshotId (see '
      + 'WorkflowEngineSetup.buildFindingContractInstructionContext). Build the context via '
      + 'optionsBuilder.buildFindingContractInstructionContext(step, true) instead of constructing '
      + 'it inline.',
    );
  }

  const rendered = loadTemplate('parts/finding_contract_instruction', language, {
    ledgerSummary: renderFencedJsonBlock(
      reportPhase ? contract.reportLedgerSummary : contract.ledgerSummary,
    ).trimEnd(),
    isReportPhase: reportPhase,
    reviewerReportGuidance: isReviewer && !restatementOnly,
    reviewerHasOpenFindings: isReviewer && contract.hasOpenFindings && !restatementOnly,
    reviewerHasWaivedFindings: isReviewer && contract.hasWaivedFindings && !restatementOnly,
    reviewerHasDismissedFindings: isReviewer && contract.hasDismissedFindings && !restatementOnly,
    provisionalGuidance: !restatementOnly,
    restatementOnly,
    restatementAlongsideReview,
    hasRestatementRequests,
    restatementRequestsJson: hasRestatementRequests
      ? renderFencedJsonBlock(restatementRequests).trimEnd()
      : '',
    // 異議申告のガイドは open な指摘が存在するときだけ注入する。台帳が空の
    // 段階（初回 implement 等）では無意味であり、無関係なプロトコル文が
    // 弱いモデルのツール呼び出しを不安定化させることを実走で確認済み。
    canDispute: !isReviewer && contract.hasOpenFindings,
  });

  return rendered.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function buildFindingContractInstruction(input: FindingContractInstructionInput): string {
  return renderFindingContractInstruction({
    ...input,
    reportPhase: false,
  });
}

export interface FindingContractReportInstructionInput {
  contract: FindingContractInstructionContext;
  language: Language;
  renderFencedJsonBlock: (value: unknown) => string;
}

/**
 * Phase 2（レポート出力フェーズ）用の Finding Contract 指示文を組み立てる。
 *
 * Phase 2 はツール呼び出しを行わない出力専用フェーズだが、reviewer 契約は
 * Phase 1 と同じ context から引き継ぐ。これにより新規 session retry / provider
 * fallback でも、レポート本文と raw findings を同じ応答から抽出する publication
 * schema を欠落させない。台帳だけは ID 参照用の reportLedgerSummary を使う。
 */
export function buildFindingContractReportInstruction(input: FindingContractReportInstructionInput): string {
  return renderFindingContractInstruction({
    ...input,
    reportPhase: true,
  });
}
