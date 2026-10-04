const REPORT_PRIORITY = [
  'supervisor-summary.md',
  'summary.md',
  'review-decision.md',
];

function priority(filename) {
  const index = REPORT_PRIORITY.indexOf(filename);
  return index === -1 ? REPORT_PRIORITY.length : index;
}

export function summarizeRunReports(reports) {
  const primary = [...reports].sort((left, right) => (
    priority(left.filename) - priority(right.filename)
  ))[0];
  if (!primary) return null;
  return parseKnownHeadings(primary.content);
}

function parseKnownHeadings(content) {
  const requirements = content.match(/## Requirement Summary\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  const findings = content.match(/## Open Findings\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  return {
    requirements: requirements.split('\n').filter(Boolean),
    unresolvedFindingCount: findings.split('\n').filter(Boolean).length,
  };
}
