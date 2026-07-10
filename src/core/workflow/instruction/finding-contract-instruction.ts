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
  const isReviewer = Boolean(contract.rawFindingsJsonSchema);

  const rendered = loadTemplate('parts/finding_contract_instruction', language, {
    ledgerCopyPath: contract.ledgerCopyPath,
    ledgerSummary: renderFencedJsonBlock(contract.ledgerSummary),
    isReviewer,
    reviewerHasOpenFindings: isReviewer && contract.hasOpenFindings,
    reviewerHasWaivedFindings: isReviewer && contract.hasWaivedFindings,
    rawFindingsJsonSchema: contract.rawFindingsJsonSchema
      ? renderFencedJsonBlock(contract.rawFindingsJsonSchema)
      : '',
    // 異議申告のガイドは open な指摘が存在するときだけ注入する。台帳が空の
    // 段階（初回 implement 等）では無意味であり、無関係なプロトコル文が
    // 弱いモデルのツール呼び出しを不安定化させることを実走で確認済み。
    canDispute: !isReviewer && contract.hasOpenFindings,
  });

  return rendered.trimEnd();
}

export interface FindingContractReportInstructionInput {
  ledgerCopyPath: string;
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
  const { ledgerCopyPath, reportLedgerSummary, language, renderFencedJsonBlock } = input;

  const rendered = loadTemplate('parts/finding_contract_instruction', language, {
    ledgerCopyPath,
    ledgerSummary: renderFencedJsonBlock(reportLedgerSummary),
    isReportPhase: true,
  });

  return rendered.trimEnd();
}
