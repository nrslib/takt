const FINDINGS = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
  testing: 'TEST-NEW-readme-examples-L1',
  security: 'SEC-NEW-secret-leak-L3',
  antipattern: 'AI-NEW-windows-proof-L1',
};

const ACTIONABLE_HEADING = /^#{2,3}\s+(?:修正対象\s*family|Actionable Famil(?:y|ies))(?:\s*[:：].*)?$/i;
const DISPOSITION_HEADING = /^#{2,3}\s+(?:指摘|finding).*?(?:裁定|dispositions?)$/i;
const MECHANISM = /(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)/i;
const MECHANISM_REJECTION = /(?:含めない|不要|根拠がない|対象外|過剰|不採用|採用しない|要求しない|追加しない|実装しない|導入しない|必要(?:性)?[^\n。.!?]*(?:ない|なく)|(?:not|never|without)[^\n。.!?]{0,80}(?:add|use|implement|introduce|require|promote|atomic|transaction|rollback)|(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)[^\n。.!?]{0,80}(?:not\b|unnecessary|out\s+of\s+scope|overreach|not\s+part|not\s+warranted|not\s+justified|not\s+needed|not\s+necessary)|unnecessary|out\s+of\s+scope|overreach|not\s+part\s+of\s+the\s+task|no\s+(?:evidence|requirement|authority|need))/i;
const MECHANISM_REQUIREMENT = /(?:(?<!\bnot\s)(?<!\bnever\s)(?:implement|add|use|introduce|enforce|create|construct|require|make|build|adopt|provide|ensure|establish|wrap|surround|enclose)\b[^\n。.!?]{0,80}(?:atomic|transaction|rollback)|(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)[^\n。.!?]{0,80}(?:\b(?:is required|must|should|needs? to be)\b|(?:を|が)(?:実装|追加|使用|導入|採用|構築)(?:する|せよ|してください|すべき)|(?:実装|追加|使用|導入|採用|構築)(?:が)?(?:必要|必須)))/i;
const CONTRASTED_REQUIREMENT = /(?:\b(?:but|however|yet)\b|それでも|ただし|一方|ものの|にもかかわらず)/i;
const QUALITY_DUPLICATION = /(?:\bDRY\b|\bduplicat(?:e|ed|es|ion)\b|重複|複製)/i;
const QUALITY_BOUNDARY = /(?:responsibility(?:[-\s]+boundary)?|boundary|責務|境界)/i;
const INTERNAL_REPAIR = /(?:normalizeChannel|normalize(?:d|s)?[^\n。.!?]{0,40}(?:once|一度|単一)|shared\s+(?:boundary|normalizer)|remove\s+(?:the\s+)?duplication|deduplicat|delegate[^\n。.!?]{0,40}(?:validation|normaliz)|local(?:\s+internal)?\s+fix|共有(?:の)?(?:境界|正規化)|重複(?:を|の)?(?:除去|解消)|単一(?:の)?正規化|局所(?:的)?(?:な)?修正|入口[^\n。.!?]{0,50}normalizeChannel|独自判定[^\n。.!?]{0,40}残さない)/i;
const ACCEPTED_CHANNELS = /\blocal\b[^\n]{0,100}\bcloud\b|\bcloud\b[^\n]{0,100}\blocal\b/i;
const NORMALIZATION_BEHAVIOR = /(?:case[-\s]?insensitiv|ignore[^\n。.!?]{0,50}(?:case|大小文字)|大小文字|大文字小文字|surrounding\s+whitespace|trim(?:ming)?|前後[^\n。.!?]{0,30}空白|空白[^\n。.!?]{0,30}(?:除去|無視|trim))/i;
const NORMALIZATION_EXAMPLE = /["'`]\s+[A-Z][A-Za-z]*\s+["'`][^\n]{0,160}["'`][a-z]+["'`]/;
const NORMALIZATION_CASE_VARIANTS = /(?:`local`[^\n]{0,80}`LOCAL`|`LOCAL`[^\n]{0,80}`local`|`cloud`[^\n]{0,80}`CLOUD`|`CLOUD`[^\n]{0,80}`cloud`)/;
const NORMALIZATION_WHITESPACE_VARIANT = /["'`]\s+(?:local|cloud)\s+["'`]/i;
const INVALID_FAIL_FAST = /(?:invalid|unsupported|reject(?:ed)?|fail\s+fast|throw|error|不正|無効|拒否|即時|早期[^\n。.!?]{0,20}失敗|例外|(?:以外|other\s+than|outside)[^\n。.!?]{0,60}(?:fail|reject|error|失敗|拒否|例外))/i;
const NO_LEGACY_ALIAS = /(?:(?:no|without|do\s+not|must\s+not|not\s+add|reject)[^\n。.!?]{0,80}(?:legacy|compatibility)?\s*aliases?|(?:legacy|compatibility)\s+aliases?[^\n。.!?]{0,80}(?:not|required|forbidden)|(?:旧|レガシー|互換)[^\n。.!?]{0,60}(?:alias|エイリアス|別名)[^\n。.!?]{0,40}(?:追加しない|禁止|不要|なし)|(?:alias|エイリアス|別名)[^\n。.!?]{0,60}(?:追加しない|禁止|不要|なし))/i;

function extractSection(output, startPattern, endPattern) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => startPattern.test(line.trim()));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => endPattern.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function extractHeadingSection(output, startPattern) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => startPattern.test(line.trim()));
  if (start < 0) return '';
  const headingDepth = lines[start].trim().match(/^#+/)?.[0].length ?? 0;
  const endOffset = lines.slice(start + 1).findIndex((line) => {
    const depth = line.trim().match(/^#+/)?.[0].length;
    return depth !== undefined && depth <= headingDepth;
  });
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function parseTable(section) {
  const rows = section.split('\n')
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim().replaceAll('`', '')))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));

  return {
    header: rows[0] ?? [],
    rows: rows.slice(1),
  };
}

