const NON_ACTIONABLE_FINDING = 'OLD-REVIEW-readme-L1';

function extractSection(output, headings) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => headings.some((heading) => heading.test(line.trim())));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

export default function assertFinalReadinessPrecision(output) {
  const actionable = extractSection(output, [
    /^##\s+修正対象\s*family$/i,
    /^##\s+Actionable Families$/i,
  ]);
  const priorFindings = extractSection(output, [
    /^##\s+前段\s*finding\s*の扱い$/i,
    /^##\s+Prior Finding Dispositions$/i,
  ]);
  const checks = [
    ['mergeable', /(結果:\s*マージ可能|Result:\s*MERGEABLE)/i.test(output)],
    ['no-actionable-family', actionable.trim().length === 0
      || !/(FINAL-(?:NEW|PERSIST)-[^\s|]+)/i.test(actionable)],
    ['non-actionable-preserved', priorFindings.includes(NON_ACTIONABLE_FINDING)
      && /(adjudicated_non_actionable|非修正対象)/i.test(priorFindings)],
    ['not-rejected', !/(結果:\s*(修正が必要|タスク全体の再計画が必要|実行環境により判定不能)|Result:\s*(FIX REQUIRED|TASK REPLAN REQUIRED|BLOCKED BY ENVIRONMENT))/i.test(output)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the final supervisor accepts the complete change without reopening adjudicated noise'
      : `failed: ${failed.join(', ')}`,
  };
}
