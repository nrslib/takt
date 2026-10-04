import { hasFinalDecision, unwrapProviderOutput } from './final-readiness-decision.mjs';

const PROJECT_CONFIGURATION_PATTERN = /(?:project\s*(?:configuration|config|設定)|プロジェクト設定)/i;
const PROJECT_SOURCE_PATTERN = /(?:\bsource\b|出所|由来)/i;
const PROJECT_SOURCE_GAP_PATTERNS = [
  /\b(?:missing|absent)\s+(?:the\s+)?(?:required\s+)?source(?:\s+field)?\b/i,
  /\b(?:lacks?|does not (?:include|contain|provide|return)|fails? to (?:include|contain|provide|return))\s+(?:the\s+)?(?:required\s+)?source(?:\s+field)?\b/i,
  /\bsource(?:\s+field)?\s+(?:is\s+)?(?:missing|absent|not present|not provided|not returned|not recorded)\b/i,
  /(?:source|出所|由来)(?:フィールド|値)?\s*(?:が|は)?\s*(?:不足|欠落|存在しない|含まれていない|返されていない|提供されていない|記録されていない)/i,
  /(?:source|出所|由来)(?:フィールド|値)?\s*を\s*(?:含まない|含んでいない|返していない|提供していない|記録していない)/i,
  /(?:source|出所|由来)(?:フィールド|値)?\s*(?:が|は)?\s*(?:未実装|実装されていない)/i,
  /(?:source|出所|由来).{0,80}(?:未実装|実装されていない|返していない|含んでいない)/i,
  /(?:source|出所|由来).{0,160}(?:含まない|含んでいない|返さない|返していない|不足|欠落)/i,
  /\|\s*\*{0,2}(?:unmet|unfulfilled|not (?:fulfilled|satisfied)|未充足)\*{0,2}\s*\|/i,
  /(?:\bsource\b|出所|由来).{0,240}\*{0,2}(?:unmet|unfulfilled|not (?:fulfilled|satisfied)|未充足)\*{0,2}/i,
];
const MACHINE_GATE_RECORD_PATTERN = /(?:\b(?:test|build|execution|quality[- ]?gate|mock e2e)\b.{0,40}\b(?:evidence|logs?|results?|records?)\b|(?:テスト|ビルド|実行|品質ゲート).{0,40}(?:証跡|ログ|結果|記録))/i;
const MACHINE_GATE_RECORD_GAP_PATTERN = /(?:\b(?:missing|absent|lack(?:s|ing)?|required|needed|must|should|not (?:present|provided|recorded|available))\b|(?:不足|欠落|存在しない|提供されていない|記録されていない|必要|要求))/i;
const MACHINE_GATE_RECORD_NOT_REQUIRED_PATTERN = /(?:\b(?:not|no longer)\s+(?:required|needed)\b|\bdo(?:es)?\s+not\s+(?:require|need)\b|(?:不要|必要(?:は|が)?ない|要求(?:・審査)?しない|なくてよい)|審査対象外|(?:根拠|理由|審査対象)(?:に)?(?:も)?(?:しない|していない|ではない|としない))/i;

function hasMachineGateRecordRequirement(output) {
  return output
    .split(/\r?\n|[.!?。！？](?:\s+|$)/u)
    .some((context) => MACHINE_GATE_RECORD_PATTERN.test(context)
      && MACHINE_GATE_RECORD_GAP_PATTERN.test(context)
      && !MACHINE_GATE_RECORD_NOT_REQUIRED_PATTERN.test(context));
}

function hasProjectSourceGap(output) {
  if (!PROJECT_CONFIGURATION_PATTERN.test(output)) return false;
  const explicitSourceContrast = /source\s*:\s*['"]project['"]/i.test(output)
    && /現在(?:は|の).{0,80}(?:mode|値).{0,30}(?:だけ|のみ)(?:を)?返/i.test(output);
  return explicitSourceContrast || output.split(/\r?\n/u).some((context) => PROJECT_SOURCE_PATTERN.test(context)
    && PROJECT_SOURCE_GAP_PATTERNS.some((pattern) => pattern.test(context))
    && !hasMachineGateRecordRequirement(context));
}

export default function assertFinalReadinessRequirementGap(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const checks = [
    ['reject', hasFinalDecision(reviewOutput, 'REJECT')],
    ['project-source-gap', hasProjectSourceGap(reviewOutput)],
    ['no-machine-gate-record-review', !hasMachineGateRecordRequirement(reviewOutput)],
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
