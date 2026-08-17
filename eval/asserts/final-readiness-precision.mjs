import { hasFinalDecision } from './final-readiness-decision.mjs';

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

function hasNearbyReopening(output, anchor) {
  const lines = output.split(/\r?\n/);
  return lines.some((line, index) => line.includes(anchor)
    && /(?:remains?\s+open|requires?\s+(?:a\s+)?fix|(?:is|remains?|becomes?)\s+actionable|再開(?:する|が必要)|修正(?:が)?必要)/i
      .test([lines[index - 1], line, lines[index + 1]].filter(Boolean).join(' ')));
}

export default function assertFinalReadinessPrecision(output) {
  const checks = [
    ['approve', hasFinalDecision(output, 'APPROVE')],
    ['no-actionable-family', !/(FINAL-(?:NEW|PERSIST)-[^\s|]+)/i.test(output)],
    ['non-actionable-preserved', hasNearbyEvidence(
      output,
      NON_ACTIONABLE_FINDING,
      /(false_positive|overreach|out_of_scope|no_issue_after_verification|environment_unverified|非修正対象(?:として)?(?:維持|扱)|非\s*actionable\s*(?:です|である|であり|で(?=[、。\s]|$)|として(?:維持|扱))|actionable\s+findings?\s*(?:は|が)?\s*(?:ありません|ない|なし)|再開[^。\n]*(?:しない|せず|ない|なし)|(?:not|without)\s+reopen|(?:is|remains?)\s+non-actionable)/i,
    )],
    ['old-finding-not-reopened', !hasNearbyReopening(output, NON_ACTIONABLE_FINDING)],
    ['not-rejected', !hasFinalDecision(output, 'REJECT') && !hasFinalDecision(output, 'BLOCKED')],
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
