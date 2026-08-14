const NON_ACTIONABLE_FINDING = 'OLD-REVIEW-readme-L1';

function hasNearbyEvidence(output, anchor, evidence) {
  let index = output.indexOf(anchor);
  while (index >= 0) {
    const context = output.slice(Math.max(0, index - 300), index + anchor.length + 700);
    if (evidence.test(context)) return true;
    index = output.indexOf(anchor, index + anchor.length);
  }
  return false;
}

export default function assertFinalReadinessPrecision(output) {
  const checks = [
    ['mergeable', /(?:結果|最終裁定)\s*[:：]\s*マージ可能|(?:Result|Final Decision)\s*:\s*MERGEABLE/i.test(output)],
    ['no-actionable-family', !/(FINAL-(?:NEW|PERSIST)-[^\s|]+)/i.test(output)],
    ['non-actionable-preserved', hasNearbyEvidence(
      output,
      NON_ACTIONABLE_FINDING,
      /(adjudicated_non_actionable|非修正対象(?:として)?(?:維持|扱)|再開[^。\n]*(?:しない|せず|ない|なし)|(?:not|without)\s+reopen|remains?\s+non-actionable)/i,
    )],
    ['not-rejected', !/(?:(?:結果|最終裁定)\s*[:：]\s*(修正が必要|タスク全体の再計画が必要|実行環境により判定不能)|(?:Result|Final Decision)\s*:\s*(FIX REQUIRED|TASK REPLAN REQUIRED|BLOCKED BY ENVIRONMENT))/i.test(output)],
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
