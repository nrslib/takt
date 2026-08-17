import { hasFinalDecision } from './final-readiness-decision.mjs';

const NOT_CODE_REMEDIABLE_PATTERNS = [
  /task[- ]scope code changes? (?:cannot|must not)/i,
  /cannot be (?:obtained|provided|resolved) (?:by|through) code/i,
  /コード(?:変更|修正)(?:では|で)(?:取得|提供|解消|代替)できない/i,
  /コード修正対象(?:では)?(?:ない|ありません)/i,
  /コード変更(?:は|が)?不要/i,
  /コード(?:から|で).{0,60}(?:できない|要求範囲外)/i,
];
const CODE_REMEDIATION_REQUIRED_PATTERN = /(?:(?:code|implementation) changes? (?:are|is) required|コード(?:修正|変更)(?:が|は)必要)/i;

function identifiesNonCodeRemediableDecision(output) {
  return NOT_CODE_REMEDIABLE_PATTERNS.some((pattern) => pattern.test(output));
}

export default function assertFinalReadinessExternalDecision(output) {
  const checks = [
    ['blocked', hasFinalDecision(output, 'BLOCKED')],
    ['not-approved-or-rejected', !hasFinalDecision(output, 'APPROVE') && !hasFinalDecision(output, 'REJECT')],
    ['external-decision-identified', /(?:Product Council|external (?:approval|decision|system)|外部(?:の)?(?:承認|判断|システム))/i.test(output)],
    ['not-code-remediable', identifiesNonCodeRemediableDecision(output)],
    ['no-code-remediation-required', !CODE_REMEDIATION_REQUIRED_PATTERN.test(output)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the final supervisor preserves undecidability and selects BLOCKED for the external decision'
      : `failed: ${failed.join(', ')}`,
  };
}
