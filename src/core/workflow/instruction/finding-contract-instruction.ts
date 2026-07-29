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

export function buildFindingContractInstruction(input: FindingContractInstructionInput): string {
  const { contract, language, renderFencedJsonBlock } = input;
  const reviewer = contract.reviewer;
  const isReviewer = reviewer !== undefined;
  const structuredReviewer = reviewer?.mode === 'structured';
  const freeformReviewer = reviewer?.mode === 'freeform';
  const rawFindingsStructuredOutput = structuredReviewer
    ? reviewer.rawFindingsStructuredOutput
    : undefined;

  // review-integrity protocol: rawFindingsStructuredOutput と reviewScopeSnapshotId は同じ
  // includeRawFindingsSchema 条件下で必ずセットで生成される（WorkflowEngineSetup.ts
  // の buildFindingContractInstructionContext 参照）。reviewer 用の
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
      'Finding contract reviewer instruction is missing reviewScopeSnapshotId even though '
      + 'rawFindingsStructuredOutput is present. This is a wiring bug in the caller that built the '
      + 'FindingContractInstructionContext: rawFindingsStructuredOutput and reviewScopeSnapshotId must '
      + 'always be set together (see WorkflowEngineSetup.buildFindingContractInstructionContext). '
      + 'Build the context via optionsBuilder.buildFindingContractInstructionContext(step, true) '
      + 'instead of constructing it inline.',
    );
  }

  const rendered = loadTemplate('parts/finding_contract_instruction', language, {
    ledgerSummary: renderFencedJsonBlock(contract.ledgerSummary),
    isReviewer,
    structuredReviewer,
    freeformReviewer,
    reviewerHasOpenFindings: isReviewer && contract.hasOpenFindings,
    reviewerHasWaivedFindings: isReviewer && contract.hasWaivedFindings,
    reviewerHasDismissedFindings: isReviewer && contract.hasDismissedFindings,
    rawFindingsJsonSchema: rawFindingsStructuredOutput
      ? renderFencedJsonBlock(rawFindingsStructuredOutput.schema)
      : '',
    // review-integrity protocol: reviewer step のときだけ設定される（instruction-context.ts
    // 参照）。空文字は「該当なし」— テンプレート側は isReviewer と一緒にしか
    // 出さない。
    reviewScopeSnapshotId: reviewer?.reviewScopeSnapshotId ?? '',
    // 異議申告のガイドは open な指摘が存在するときだけ注入する。台帳が空の
    // 段階（初回 implement 等）では無意味であり、無関係なプロトコル文が
    // 弱いモデルのツール呼び出しを不安定化させることを実走で確認済み。
    canDispute: !isReviewer && contract.hasOpenFindings,
  });

  return rendered.trimEnd();
}

export interface FindingContractReportInstructionInput {
  reportLedgerSummary: unknown;
  language: Language;
  renderFencedJsonBlock: (value: unknown) => string;
}

/**
 * Phase 2（レポート出力フェーズ）用の Finding Contract 指示文を組み立てる。
 *
 * Phase 2 はツール呼び出しを行わない出力専用フェーズのため、isReviewer /
 * canDispute 系の分岐は常に false（未指定）で渡し、テンプレート側の
 * isReportPhase 分岐だけを使う。Phase 1 とは異なる文言（「inline ledger
 * summary」「ledger IDs」）になるのは reportLedgerSummary が ledgerSummary
 * とは別の（IDのみの）データだから。
 */
export function buildFindingContractReportInstruction(input: FindingContractReportInstructionInput): string {
  const { reportLedgerSummary, language, renderFencedJsonBlock } = input;

  const rendered = loadTemplate('parts/finding_contract_instruction', language, {
    ledgerSummary: renderFencedJsonBlock(reportLedgerSummary),
    isReportPhase: true,
  });

  return rendered.trimEnd();
}
