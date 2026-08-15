function unwrapProviderOutput(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.output === 'string') {
      return parsed.output;
    }
  } catch {
    return output;
  }
  return output;
}

const FINAL_DECISION_HEADING = /(?:^|\n)\s*#{1,6}\s*(?:Result|Final Decision|結果|最終判定)\s*[:：]\s*(APPROVE|REJECT|BLOCKED)\b/gim;
const PROJECT_CONFIGURATION_PATTERN = /(?:project\s*(?:configuration|config|設定)|プロジェクト設定)/i;
const PROJECT_SOURCE_PATTERN = /(?:\bsource\b|出所|由来)/i;
const PROJECT_SOURCE_GAP_PATTERNS = [
  /\b(?:missing|absent)\s+(?:the\s+)?(?:required\s+)?source(?:\s+field)?\b/i,
  /\b(?:lacks?|does not (?:include|contain|provide|return)|fails? to (?:include|contain|provide|return))\s+(?:the\s+)?(?:required\s+)?source(?:\s+field)?\b/i,
  /\bsource(?:\s+field)?\s+(?:is\s+)?(?:missing|absent|not present|not provided|not returned|not recorded)\b/i,
  /(?:source|出所|由来)(?:フィールド|値)?\s*(?:が|は)?\s*(?:不足|欠落|存在しない|含まれていない|返されていない|提供されていない|記録されていない)/i,
  /(?:source|出所|由来)(?:フィールド|値)?\s*を\s*(?:含んでいない|返していない|提供していない|記録していない)/i,
  /\|\s*\*{0,2}(?:unmet|unfulfilled|not (?:fulfilled|satisfied)|未充足)\*{0,2}\s*\|/i,
];
const MACHINE_GATE_RECORD_PATTERN = /(?:\b(?:test|build|execution|quality[- ]?gate|mock e2e)\b.{0,40}\b(?:evidence|logs?|results?|records?)\b|(?:テスト|ビルド|実行|品質ゲート).{0,40}(?:証跡|ログ|結果|記録))/i;

function hasProjectSourceGap(output) {
  return output
    .split(/\r?\n|[.!?。！？](?:\s+|$)/u)
    .some((context) => PROJECT_CONFIGURATION_PATTERN.test(context)
      && PROJECT_SOURCE_PATTERN.test(context)
      && PROJECT_SOURCE_GAP_PATTERNS.some((pattern) => pattern.test(context))
      && !MACHINE_GATE_RECORD_PATTERN.test(context));
}

function hasFinalDecision(output, decision) {
  return [...output.matchAll(FINAL_DECISION_HEADING)]
    .some((match) => match[1].toUpperCase() === decision);
}

export default function assertFinalReadinessRequirementGap(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const checks = [
    ['reject', hasFinalDecision(reviewOutput, 'REJECT')],
    ['project-source-gap', hasProjectSourceGap(reviewOutput)],
    ['no-machine-gate-record-review', !MACHINE_GATE_RECORD_PATTERN.test(reviewOutput)],
    ['not-approved', !hasFinalDecision(reviewOutput, 'APPROVE')],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the final supervisor rejects the unmet project-configuration acceptance criterion'
      : `failed: ${failed.join(', ')}`,
  };
}
