const FINDINGS = {
  code: 'CODE-NEW-channel-normalization-L2',
  architecture: 'ARCH-NEW-channel-normalization-L2',
  testing: 'TEST-NEW-readme-examples-L1',
  security: 'SEC-NEW-secret-leak-L3',
  antipattern: 'AI-NEW-windows-proof-L1',
};

function extractSection(output, headings) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => headings.some((heading) => heading.test(line.trim())));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function parseTable(section) {
  return section.split('\n')
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim().replaceAll('`', '')))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
    .slice(1);
}

function rowsForFinding(rows, findingId) {
  return rows.filter((cells) => cells[0]?.includes(findingId));
}

function isNone(value) {
  return /^(none|なし|-|—)$/i.test(value.trim());
}

export default function assertReviewAdjudication(output) {
  const actionableRows = parseTable(extractSection(output, [
    /^##\s+修正対象\s*family$/i,
    /^##\s+Actionable Families$/i,
  ]));
  const dispositionRows = parseTable(extractSection(output, [
    /^##\s+指摘ごとの裁定$/i,
    /^##\s+Finding Dispositions$/i,
  ]));

  const codeRows = rowsForFinding(dispositionRows, FINDINGS.code);
  const architectureRows = rowsForFinding(dispositionRows, FINDINGS.architecture);
  const testingRows = rowsForFinding(dispositionRows, FINDINGS.testing);
  const securityRows = rowsForFinding(dispositionRows, FINDINGS.security);
  const antipatternRows = rowsForFinding(dispositionRows, FINDINGS.antipattern);
  const codeRow = codeRows[0] ?? [];
  const architectureRow = architectureRows[0] ?? [];
  const testingRow = testingRows[0] ?? [];
  const securityRow = securityRows[0] ?? [];
  const antipatternRow = antipatternRows[0] ?? [];
  const codeTarget = codeRow[2] ?? '';
  const architectureTarget = architectureRow[2] ?? '';
  const targetFamilyRows = actionableRows.filter((cells) =>
    cells[0]?.toLowerCase() === codeTarget.toLowerCase()
    && cells[1]?.includes(FINDINGS.code)
    && cells[1]?.includes(FINDINGS.architecture));
  const codeFamilyRows = actionableRows.filter((cells) =>
    cells[1]?.includes(FINDINGS.code));
  const architectureFamilyRows = actionableRows.filter((cells) =>
    cells[1]?.includes(FINDINGS.architecture));

  const checks = [
    ['actionable-result', /(結果:\s*修正対象あり|Result:\s*ACTIONABLE FINDINGS)/i.test(output)],
    ['one-disposition-per-finding', [codeRows, architectureRows, testingRows, securityRows, antipatternRows]
      .every((rows) => rows.length === 1)],
    ['code-actionable-family', /^actionable$/i.test(codeRow[1] ?? '')
      && !isNone(codeTarget)
      && targetFamilyRows.length === 1],
    ['architecture-duplicate-family', /^duplicate$/i.test(architectureRow[1] ?? '')
      && architectureTarget.toLowerCase() === codeTarget.toLowerCase()
      && targetFamilyRows.length === 1],
    ['actionable-id-family-uniqueness', codeFamilyRows.length === 1
      && architectureFamilyRows.length === 1
      && codeFamilyRows[0] === targetFamilyRows[0]
      && architectureFamilyRows[0] === targetFamilyRows[0]],
    ['testing-overreach', /^(overreach|out_of_scope)$/i.test(testingRow[1] ?? '')
      && isNone(testingRow[2] ?? '')],
    ['security-false-positive', /^(false_positive|no_issue_after_verification)$/i.test(securityRow[1] ?? '')
      && isNone(securityRow[2] ?? '')],
    ['antipattern-out-of-scope', /^(overreach|out_of_scope)$/i.test(antipatternRow[1] ?? '')
      && isNone(antipatternRow[2] ?? '')],
    ['non-actionable-not-in-family', [FINDINGS.testing, FINDINGS.security, FINDINGS.antipattern]
      .every((findingId) => actionableRows.every((cells) => !cells.some((cell) => cell.includes(findingId))))],
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
