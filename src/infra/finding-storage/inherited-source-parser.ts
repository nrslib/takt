import type { FindingLedger } from '../../core/workflow/findings/types.js';
import { parseFindingLedger } from '../../core/models/finding-schemas.js';

export interface SourceAuthorityRaw {
  authorityKey: string;
  workflowName: string;
  revision: number;
  ledgerJson: string;
}

/**
 * 継承元 run の finding authority を現行契約でだけ読む。FC 台帳に後方互換は
 * 持たない — 現行 schema に一致しない ledger_json は parseFindingLedger が
 * そのまま拒否する（runs は一回きり。旧形式の run は新しい run として
 * 最初からやり直す）。
 */
export function parseInheritedSourceAuthority(
  source: SourceAuthorityRaw,
): FindingLedger {
  if (
    source.authorityKey.length === 0
    || source.workflowName.length === 0
    || !Number.isSafeInteger(source.revision)
    || source.revision < 1
  ) {
    throw new Error(`Finding authority "${source.authorityKey}" has invalid metadata`);
  }
  return parseFindingLedger(JSON.parse(source.ledgerJson));
}
