const FINDINGS = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
  typeError: 'ARCH-NEW-channel-type-error-L2',
  remediation: 'CODE-NEW-worker-channel-retention-L2',
  horizontal: 'ARCH-NEW-build-label-dup-L1',
  testing: 'TEST-NEW-readme-examples-L1',
  security: 'SEC-NEW-secret-leak-L3',
  antipattern: 'AI-NEW-windows-proof-L1',
};
const AUTHORIZATION_BASES = new Set([
  'remediation_regression',
  'required_consumer_migration',
  'accepted_family_unvisited_consumer',
  'direct_acceptance_criterion_violation',
]);
const EXPECTED_INITIAL_AUTHORIZATION_BASIS = 'direct_acceptance_criterion_violation';
const DISPOSITION_VALUE = /^(actionable|duplicate|false_positive|overreach|out_of_scope|no_issue_after_verification|environment_unverified)$/i;

const ACTIONABLE_HEADING = /^#{2,3}\s+(?:修正対象\s*family|Actionable Famil(?:y|ies))(?:\s*[:：].*)?$/i;
const DISPOSITION_HEADING = /^#{2,3}\s+(?:指摘|finding).*?(?:裁定|dispositions?)$/i;
const MECHANISM = /(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)/i;
const MECHANISM_REJECTION = /(?:含めない|不要|根拠がない|対象外|過剰|不採用|採用しない|要求しない|追加しない|実装しない|導入しない|契約にしない|変更しない|(?:追加|実装|導入|変更)(?:は|を)?行わない|必要(?:性)?[^\n。.!?]*(?:ない|なく)|(?:not|never|without)[^\n。.!?]{0,80}(?:add|use|implement|introduce|require|promote|atomic|transaction|rollback)|(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)[^\n。.!?]{0,80}(?:not\b|unnecessary|out\s+of\s+scope|overreach|not\s+part|not\s+warranted|not\s+justified|not\s+needed|not\s+necessary)|unnecessary|out\s+of\s+scope|overreach|not\s+part\s+of\s+the\s+task|no\s+(?:evidence|requirement|authority|need))/i;
const MECHANISM_REQUIREMENT = /(?:(?<!\bnot\s)(?<!\bnever\s)(?:implement|add|use|introduce|enforce|create|construct|require|make|build|adopt|provide|ensure|establish|wrap|surround|enclose)\b[^\n。.!?]{0,80}(?:atomic|transaction|rollback)|(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)[^\n。.!?]{0,80}(?:\b(?:is required|must|should|needs? to be)\b|(?:を|が)(?:実装|追加|使用|導入|採用|構築)(?:する|せよ|してください|すべき)|(?:実装|追加|使用|導入|採用|構築)(?:が)?(?:必要|必須)))/i;
const CONTRASTED_REQUIREMENT = /(?:\b(?:but|however|yet)\b|それでも|ただし|一方|ものの|にもかかわらず)/i;
const QUALITY_DUPLICATION = /(?:\bDRY\b|\bduplicat(?:e|ed|es|ion)\b|重複|複製|(?:独自|個別)(?:に)?[^\n。.!?]{0,40}(?:扱|検証|判定|正規化)|共有[^\n。.!?]{0,40}(?:normalizer|正規化)[^\n。.!?]{0,50}(?:一貫|利用|適用|迂回)|(?:normalizer|正規化)[^\n。.!?]{0,50}(?:正本|一本化|集約)|(?:independently|separately|own)[^\n。.!?]{0,40}(?:validat|normaliz))/i;
const QUALITY_BOUNDARY = /(?:responsibility(?:[-\s]+boundary)?|boundary|責務|境界)/i;
const INTERNAL_REPAIR = /(?:normalizeChannel|normalize(?:d|s)?[^\n。.!?]{0,40}(?:once|一度|単一)|shared\s+(?:boundary|normalizer)|remove\s+(?:the\s+)?duplication|deduplicat|delegate[^\n。.!?]{0,40}(?:validation|normaliz)|local(?:\s+internal)?\s+fix|共有(?:の)?(?:境界|正規化)|重複(?:を|の)?(?:除去|解消)|単一(?:の)?正規化|局所(?:的)?(?:な)?修正|入口[^\n。.!?]{0,50}normalizeChannel|独自判定[^\n。.!?]{0,40}残さない)/i;
const ACCEPTED_CHANNELS = /\blocal\b[^\n]{0,100}\bcloud\b|\bcloud\b[^\n]{0,100}\blocal\b/i;
const NORMALIZATION_BEHAVIOR = /(?:case[-\s]?insensitiv|ignore[^\n。.!?]{0,50}(?:case|大小文字)|大小文字|大文字小文字|surrounding\s+whitespace|trim(?:ming)?|前後[^\n。.!?]{0,30}空白|空白[^\n。.!?]{0,30}(?:除去|無視|trim))/i;
const NORMALIZATION_EXAMPLE = /["'`]\s+[A-Z][A-Za-z]*\s+["'`][^\n]{0,160}["'`][a-z]+["'`]/;
const NORMALIZATION_CASE_VARIANTS = /(?:`local`[^\n]{0,80}`LOCAL`|`LOCAL`[^\n]{0,80}`local`|`cloud`[^\n]{0,80}`CLOUD`|`CLOUD`[^\n]{0,80}`cloud`)/;
const NORMALIZATION_WHITESPACE_VARIANT = /["'`]\s+(?:local|cloud)\s+["'`]/i;
const NORMALIZATION_WHITESPACE_VALUE = /(?:^|[,、])\s+(?:local|cloud)\s+(?=[,、]|$)/im;
const NORMALIZATION_UPPERCASE_VARIANT = /\b(?:LOCAL|CLOUD|Cloud)\b/;
const NORMALIZATION_COMBINED_EXAMPLES = /(?:["'`]\s+(?:local|cloud)\s+["'`][^\n]{0,160}\b(?:LOCAL|CLOUD|Cloud)\b|\b(?:LOCAL|CLOUD|Cloud)\b[^\n]{0,160}["'`]\s+(?:local|cloud)\s+["'`])/;
const INVALID_FAIL_FAST = /(?:invalid|unsupported|reject(?:ed)?|fail\s+fast|throw|error|不正|無効|拒否|即時|早期[^\n。.!?]{0,20}失敗|例外|(?:その他|以外|other\s+than|outside)[^\n。.!?]{0,60}(?:fail|reject|error|失敗|拒否|例外))/i;
const NO_LEGACY_ALIAS = /(?:(?:no|without|do\s+not|must\s+not|not\s+add|reject)[^\n。.!?]{0,80}(?:legacy|compatibility)?\s*aliases?|(?:legacy|compatibility)\s+aliases?[^\n。.!?]{0,80}(?:not|required|forbidden)|禁止(?:する)?拡張[^\n。.!?]{0,80}(?:(?:legacy|compatibility)?\s*(?:alias|エイリアス|別名)|(?:旧|レガシー|互換)[^\n。.!?]{0,30}(?:alias|エイリアス|別名))|(?:旧|レガシー|互換)[^\n。.!?]{0,60}(?:alias|エイリアス|別名)[^\n。.!?]{0,60}(?:含めない|追加しない|追加(?:を)?行わない|禁止|不要|なし|受理しない|受理され(?:ない|ず)|許可しない|許可され(?:ない|ず)|認めない|認められ(?:ない|ず)|拒否する|拒否され(?:る|ない))|(?:legacy|compatibility)?\s*(?:alias|エイリアス|別名)[^\n。.!?]{0,60}(?:含めない|追加しない|追加(?:を)?行わない|禁止|不要|なし|受理しない|受理され(?:ない|ず)|許可しない|許可され(?:ない|ず)|認めない|認められ(?:ない|ず)|拒否する|拒否され(?:る|ない)))/i;

export function hasNoLegacyAliasEvidence(context) {
  return NO_LEGACY_ALIAS.test(context);
}

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

function dispositionRowsForFinding(table, findingId) {
  const findingIndex = table.header.findIndex((cell) =>
    /(?:(?:finding|指摘).*(?:id|出典|source)|(?:id|source|出典).*(?:finding|指摘))/i.test(cell));
  if (findingIndex < 0) return rowForFinding(table.rows, findingId);
  return table.rows.filter((row) => hasIncludedFindingId(row[findingIndex] ?? '', findingId));
}

function isDispositionValue(value) {
  return DISPOSITION_VALUE.test(value?.trim() ?? '');
}

function dispositionColumnIndex(table) {
  const explicitIndex = table.header.findIndex((cell) => /disposition/i.test(cell));
  if (explicitIndex >= 0) return explicitIndex;
  return table.header.findIndex((_cell, index) =>
    table.rows.length > 0 && table.rows.every((row) => isDispositionValue(row[index])));
}

function dispositionOf(row) {
  for (const cell of row) {
    const match = cell.trim().match(DISPOSITION_VALUE);
    if (match) return match[1];
  }
  return '';
}

function normalizeResultLine(rawLine) {
  return rawLine.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '');
}