function findDispositionTableSection(output) {
  const lines = output.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\|.*\|\s*$/.test(lines[index])) continue;
    const tableLines = [];
    while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    const section = tableLines.join('\n');
    if (hasDispositionSchema(parseTable(section))) return section;
  }
  return '';
}

function rowForFinding(rows, findingId) {
  return rows.filter((cells) => cells.some((cell) => cell.includes(findingId)));
}

function isDispositionValue(value) {
  return /^(actionable|duplicate|false_positive|overreach|out_of_scope|no_issue_after_verification|environment_unverified)$/i.test(value ?? '');
}

function dispositionColumnIndex(table) {
  const explicitIndex = table.header.findIndex((cell) => /disposition/i.test(cell));
  if (explicitIndex >= 0) return explicitIndex;
  return table.header.findIndex((_cell, index) =>
    table.rows.length > 0 && table.rows.every((row) => isDispositionValue(row[index])));
}

function dispositionOf(row) {
  return row.find((cell) => isDispositionValue(cell)) ?? '';
}

function familyRefs(value) {
  return [...value.matchAll(/\b(?:FAM(?:ILY)?-[A-Za-z0-9-]+|F-[A-Za-z0-9][A-Za-z0-9-]*)\b/g)]
    .map((match) => match[0].toLowerCase());
}

