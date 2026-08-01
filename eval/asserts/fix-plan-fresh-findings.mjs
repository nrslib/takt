const TARGET_FINDING = 'MERGE-NEW-cache-key-L2';
const OLD_NON_ACTIONABLE_FINDING = 'OLD-REVIEW-readme-L1';

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

export default function assertFixPlanFreshFindings(output) {
  const coverageRows = parseTable(extractSection(output, [
    /^##\s+指摘カバレッジ$/i,
    /^##\s+Finding Coverage$/i,
  ]));
  const executionRows = parseTable(extractSection(output, [
    /^##\s+実施順序$/i,
    /^##\s+Execution Order$/i,
  ]));
  const targetRows = coverageRows.filter((cells) => cells[0]?.includes(TARGET_FINDING));
  const targetRow = targetRows[0] ?? [];
  const fixUnit = targetRow[2] ?? '';
  const matchingExecutionRows = executionRows.filter((cells) =>
    fixUnit.length > 0 && cells[1]?.toLowerCase() === fixUnit.toLowerCase());
  const executionRow = matchingExecutionRows[0] ?? [];

  const checks = [
    ['one-target-coverage-row', targetRows.length === 1],
    ['source-evidence', /src\/cache\.js(?::\d+)?/i.test(targetRow[1] ?? '')],
    ['causal-chain', /(get|lookup|read)/i.test(targetRow[3] ?? '')
      && /(raw|bypass|normalize|normalization|正規化)/i.test(targetRow[3] ?? '')],
    ['acceptance-criteria', /(retriev|read|取得)/i.test(targetRow[5] ?? '')
      && /(case|whitespace|equivalent|大文字|小文字|空白)/i.test(targetRow[5] ?? '')],
    ['one-execution-for-fix-unit', matchingExecutionRows.length === 1],
    ['implementation-target', /src\/cache\.js(?::\d+)?/i.test(executionRow[4] ?? '')
      && /(boundary|consumer|lookup|read|local fix|境界|利用側|局所修正)/i.test(executionRow[2] ?? '')],
    ['execution-completion', /(get|lookup|read|取得)/i.test(executionRow[5] ?? '')
      && /(case|whitespace|equivalent|大文字|小文字|空白)/i.test(executionRow[5] ?? '')],
    ['old-non-actionable-excluded', coverageRows.every((cells) => !cells.some((cell) => cell.includes(OLD_NON_ACTIONABLE_FINDING)))
      && executionRows.every((cells) => !cells.some((cell) => cell.includes(OLD_NON_ACTIONABLE_FINDING)))],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the plan derives one executable cache-lookup fix from the canonical remediation target'
      : `failed: ${failed.join(', ')}`,
  };
}