function isActionableResultLine(line) {
  return /^(?:(?:The\s+)?adjudication\s+result\s+is\s+|(?:Adjudication\s+)?Result\s*[:：]\s*)ACTIONABLE FINDINGS(?:[.!]|\s*\(blocking\))?$/i.test(line)
    || /^(?:(?:裁定)?結果(?:\s*[:：]\s*|は\s*[「『"']?\s*))修正対象あり[」』"']?(?:[。.!]|\s*[（(]blocking[）)])?$/i.test(line)
    || /^修正対象(?:の\s*family)?は\s*[1-9]\d*\s*(?:family|件|つ)(?:です)?[。.!]?$/i.test(line)
    || /^[1-9]\d*つの修正対象\s*family(?:です)?[。.!]?$/i.test(line);
}

function isNonActionableResultLine(line) {
  return /^(?:(?:The\s+)?adjudication\s+result\s+is\s+|(?:Adjudication\s+)?Result\s*[:：]\s*)(?:NO|NOT)\s+ACTIONABLE FINDINGS[.!]?$/i.test(line)
    || /^(?:(?:裁定)?結果(?:\s*[:：]\s*|は\s*[「『"']?\s*))修正対象なし[」』"']?[。.!]?$/i.test(line);
}

function hasActionableResult(output) {
  const resultLines = output.split('\n').map(normalizeResultLine);
  return resultLines.filter(isActionableResultLine).length === 1
    && !resultLines.some(isNonActionableResultLine);
}

function authorizationBasisColumnIndex(table) {
  return table.header.findIndex((cell) =>
    /^(?:Authorization basis|修正権限の根拠|finding 自身の basis)$/i.test(cell));
}

function authorizationBasisOf(table, row) {
  const index = authorizationBasisColumnIndex(table);
  return index < 0 ? '' : (row[index]?.trim() ?? '');
}

export function isExactAuthorizationBasis(value, expected) {
  return value === expected;
}

function hasExactAuthorizationBasis(table, row, expected) {
  return isExactAuthorizationBasis(authorizationBasisOf(table, row), expected);
}

function hasValidSingleAuthorizationBasis(table, row) {
  return AUTHORIZATION_BASES.has(authorizationBasisOf(table, row));
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

  const actionableFamilies = [...new Set(familyRefs(actionableSection))];
  if (actionableFamilies.length === 1) {
    const [actionableFamily] = actionableFamilies;
    const codeUsesActionableFamily = codeTarget === actionableFamily
      || (codeTarget === null && /(?:上記|this|above)\s*family/i.test(codeRow.join(' ')));
    if (codeUsesActionableFamily && architectureTarget === actionableFamily) return true;
  }

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

function hasFieldInEveryDispositionRow(table, headerPattern) {
  const index = table.header.findIndex((cell) => headerPattern.test(cell));
  return index >= 0
    && table.rows.length > 0
    && table.rows.every((row) => {
      const value = row[index]?.trim() ?? '';
      return value.length > 0 && !/^[-—]$/u.test(value);
    });
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
  const findingColumn = table.header.findIndex((cell) =>
    /(?:(?:finding|指摘).*(?:id|出典|source)|(?:source|出典).*(?:finding|指摘))/i.test(cell));
  if (findingColumn >= 0) {
    return table.rows.some((row) => hasIncludedFindingId(row[findingColumn] ?? '', findingId));
  }

  return actionableSection.split('\n').some((line) =>
    /(?:finding\s*IDs?|source\s+findings?|主\s*finding|統合\s*finding|指摘\s*ID)/i.test(line)
      && hasIncludedFindingId(line, findingId));
}

function actionableRowsForFinding(table, findingId) {
  return table.rows.filter((row) => row.some((cell) => hasIncludedFindingId(cell, findingId)));
}

function actionableFamilyName(table, row) {
  const index = table.header.findIndex((cell) => /^family$/i.test(cell));
  return index < 0 ? '' : (row[index]?.trim().toLowerCase() ?? '');
}

export function hasBasisPartitionedFamily(actionableSection, expectedFindingBases) {
  const table = parseTable(actionableSection);
  const entries = Object.entries(expectedFindingBases);
  const matchedRows = entries.map(([findingId, expectedBasis]) => {
    const rows = actionableRowsForFinding(table, findingId);
    if (rows.length !== 1 || !hasExactAuthorizationBasis(table, rows[0], expectedBasis)) return undefined;
    return rows[0];
  });
  if (matchedRows.some((row) => row === undefined)) return false;

  const familyNames = matchedRows.map((row) => actionableFamilyName(table, row));
  if (familyNames.some((name) => name.length === 0) || new Set(familyNames).size !== 1) return false;

  return table.rows.every((row) => {
    const includedEntries = entries.filter(([findingId]) =>
      row.some((cell) => hasIncludedFindingId(cell, findingId)));
    if (includedEntries.length === 0) return true;
    const rowBasis = authorizationBasisOf(table, row);
    return includedEntries.every(([, expectedBasis]) => expectedBasis === rowBasis);
  });
}

export default function assertReviewAdjudication(output) {
  const actionableSection = extractHeadingSection(output, ACTIONABLE_HEADING);
  const actionableTable = parseTable(actionableSection);
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);

  const codeRows = dispositionRowsForFinding(dispositionTable, FINDINGS.code);
  const architectureRows = dispositionRowsForFinding(dispositionTable, FINDINGS.architecture);
  const typeErrorRows = dispositionRowsForFinding(dispositionTable, FINDINGS.typeError);
  const remediationRows = dispositionRowsForFinding(dispositionTable, FINDINGS.remediation);
  const horizontalRows = dispositionRowsForFinding(dispositionTable, FINDINGS.horizontal);
  const testingRows = dispositionRowsForFinding(dispositionTable, FINDINGS.testing);
  const securityRows = dispositionRowsForFinding(dispositionTable, FINDINGS.security);
  const antipatternRows = dispositionRowsForFinding(dispositionTable, FINDINGS.antipattern);
  const codeRow = codeRows[0] ?? [];
  const architectureRow = architectureRows[0] ?? [];
  const typeErrorRow = typeErrorRows[0] ?? [];
  const remediationRow = remediationRows[0] ?? [];
  const horizontalRow = horizontalRows[0] ?? [];
  const testingRow = testingRows[0] ?? [];
  const securityRow = securityRows[0] ?? [];
  const antipatternRow = antipatternRows[0] ?? [];
  const nonActionableIds = [
    FINDINGS.typeError,
    FINDINGS.horizontal,
    FINDINGS.testing,
    FINDINGS.security,
    FINDINGS.antipattern,
  ];
  const dispositionRowsByFinding = [
    [FINDINGS.code, codeRows],
    [FINDINGS.architecture, architectureRows],
    [FINDINGS.typeError, typeErrorRows],
    [FINDINGS.remediation, remediationRows],
    [FINDINGS.horizontal, horizontalRows],
    [FINDINGS.testing, testingRows],
    [FINDINGS.security, securityRows],
    [FINDINGS.antipattern, antipatternRows],
  ];
  const actionableEvidence = `${actionableSection}\n${codeRow.join(' ')}\n${architectureRow.join(' ')}`;
  const acceptanceEvidence = acceptanceContexts(actionableSection).join('\n');
  const codeFamilyRows = actionableRowsForFinding(actionableTable, FINDINGS.code);
  const architectureFamilyRows = actionableRowsForFinding(actionableTable, FINDINGS.architecture);
  const remediationFamilyRows = actionableRowsForFinding(actionableTable, FINDINGS.remediation);
  const directFamilyRow = codeFamilyRows[0] ?? [];
  const remediationFamilyRow = remediationFamilyRows[0] ?? [];

  const checks = [
    ['actionable-result', hasActionableResult(output)],
    ['disposition-schema', hasDispositionSchema(dispositionTable)],
    ['technical-validity-present', hasFieldInEveryDispositionRow(
      dispositionTable,
      /^(?:Technical validity|技術的妥当性)$/i,
    )],
    ['reason-to-change-present', hasFieldInEveryDispositionRow(
      dispositionTable,
      /^(?:Reason to change from the same cause|同じ原因で変更される理由)$/i,
    )],
    ['authorization-basis-present', hasFieldInEveryDispositionRow(
      dispositionTable,
      /^(?:Authorization basis|修正権限の根拠)$/i,
    )],
    ['code-exact-authorization-basis', hasExactAuthorizationBasis(
      dispositionTable,
      codeRow,
      EXPECTED_INITIAL_AUTHORIZATION_BASIS,
    )],
    ['architecture-exact-authorization-basis', hasExactAuthorizationBasis(
      dispositionTable,
      architectureRow,
      EXPECTED_INITIAL_AUTHORIZATION_BASIS,
    )],
    ['remediation-exact-authorization-basis', hasExactAuthorizationBasis(
      dispositionTable,
      remediationRow,
      'remediation_regression',
    )],
    ['actionable-family-bases-are-finding-specific', hasBasisPartitionedFamily(actionableSection, {
      [FINDINGS.code]: EXPECTED_INITIAL_AUTHORIZATION_BASIS,
      [FINDINGS.architecture]: EXPECTED_INITIAL_AUTHORIZATION_BASIS,
      [FINDINGS.remediation]: 'remediation_regression',
    }) && directFamilyRow === architectureFamilyRows[0] && directFamilyRow !== remediationFamilyRow],
    ['mixed-basis-rows-preserve-one-family-identity', actionableFamilyName(actionableTable, directFamilyRow).length > 0
      && actionableFamilyName(actionableTable, directFamilyRow)
        === actionableFamilyName(actionableTable, remediationFamilyRow)],
    ['actionable-dispositions-use-single-machine-basis', dispositionTable.rows.every((row) =>
      !/^(?:actionable|duplicate)$/i.test(dispositionOf(row))
        || hasValidSingleAuthorizationBasis(dispositionTable, row))],
    ['reason-absent-present', hasFieldInEveryDispositionRow(
      dispositionTable,
      /^(?:Reason absent from initial round|初回に含まれなかった理由)$/i,
    )],
    ['one-disposition-per-finding', dispositionRowsByFinding.every(([, rows]) => rows.length === 1)],
    ['dispositions-consistent-across-report', dispositionRowsByFinding.every(([findingId, rows]) => {
      if (rows.length !== 1) return false;
      const expectedDisposition = dispositionOf(rows[0]).toLowerCase();
      return expectedDisposition.length > 0
        && hasNoContradictoryDispositionOutsideTables(
          output,
          findingId,
          (value) => value === expectedDisposition,
        );
    })],
    ['code-actionable', /^actionable$/i.test(dispositionOf(codeRow))],
    ['architecture-duplicate', /^duplicate$/i.test(dispositionOf(architectureRow))],
    ['remediation-actionable-or-duplicate', /^(?:actionable|duplicate)$/i.test(dispositionOf(remediationRow))],
    ['same-actionable-family', sameActionableFamily(actionableSection, dispositionTable, codeRow, architectureRow)],
    ['unrequired-error-shape-overreach', /^overreach$/i.test(dispositionOf(typeErrorRow))
      && hasNoExplicitTarget(dispositionTable, typeErrorRow)],
    ['horizontal-valid-but-out-of-scope', /^out_of_scope$/i.test(dispositionOf(horizontalRow))
      && hasNoExplicitTarget(dispositionTable, horizontalRow)],
    ['quality-defect-retained', QUALITY_DUPLICATION.test(actionableSection)
      && QUALITY_BOUNDARY.test(actionableSection)],
    ['minimal-internal-repair-retained', INTERNAL_REPAIR.test(actionableEvidence)],
    ['acceptance-values', ACCEPTED_CHANNELS.test(acceptanceEvidence)],
    ['acceptance-normalization', NORMALIZATION_BEHAVIOR.test(acceptanceEvidence)
      || NORMALIZATION_EXAMPLE.test(acceptanceEvidence)
      || NORMALIZATION_COMBINED_EXAMPLES.test(acceptanceEvidence)
      || (NORMALIZATION_WHITESPACE_VARIANT.test(acceptanceEvidence)
        && NORMALIZATION_UPPERCASE_VARIANT.test(acceptanceEvidence))
      || (NORMALIZATION_WHITESPACE_VALUE.test(acceptanceEvidence)
        && NORMALIZATION_UPPERCASE_VARIANT.test(acceptanceEvidence))
      || (NORMALIZATION_CASE_VARIANTS.test(acceptanceEvidence)
        && NORMALIZATION_WHITESPACE_VARIANT.test(acceptanceEvidence))],
    ['acceptance-invalid-fail-fast', INVALID_FAIL_FAST.test(acceptanceEvidence)],
    ['acceptance-no-legacy-alias', hasNoLegacyAliasEvidence(actionableEvidence)],
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

export function assertSeparatedTypeErrorFamily(output) {
  const actionableSection = extractHeadingSection(output, ACTIONABLE_HEADING);
  const actionableTable = parseTable(actionableSection);
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);
  const typeErrorRows = dispositionRowsForFinding(dispositionTable, FINDINGS.typeError);
  const typeErrorRow = typeErrorRows[0] ?? [];
  const typeErrorFamilyRows = actionableRowsForFinding(actionableTable, FINDINGS.typeError);
  const codeFamilyRows = actionableRowsForFinding(actionableTable, FINDINGS.code);
  const typeErrorFamily = actionableFamilyName(actionableTable, typeErrorFamilyRows[0] ?? []);
  const codeFamily = actionableFamilyName(actionableTable, codeFamilyRows[0] ?? []);

  const checks = [
    ['one-type-error-disposition', typeErrorRows.length === 1],
    ['type-error-actionable', /^actionable$/i.test(dispositionOf(typeErrorRow))],
    ['type-error-initial-basis-converted', hasExactAuthorizationBasis(
      dispositionTable,
      typeErrorRow,
      EXPECTED_INITIAL_AUTHORIZATION_BASIS,
    )],
    ['one-type-error-family-row', typeErrorFamilyRows.length === 1],
    ['type-error-family-row-basis', hasExactAuthorizationBasis(
      actionableTable,
      typeErrorFamilyRows[0] ?? [],
      EXPECTED_INITIAL_AUTHORIZATION_BASIS,
    )],
    ['different-invariant-kept-separate', typeErrorFamily.length > 0
      && codeFamily.length > 0
      && typeErrorFamily !== codeFamily],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the initial type-error finding is adjudicated once with a direct basis in a separate family'
      : `failed: ${failed.join(', ')}`,
  };
}

export function assertTypeErrorOverreach(output) {
  const actionableSection = extractHeadingSection(output, ACTIONABLE_HEADING);
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);
  const typeErrorRows = dispositionRowsForFinding(dispositionTable, FINDINGS.typeError);
  const typeErrorRow = typeErrorRows[0] ?? [];
  const checks = [
    ['one-type-error-disposition', typeErrorRows.length === 1],
    ['type-error-overreach', /^overreach$/i.test(dispositionOf(typeErrorRow))],
    ['type-error-has-no-family', hasNoExplicitTarget(dispositionTable, typeErrorRow)],
    ['type-error-has-no-basis', /^(?:none|not applicable|n\/a|なし|該当なし|-|—)$/i.test(
      authorizationBasisOf(dispositionTable, typeErrorRow),
    )],
    ['type-error-has-no-contradictory-disposition', hasNoContradictoryDispositionOutsideTables(
      output,
      FINDINGS.typeError,
      (value) => isCompatibleWithDisposition(value, 'overreach'),
    )],
    ['type-error-excluded-from-actionable-family', !isActionableFamilyMember(
      actionableSection,
      FINDINGS.typeError,
    )],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the unrequired type-error shape remains overreach without remediation authority'
      : `failed: ${failed.join(', ')}`,
  };
}

function findingLineContexts(output, findingId) {
  return output.split('\n')
    .filter((line) => line.includes(findingId));
}

function hasMachineValue(context, value) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${value}(?=$|[^A-Za-z0-9_])`).test(context);
}

function hasExactSingleMachineValue(context, expected) {
  const authorizationContext = context.replace(
    /(?:Reason Absent from Initial Round|初回に含まれなかった理由)[^|;；。.!?]*/gi,
    '',
  );
  const presentValues = [...AUTHORIZATION_BASES]
    .filter((value) => hasMachineValue(authorizationContext, value));
  const hasNotApplicableValue = /(?:^|[\s`'"|:：,、;；/(])(?:not applicable|n\/a|none|該当なし|なし)(?=$|[\s`'"|.,。！!?)）])/i.test(authorizationContext);
  return presentValues.length === 1
    && presentValues[0] === expected
    && !hasNotApplicableValue;
}

function hasExactDispositionLine(lines, disposition, expected, evidence) {
  const negatedDisposition = /\bnot\s+(?:actionable|(?:an?\s+)?duplicate)\b|(?:actionable|duplicate|修正対象|重複)[^\n。.!?]{0,12}(?:ではない|でない)/i;
  const dispositionValues = narrativeDispositionValues(lines);
  return dispositionValues.length === 1
    && disposition.test(dispositionValues[0])
    && lines.some((line) => disposition.test(line)
    && !negatedDisposition.test(line)
    && hasExactSingleMachineValue(line, expected)
    && (evidence === undefined || evidence.test(line)));
}

function hasExactFindingDisposition(output, findingId, disposition, expected, evidence) {
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);
  const rows = dispositionRowsForFinding(dispositionTable, findingId);

  if (rows.length === 1) {
    const row = rows[0];
    const rowDisposition = dispositionOf(row);
    const hasExpectedBasis = hasExactAuthorizationBasis(dispositionTable, row, expected)
      || (authorizationBasisColumnIndex(dispositionTable) < 0
        && hasExactSingleMachineValue(row.join(' | '), expected));
    return disposition.test(rowDisposition)
      && hasNoContradictoryDispositionOutsideTables(
        output,
        findingId,
        (value) => isCompatibleWithDisposition(value, rowDisposition.toLowerCase()),
      )
      && hasExpectedBasis
      && (evidence === undefined || evidence.test(row.join(' ')));
  }

  return hasExactDispositionLine(
    findingLineContexts(output, findingId),
    disposition,
    expected,
    evidence,
  );
}

const DISPOSITION_VALUES = [
  'actionable',
  'duplicate',
  'false_positive',
  'overreach',
  'out_of_scope',
  'no_issue_after_verification',
  'environment_unverified',
];
const NON_ACTIONABLE_DISPOSITION = 'non_actionable';
const ACTIONABLE_DISPOSITIONS = new Set(['actionable', 'duplicate']);
const NEGATED_DISPOSITION_VALUES = DISPOSITION_VALUES.map((value) => `not_${value}`);
const NARRATIVE_DISPOSITION_VALUES = [
  ...DISPOSITION_VALUES,
  NON_ACTIONABLE_DISPOSITION,
  ...NEGATED_DISPOSITION_VALUES,
];
const NARRATIVE_CLAUSE_BOUNDARY = '[、,;；。.!?]|\\b(?:although|while|whereas|but)\\b|(?:だが|ですが|であり)';
const DISPOSITION_TOKEN = new RegExp(
  `\\b(?:${NARRATIVE_DISPOSITION_VALUES.join('|')})\\b`,
  'gi',
);
const FINDING_ID_PATTERN = `(?<![A-Za-z0-9_-])(?:${Object.values(FINDINGS).map(escapeRegex).join('|')})(?![A-Za-z0-9_-])`;
const FINDING_ID_TOKEN = new RegExp(FINDING_ID_PATTERN, 'g');
const FINDING_ID_VALUE = new RegExp(FINDING_ID_PATTERN);

function normalizeNegatedDispositionValues(value) {
  const dispositionAlternation = DISPOSITION_VALUES.join('|');
  const markdownMarker = '[`*_]{0,2}';
  return value
    .replace(
      new RegExp(`\\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\\s+(?:an?\\s+)?${markdownMarker}(${dispositionAlternation})\\b${markdownMarker}`, 'gi'),
      (_match, disposition) => `not_${disposition.toLowerCase()}`,
    )
    .replace(
      new RegExp(`\\b(?:not|never)\\s+(?:(?:considered|deemed|treated\\s+as)\\s+)?(?:an?\\s+)?${markdownMarker}(${dispositionAlternation})\\b${markdownMarker}`, 'gi'),
      (_match, disposition) => `not_${disposition.toLowerCase()}`,
    )
    .replace(
      new RegExp(`(${dispositionAlternation})[^\\n。.!?]{0,12}(?:では(?:ない|ありません|ございません)|でない)`, 'gi'),
      (_match, disposition) => `not_${disposition.toLowerCase()}`,
    );
}

function maskUnrelatedDispositionValues(value) {
  const dispositionAlternation = DISPOSITION_VALUES.join('|');
  return value
    .replace(
      new RegExp(`\\b(?:${dispositionAlternation})\\b(?=(?:(?!\\b(?:${dispositionAlternation})\\b)[^\\n、,;；。.!?]){0,50}\\b(?:appl(?:y|ies)|belong(?:s)?|remain(?:s)?)?\\s*elsewhere\\b)`, 'gi'),
      (match) => ' '.repeat(match.length),
    )
    .replace(
      new RegExp(`(?:\\b(?:other|unrelated)\\s+findings?\\b|(?:他|別)の\\s*finding)[^\\n、,;；。.!?]{0,50}?\\b(?:${dispositionAlternation})\\b`, 'gi'),
      (match) => match.replace(
        new RegExp(`\\b(?:${dispositionAlternation})\\b`, 'gi'),
        (disposition) => ' '.repeat(disposition.length),
      ),
    )
    .replace(
      new RegExp(`\\b(?:${dispositionAlternation})\\b(?=[^\\n、,;；。.!?]{0,50}(?:(?:appl(?:y|ies)|belong(?:s)?)\\s+to\\s+(?:(?:the|all)\\s+)?(?:other|unrelated)\\s+findings?|(?:他|別)の\\s*finding[^\\n、,;；。.!?]{0,20}(?:適用|属)))`, 'gi'),
      (match) => ' '.repeat(match.length),
    );
}

function normalizeNarrativeDispositionValues(value) {
  return value.replace(/\bnon[-\s]actionable\b/gi, NON_ACTIONABLE_DISPOSITION);
}

function maskUnassignedDispositionValues(value) {
  const normalized = normalizeNarrativeDispositionValues(
    normalizeNegatedDispositionValues(value),
  );
  return normalized
    .split(new RegExp(`(${NARRATIVE_CLAUSE_BOUNDARY})`, 'gi'))
    .map((part) => maskUnrelatedDispositionValues(part))
    .join('');
}

function narrativeDispositionValues(lines) {
  const withoutNegatedValues = maskUnassignedDispositionValues(lines.join('\n'));
  const values = NARRATIVE_DISPOSITION_VALUES
    .filter((value) => hasMachineValue(withoutNegatedValues, value));
  return values.length > 1
    ? values.filter((value) =>
      value !== NON_ACTIONABLE_DISPOSITION && value !== 'not_actionable')
    : values;
}

function distanceBetween(left, right) {
  if (left.end <= right.start) return right.start - left.end;
  if (right.end <= left.start) return left.start - right.end;
  return 0;
}

function narrativeUnits(output) {
  const lines = output.split('\n');
  const units = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*\|.*\|\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading && FINDING_ID_VALUE.test(heading[2])) {
      const depth = heading[1].length;
      const block = [heading[2]];
      index += 1;
      while (index < lines.length) {
        const nextHeading = lines[index].match(/^\s*(#{1,6})\s+/);
        if (nextHeading && nextHeading[1].length <= depth) break;
        if (!/^\s*\|.*\|\s*$/.test(lines[index])) block.push(lines[index]);
        index += 1;
      }
      units.push(block.join('\n'));
      continue;
    }

    if (heading) {
      index += 1;
      continue;
    }

    const listItem = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/);
    if (listItem && FINDING_ID_VALUE.test(line)) {
      const rootIndent = listItem[1].length;
      const block = [line];
      index += 1;
      while (index < lines.length) {
        if (/^\s*#{1,6}\s+/.test(lines[index])) break;
        const nextListItem = lines[index].match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/);
        if (nextListItem && nextListItem[1].length <= rootIndent) break;
        if (!/^\s*\|.*\|\s*$/.test(lines[index])) block.push(lines[index]);
        index += 1;
      }
      units.push(block.join('\n'));
      continue;
    }

    const block = [line];
    index += 1;
    while (index < lines.length
      && lines[index].trim() !== ''
      && !/^\s*\|.*\|\s*$/.test(lines[index])
      && !/^\s*#{1,6}\s+/.test(lines[index])
      && !/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    units.push(block.join('\n'));
  }

  return units;
}

function dispositionAssignments(unit) {
  const maskedUnit = maskUnassignedDispositionValues(unit);
  const findings = [...maskedUnit.matchAll(FINDING_ID_TOKEN)].map((match) => ({
    id: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const dispositions = [...maskedUnit.matchAll(DISPOSITION_TOKEN)].map((match) => ({
    value: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (findings.length === 0 || dispositions.length === 0) return [];

  const hasOrderedPairing = /(?:\brespectively\b|それぞれ)/i.test(maskedUnit);
  if (hasOrderedPairing && findings.length === dispositions.length) {
    return findings.map((finding, index) => ({
      findingId: finding.id,
      disposition: dispositions[index].value,
    }));
  }

  if (!hasOrderedPairing) {
    const clauses = unit
      .split(new RegExp(NARRATIVE_CLAUSE_BOUNDARY, 'gi'))
      .map((clause, index) => ({ clause, index }));
    const pairedClauses = clauses.filter(({ clause }) => {
      const maskedClause = maskUnassignedDispositionValues(clause);
      return FINDING_ID_VALUE.test(maskedClause)
        && NARRATIVE_DISPOSITION_VALUES.some((value) => hasMachineValue(maskedClause, value));
    });
    const findingClauses = clauses.filter(({ clause }) =>
      FINDING_ID_VALUE.test(maskUnassignedDispositionValues(clause)));
    if (findingClauses.length > 0 && clauses.length > 1) {
      const assignments = pairedClauses.flatMap(({ clause }) => dispositionAssignments(clause));
      const anaphoricDisposition = new RegExp(
        `^(?:(?:and|or|but|however|または|および|ただし|しかし)\\s+)?(?:(?:Disposition\\s*[:：]\\s*)|(?:(?:the|its)\\s+disposition\\s+(?:is|remains|becomes)\\s+)|(?:it\\s+(?:is|remains)\\s+(?:also\\s+)?)|(?:(?:this|that|the|same)\\s+finding\\s+(?:is|remains|becomes)\\s+)|(?:(?:この|その|当該)\\s*finding\\s*(?:は|[:：])\\s*)|(?:裁定\\s*(?:は|[:：])\\s*))?(${NARRATIVE_DISPOSITION_VALUES.join('|')})(?:\\s*(?:です|である|となる))?$`,
        'i',
      );
      for (const { clause, index } of clauses) {
        const match = maskUnassignedDispositionValues(clause)
          .replace(/[`*'"]/g, '')
          .trim()
          .match(anaphoricDisposition);
        if (!match) continue;
        const precedingFindingClause = findingClauses
          .filter((candidate) => candidate.index < index)
          .at(-1);
        if (precedingFindingClause !== undefined) {
          const findingIds = [...maskUnassignedDispositionValues(precedingFindingClause.clause)
            .matchAll(FINDING_ID_TOKEN)]
            .map((finding) => finding[0]);
          assignments.push(...findingIds.map((findingId) => ({
            findingId,
            disposition: match[1].toLowerCase(),
          })));
        }
      }
      return assignments;
    }
  }

  if (findings.length === 1) {
    return dispositions.map(({ value }) => ({
      findingId: findings[0].id,
      disposition: value,
    }));
  }

  if (dispositions.length === 1) {
    return findings.map(({ id }) => ({
      findingId: id,
      disposition: dispositions[0].value,
    }));
  }

  return dispositions.flatMap((disposition) => {
    const nearestDistance = Math.min(
      ...findings.map((finding) => distanceBetween(disposition, finding)),
    );
    return findings
      .filter((finding) => distanceBetween(disposition, finding) === nearestDistance)
      .map(({ id }) => ({
        findingId: id,
        disposition: disposition.value,
      }));
  });
}

function dispositionValuesAssignedToFinding(output, findingId) {
  return narrativeUnits(output)
    .flatMap(dispositionAssignments)
    .filter((assignment) => assignment.findingId === findingId)
    .map(({ disposition }) => disposition);
}

function hasNoContradictoryDispositionOutsideTables(
  output,
  findingId,
  acceptsDisposition,
) {
  const localDispositionValues = dispositionValuesAssignedToFinding(output, findingId);

  return localDispositionValues
    .every(acceptsDisposition);
}

function isCompatibleWithDisposition(value, rowDisposition) {
  if (value === rowDisposition) return true;
  if (value === NON_ACTIONABLE_DISPOSITION || value === 'not_actionable') {
    return !ACTIONABLE_DISPOSITIONS.has(rowDisposition);
  }
  return value.startsWith('not_') && value !== `not_${rowDisposition}`;
}

function hasNoBasisOrTargetInNarrative(lines) {
  return lines.some((line) =>
    /(?:Authorization Basis|修正権限の根拠)[^\n。.!?]{0,80}(?:none|not applicable|n\/a|なし|該当なし)/i.test(line)
      && /(?:target\s+family|対象\s*family|統合先)[^\n。.!?]{0,80}(?:none|not applicable|n\/a|なし|該当なし)/i.test(line));
}

function hasExactNonActionableFindingDisposition(output, findingId, expectedDispositions) {
  const titledDispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
  const dispositionSection = titledDispositionSection || findDispositionTableSection(output);
  const dispositionTable = parseTable(dispositionSection);
  const rows = dispositionRowsForFinding(dispositionTable, findingId);

  if (rows.length === 1) {
    const row = rows[0];
    const rowDisposition = dispositionOf(row).toLowerCase();
    return expectedDispositions.includes(rowDisposition)
      && hasNoContradictoryDispositionOutsideTables(
        output,
        findingId,
        (value) => isCompatibleWithDisposition(value, rowDisposition),
      )
      && hasNoExplicitTarget(dispositionTable, row)
      && /^(?:none|not applicable|n\/a|なし|該当なし|-|—)$/i.test(
        authorizationBasisOf(dispositionTable, row),
      );
  }

  const lines = findingLineContexts(output, findingId);
  const values = narrativeDispositionValues(lines);
  return lines.length === 1
    && values.length === 1
    && expectedDispositions.includes(values[0])
    && hasNoBasisOrTargetInNarrative(lines);
}

export function assertReviewAdjudicationPhase1(output) {
  const contexts = Object.fromEntries(
    Object.entries(FINDINGS).map(([name, findingId]) => [name, findingLineContexts(output, findingId)]),
  );
  const contextText = Object.fromEntries(
    Object.entries(contexts).map(([name, lines]) => [name, lines.join('\n')]),
  );
  const codeActionableDirect = hasExactFindingDisposition(
    output,
    FINDINGS.code,
    /actionable/i,
    EXPECTED_INITIAL_AUTHORIZATION_BASIS,
  );
  const codeDuplicateDirect = hasExactFindingDisposition(
    output,
    FINDINGS.code,
    /duplicate/i,
    EXPECTED_INITIAL_AUTHORIZATION_BASIS,
  );
  const architectureActionableDirect = hasExactFindingDisposition(
    output,
    FINDINGS.architecture,
    /actionable/i,
    EXPECTED_INITIAL_AUTHORIZATION_BASIS,
  );
  const architectureDuplicateDirect = hasExactFindingDisposition(
    output,
    FINDINGS.architecture,
    /duplicate/i,
    EXPECTED_INITIAL_AUTHORIZATION_BASIS,
  );
  const checks = [
    ['actionable-result', hasActionableResult(output)],
    ['all-findings-addressed', Object.values(contexts).every((lines) => lines.length > 0)],
    ['initial-pair-direct-bases', (codeActionableDirect || codeDuplicateDirect)
      && (architectureActionableDirect || architectureDuplicateDirect)],
    ['initial-pair-one-actionable-one-duplicate', (codeActionableDirect && architectureDuplicateDirect)
      || (codeDuplicateDirect && architectureActionableDirect)],
    ['remediation-regression', hasExactFindingDisposition(
      output,
      FINDINGS.remediation,
      /(?:actionable|duplicate)/i,
      'remediation_regression',
      /(?:created|introduced|did not exist|新設|導入|追加|作成|存在しなかった)/i,
    )],
    ['type-error-overreach', hasExactNonActionableFindingDisposition(
      output,
      FINDINGS.typeError,
      ['overreach'],
    )],
    ['horizontal-out-of-scope', hasExactNonActionableFindingDisposition(
      output,
      FINDINGS.horizontal,
      ['out_of_scope'],
    )],
    ['testing-non-actionable', hasExactNonActionableFindingDisposition(
      output,
      FINDINGS.testing,
      ['overreach', 'out_of_scope'],
    )],
    ['security-disproved', hasExactNonActionableFindingDisposition(
      output,
      FINDINGS.security,
      ['false_positive', 'no_issue_after_verification'],
    )],
    ['environment-not-promoted', hasExactNonActionableFindingDisposition(
      output,
      FINDINGS.antipattern,
      ['environment_unverified', 'overreach', 'out_of_scope'],
    )],
    ['same-family-with-distinct-bases', /FAM-channel-normalization/i.test(output)
      && hasMachineValue(contextText.code, EXPECTED_INITIAL_AUTHORIZATION_BASIS)
      && hasMachineValue(contextText.architecture, EXPECTED_INITIAL_AUTHORIZATION_BASIS)
      && hasMachineValue(contextText.remediation, 'remediation_regression')],
    ['excessive-mechanism-not-promoted', !MECHANISM.test(output) || MECHANISM_REJECTION.test(output)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'Phase 1 preserves adjudication semantics without requiring the Phase 2 report shape'
      : `failed: ${failed.join(', ')}`,
  };
}
