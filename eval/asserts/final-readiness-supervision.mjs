const OLD_NON_ACTIONABLE_FINDING = 'OLD-REVIEW-readme-L1';

function extractSection(output, headings) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => headings.some((heading) => heading.test(line.trim())));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

export default function assertFinalReadinessSupervision(output) {
  const actionable = extractSection(output, [
    /^##\s+修正対象\s*family$/i,
    /^##\s+Actionable Families$/i,
  ]);
  const priorFindings = extractSection(output, [
    /^##\s+前段\s*finding\s*の扱い$/i,
    /^##\s+Prior Finding Dispositions$/i,
  ]);
  const checks = [
    ['fix-required', /(結果:\s*修正が必要|Result:\s*FIX REQUIRED)/i.test(output)],
    ['configuration-entry-gap', /(config|configuration|設定)/i.test(actionable)
      && /(normalize|normalization|正規化)/i.test(actionable)],
    ['actionable-finding-id', /(FINAL-(?:NEW|PERSIST)-[^\s|]+)/i.test(actionable)],
    ['old-finding-not-reopened', !actionable.includes(OLD_NON_ACTIONABLE_FINDING)
      && priorFindings.includes(OLD_NON_ACTIONABLE_FINDING)
      && /(adjudicated_non_actionable|非修正対象)/i.test(priorFindings)],
    ['not-replan-or-blocked', !/(結果:\s*(タスク全体の再計画が必要|実行環境により判定不能)|Result:\s*(TASK REPLAN REQUIRED|BLOCKED BY ENVIRONMENT))/i.test(output)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the final supervisor identifies the merge blocker without reopening adjudicated noise'
      : `failed: ${failed.join(', ')}`,
  };
}
