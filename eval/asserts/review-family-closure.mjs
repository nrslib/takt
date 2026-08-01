/**
 * Behavioral assertion for reviewer problem-family closure.
 * It checks that one review reports every seeded path affected by the same
 * attribution contract instead of stopping at the first representative bug.
 */

const REQUIRED_PATHS = [
  'src/runtime-state.js',
  'src/batch.js',
  'src/parallel.js',
  'src/relay.js',
  'src/resume.js',
  'src/analytics.js',
  'tests/reporting.test.js',
];

function hasRejectVerdict(output) {
  const firstContentLine = output
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.replace(/^#+\s*/, '')
    .trim()
    .toUpperCase();
  if (firstContentLine === 'REJECT') return true;

  const labeled = [...output.matchAll(/(?:結果|判定|Result|Verdict)[^\w\n]{0,12}(\w+)/gi)]
    .map((match) => match[1]?.toUpperCase());
  const headings = [...output.matchAll(/^#+\s*(\w+)/gm)]
    .map((match) => match[1]?.toUpperCase());
  return [...labeled, ...headings].includes('REJECT');
}

function extractSection(output, headingPattern) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join('\n');
}

function extractIssueBearingEvidence(output) {
  const findings = extractSection(
    output,
    /^##\s+(?:今回の指摘|観測した指摘|Current Iteration Findings|New Findings|Observed Findings)/i,
  );
  const familySweep = extractSection(
    output,
    /^##\s+(?:問題系列の完了走査|Problem-Family Completion Sweep)/i,
  )
    .split('\n')
    .filter((line) => /(?:finding|指摘|reject|F-\d|NEW-)/i.test(line))
    .join('\n');
  return `${familySweep}\n${findings}`;
}

export default function assertReviewFamilyClosure(output) {
  const issueEvidence = extractIssueBearingEvidence(output);
  const missingPaths = REQUIRED_PATHS.filter((path) => !issueEvidence.includes(path));
  const checks = [
    ['reject-verdict', hasRejectVerdict(output)],
    ['all-family-paths-are-findings', missingPaths.length === 0],
    ['family-classification', /family[_ -]?tag/i.test(issueEvidence)],
    ['root-contract', /(attribution|実行コンテキスト).*(不変条件|契約|root cause|根本原因)/is.test(issueEvidence)
      || /(不変条件|契約|root cause|根本原因).*(attribution|実行コンテキスト)/is.test(issueEvidence)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  const details = missingPaths.length > 0 ? `; missing paths: ${missingPaths.join(', ')}` : '';

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the review closes the complete attribution problem family'
      : `failed: ${failed.join(', ')}${details}`,
  };
}