function targetOf(table, row) {
  const dispositionIndex = dispositionColumnIndex(table);
  const targetIndex = table.header.findIndex((cell, index) =>
    index !== dispositionIndex
      && /(?:target|family|統合先|根拠|理由|evidence|rationale|reason|裁定|decision|judgment)/i.test(cell)
      && !/(?:finding|出典|disposition)/i.test(cell));
  if (targetIndex < 0) return '';

  const header = table.header[targetIndex] ?? '';
  const cell = row[targetIndex] ?? '';
  if (/^(?:none|no\s+target|not\s+applicable|n\/a|なし|該当なし|-|—)(?:\s*\([^)]*\))?$/i.test(cell)) return '';

  const explicitFamily = familyRefs(cell)[0];
  if (explicitFamily) return explicitFamily;
  const isCombinedTargetAndReason = (
    /(?:target|family|統合先)/i.test(header)
      && /(?:根拠|理由|evidence|rationale|reason)/i.test(header)
  ) || /(?:裁定|decision|judgment)/i.test(header);
  if (isCombinedTargetAndReason) {
    const leadingFamily = cell.match(/^([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/);
    return leadingFamily ? leadingFamily[1].toLowerCase() : null;
  }
  if (/(?:理由|reason)/i.test(header)) {
    const leadingFamily = cell.match(/^([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/);
    if (leadingFamily) return leadingFamily[1].toLowerCase();
    return null;
  }
  if (/(?:根拠|evidence|rationale)/i.test(header)) {
    const isShortTarget = !/[。.!?;；]/u.test(cell) && cell.trim().split(/\s+/u).length <= 4;
    return isShortTarget ? cell.trim().toLowerCase() : null;
  }

  return cell.trim().toLowerCase();
}

function sameActionableFamily(actionableSection, dispositionTable, codeRow, architectureRow) {
  const codeTarget = targetOf(dispositionTable, codeRow);
  const architectureTarget = targetOf(dispositionTable, architectureRow);
  const sameTarget = typeof codeTarget === 'string'
    && typeof architectureTarget === 'string'
    && codeTarget.length > 0
    && codeTarget === architectureTarget;

  if (sameTarget) return true;

  const actionableTable = parseTable(actionableSection);
  const sameTableFamily = actionableTable.rows.some((row) =>
    row.some((cell) => cell.includes(FINDINGS.code))
    && row.some((cell) => cell.includes(FINDINGS.architecture)));

  const sameHeadingFamily = /^###\s+/m.test(actionableSection)
    && actionableSection.split(/(?=^###\s+)/m).some((block) =>
      block.includes(FINDINGS.code) && block.includes(FINDINGS.architecture));
  const sameNarrativeFamily = actionableTable.rows.length === 0
    && actionableSection.includes(FINDINGS.code)
    && actionableSection.includes(FINDINGS.architecture);

  return sameTableFamily || sameHeadingFamily || sameNarrativeFamily;
}

function acceptanceContexts(actionableSection) {
  const contexts = [];
  const lines = actionableSection.split('\n');
  const start = lines.findIndex((line) => /^(?:-\s*)?(?:受入条件|Acceptance criteria)\s*:?$/i.test(
    line.trim().replace(/^\*\*|\*\*$/g, ''),
  ));
  if (start >= 0) {
    const endOffset = lines.slice(start + 1).findIndex((line) => /^#{2,3}\s+/.test(line.trim()));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    contexts.push(lines.slice(start + 1, end).join('\n'));
  }

  const table = parseTable(actionableSection);
  const acceptanceIndex = table.header.findIndex((cell) => /(?:受入条件|acceptance criteria)/i.test(cell));
  if (acceptanceIndex >= 0) {
    contexts.push(...table.rows.map((row) => row[acceptanceIndex] ?? ''));
  }

  return contexts.filter((context) => context.trim().length > 0);
}

function doesNotPromoteMechanism(contexts) {
  const mechanismUnits = contexts.flatMap((context) =>
    context.split(/\n|[;；]|(?<=[。.!?])\s+/u).filter((unit) => MECHANISM.test(unit)));
  return mechanismUnits.length > 0 && mechanismUnits.every((unit) =>
    MECHANISM_REJECTION.test(unit)
      && !(CONTRASTED_REQUIREMENT.test(unit) && MECHANISM_REQUIREMENT.test(unit)));
}

function hasNoExplicitTarget(table, row) {
  const target = targetOf(table, row);
  return target === '' || target === null;
}

function hasDispositionSchema(table) {
  const findingIndex = table.header.findIndex((cell) => /(?:finding|指摘)/i.test(cell));
  const dispositionIndex = dispositionColumnIndex(table);
  const detailIndex = table.header.findIndex((cell, index) =>
    index !== findingIndex
      && index !== dispositionIndex
      && /(?:target|family|統合先|evidence|reason|根拠|理由|裁定|decision|judgment)/i.test(cell));
  return findingIndex >= 0 && dispositionIndex >= 0 && detailIndex >= 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasIncludedFindingId(value, findingId) {
  const exactId = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegex(findingId)}(?=$|[^A-Za-z0-9_-])`);
  return value.split(/[,;；\n]/u).some((part) =>
    exactId.test(part)
      && !/(?:excluded|not\s+included|除外|対象外)/i.test(part));
}

function isActionableFamilyMember(actionableSection, findingId) {
  const table = parseTable(actionableSection);
  const findingColumn = table.header.findIndex((cell) => /(?:finding|指摘).*(?:id|ID|出典|source)/i.test(cell));
  if (findingColumn >= 0) {
    return table.rows.some((row) => hasIncludedFindingId(row[findingColumn] ?? '', findingId));
  }

  return actionableSection.split('\n').some((line) =>
    /(?:finding\s*IDs?|source\s+findings?|主\s*finding|統合\s*finding|指摘\s*ID)/i.test(line)
      && hasIncludedFindingId(line, findingId));
}

export default function assertReviewAdjudication(output) {
  const actionableSection = extractHeadingSection(output, ACTIONABLE_HEADING);
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);

  const codeRows = rowForFinding(dispositionTable.rows, FINDINGS.code);
  const architectureRows = rowForFinding(dispositionTable.rows, FINDINGS.architecture);
  const testingRows = rowForFinding(dispositionTable.rows, FINDINGS.testing);
  const securityRows = rowForFinding(dispositionTable.rows, FINDINGS.security);
  const antipatternRows = rowForFinding(dispositionTable.rows, FINDINGS.antipattern);
  const codeRow = codeRows[0] ?? [];
  const architectureRow = architectureRows[0] ?? [];
  const testingRow = testingRows[0] ?? [];
  const securityRow = securityRows[0] ?? [];
  const antipatternRow = antipatternRows[0] ?? [];
  const nonActionableIds = [FINDINGS.testing, FINDINGS.security, FINDINGS.antipattern];
  const actionableEvidence = `${actionableSection}\n${codeRow.join(' ')}\n${architectureRow.join(' ')}`;
  const acceptanceEvidence = acceptanceContexts(actionableSection).join('\n');

  const checks = [
    ['actionable-result', /(結果\s*[:：]\s*修正対象あり|Result\s*[:：]\s*ACTIONABLE FINDINGS|(?:修正対象は\s*[1-9]\d*|[1-9]\d*つの修正対象)\s*family)/i.test(output)],
    ['disposition-schema', hasDispositionSchema(dispositionTable)],
    ['one-disposition-per-finding', [codeRows, architectureRows, testingRows, securityRows, antipatternRows]
      .every((rows) => rows.length === 1)],
    ['code-actionable', /^actionable$/i.test(dispositionOf(codeRow))],
    ['architecture-duplicate', /^duplicate$/i.test(dispositionOf(architectureRow))],
    ['same-actionable-family', sameActionableFamily(actionableSection, dispositionTable, codeRow, architectureRow)],
    ['quality-defect-retained', QUALITY_DUPLICATION.test(actionableSection)
      && QUALITY_BOUNDARY.test(actionableSection)],
    ['minimal-internal-repair-retained', INTERNAL_REPAIR.test(actionableEvidence)],
    ['acceptance-values', ACCEPTED_CHANNELS.test(acceptanceEvidence)],
    ['acceptance-normalization', NORMALIZATION_BEHAVIOR.test(acceptanceEvidence)
      || NORMALIZATION_EXAMPLE.test(acceptanceEvidence)
      || (NORMALIZATION_CASE_VARIANTS.test(acceptanceEvidence)
        && NORMALIZATION_WHITESPACE_VARIANT.test(acceptanceEvidence))],
    ['acceptance-invalid-fail-fast', INVALID_FAIL_FAST.test(acceptanceEvidence)],
    ['acceptance-no-legacy-alias', NO_LEGACY_ALIAS.test(actionableEvidence)],
    ['non-actionable-excluded-from-family', nonActionableIds.every((id) =>
      !isActionableFamilyMember(actionableSection, id))],
    ['suggested-mechanism-not-promoted', doesNotPromoteMechanism([
      acceptanceEvidence,
      dispositionSection,
    ])],
    ['testing-overreach', /^(overreach|out_of_scope)$/i.test(dispositionOf(testingRow))
      && hasNoExplicitTarget(dispositionTable, testingRow)],
    ['security-false-positive', /^(false_positive|no_issue_after_verification)$/i.test(dispositionOf(securityRow))
      && hasNoExplicitTarget(dispositionTable, securityRow)],
    ['antipattern-out-of-scope', /^(environment_unverified|overreach|out_of_scope)$/i.test(dispositionOf(antipatternRow))
      && hasNoExplicitTarget(dispositionTable, antipatternRow)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'every finding is bound to one consistent disposition and actionable family'
      : `failed: ${failed.join(', ')}`,
  };
}
