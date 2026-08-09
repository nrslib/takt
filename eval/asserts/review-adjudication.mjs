const FINDINGS = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
  testing: 'TEST-NEW-readme-examples-L1',
  security: 'SEC-NEW-secret-leak-L3',
  antipattern: 'AI-NEW-windows-proof-L1',
};

const ACTIONABLE_HEADING = /^#{2,3}\s+(?:修正対象\s*family|Actionable Families)$/i;
const DISPOSITION_HEADING = /^#{2,3}\s+(?:指摘|finding).*?(?:裁定|dispositions?)$/i;
const MECHANISM = /(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)/i;
const MECHANISM_REJECTION = /(?:含めない|不要|根拠がない|必要(?:性)?[^\n。.!?]*(?:ない|なく)|not (?:included|required|promoted)|no (?:evidence|requirement))/i;
const MECHANISM_REQUIREMENT = /(?:(?:implement|add|use|introduce|enforce|create|construct|require|make|build|adopt|provide|ensure|establish|wrap|surround|enclose)\b[^\n。.!?]{0,80}(?:atomic|transaction|rollback)|(?:atomic|transaction|rollback|アトミック|トランザクション|ロールバック)[^\n。.!?]{0,80}(?:\b(?:is required|must|should|needs? to be)\b|(?:を|が)(?:実装|追加|使用|導入|使う|作る|構築|必須|必要)))/i;
const CONTRASTED_REQUIREMENT = /(?:\b(?:but|however|yet)\b|ただし|一方|ものの|にもかかわらず)/i;

function extractSection(output, startPattern, endPattern) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => startPattern.test(line.trim()));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => endPattern.test(line.trim()));
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

function rowForFinding(rows, findingId) {
  return rows.filter((cells) => cells.some((cell) => cell.includes(findingId)));
}

function dispositionOf(row) {
  return row.find((cell) => /^(actionable|duplicate|false_positive|overreach|out_of_scope|no_issue_after_verification|environment_unverified)$/i.test(cell)) ?? '';
}

function familyRefs(value) {
  return [...value.matchAll(/\b(?:FAM(?:ILY)?-[A-Za-z0-9-]+|F-\d+[A-Za-z0-9-]*)\b/g)]
    .map((match) => match[0].toLowerCase());
}

function targetOf(table, row) {
  const targetIndex = table.header.findIndex((cell) =>
    /(?:target|family|統合先)/i.test(cell) && !/(?:finding|出典)/i.test(cell));
  if (targetIndex < 0) return '';

  const header = table.header[targetIndex] ?? '';
  const cell = row[targetIndex] ?? '';
  if (/^(?:none|なし|-|—)$/i.test(cell)) return '';

  const explicitFamily = familyRefs(cell)[0];
  if (explicitFamily) return explicitFamily;
  if (/(?:根拠|evidence|rationale)/i.test(header)) {
    const isShortTarget = !/[。.!?;；]/u.test(cell) && cell.trim().split(/\s+/u).length <= 4;
    return isShortTarget ? cell.trim().toLowerCase() : null;
  }

  return cell.trim().toLowerCase();
}

function sameActionableFamily(actionableSection, dispositionTable, codeRow, architectureRow) {
  const codeTarget = targetOf(dispositionTable, codeRow);
  const architectureTarget = targetOf(dispositionTable, architectureRow);
  if (typeof codeTarget === 'string'
    && typeof architectureTarget === 'string'
    && codeTarget.length > 0
    && codeTarget === architectureTarget) return true;

  const actionableTable = parseTable(actionableSection);
  if (actionableTable.rows.some((row) =>
    row.some((cell) => cell.includes(FINDINGS.code))
    && row.some((cell) => cell.includes(FINDINGS.architecture)))) {
    return true;
  }

  if (!/^###\s+/m.test(actionableSection)) return false;

  return actionableSection.split(/(?=^###\s+)/m).some((block) =>
    block.includes(FINDINGS.code) && block.includes(FINDINGS.architecture));
}

function acceptanceContexts(actionableSection) {
  const contexts = [];
  const lines = actionableSection.split('\n');
  const start = lines.findIndex((line) => /^(?:-\s*)?(?:受入条件|Acceptance criteria)\s*:?$/i.test(line.trim()));
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
  return contexts.length > 0 && contexts.every((context) =>
    context.split(/\n|[;；]|(?<=[。.!?])\s+/u)
      .filter((unit) => MECHANISM.test(unit))
      .every((unit) => MECHANISM_REJECTION.test(unit)
        && !MECHANISM_REQUIREMENT.test(unit)
        && !CONTRASTED_REQUIREMENT.test(unit)));
}

function hasNoExplicitTarget(table, row) {
  const target = targetOf(table, row);
  return target === '' || target === null;
}

export default function assertReviewAdjudication(output) {
  const actionableSection = extractSection(output, ACTIONABLE_HEADING, DISPOSITION_HEADING);
  const dispositionSection = extractSection(output, DISPOSITION_HEADING, /^#{2,3}\s+/);
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

  const checks = [
    ['actionable-result', /(結果:\s*修正対象あり|Result:\s*ACTIONABLE FINDINGS|(?:修正対象は\s*[1-9]\d*|[1-9]\d*つの修正対象)\s*family)/i.test(output)],
    ['one-disposition-per-finding', [codeRows, architectureRows, testingRows, securityRows, antipatternRows]
      .every((rows) => rows.length === 1)],
    ['code-actionable', /^actionable$/i.test(dispositionOf(codeRow))],
    ['architecture-duplicate', /^duplicate$/i.test(dispositionOf(architectureRow))],
    ['same-actionable-family', sameActionableFamily(actionableSection, dispositionTable, codeRow, architectureRow)],
    ['non-actionable-excluded-from-family', nonActionableIds.every((id) => !actionableSection.includes(id))],
    ['suggested-mechanism-not-promoted', doesNotPromoteMechanism(acceptanceContexts(actionableSection))],
    ['testing-overreach', /^(overreach|out_of_scope)$/i.test(dispositionOf(testingRow))
      && hasNoExplicitTarget(dispositionTable, testingRow)],
    ['security-false-positive', /^(false_positive|no_issue_after_verification)$/i.test(dispositionOf(securityRow))
      && hasNoExplicitTarget(dispositionTable, securityRow)],
    ['antipattern-out-of-scope', /^(overreach|out_of_scope)$/i.test(dispositionOf(antipatternRow))
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
