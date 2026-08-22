import { hasFinalDecision } from './final-readiness-decision.mjs';

const EXCLUDED_FINDING = 'OLD-REVIEW-readme-L1';

function hasNearbyEvidence(output, anchor, evidence) {
  let index = output.indexOf(anchor);
  while (index >= 0) {
    const context = output.slice(Math.max(0, index - 300), index + anchor.length + 700);
    if (evidence.test(context)) return true;
    index = output.indexOf(anchor, index + anchor.length);
  }
  return false;
}

function hasNearbyRepairRequirement(output, anchor) {
  const lines = output.split(/\r?\n/);
  return lines.some((line, index) => line.includes(anchor)
    && /(?:remains?\s+open|requires?\s+(?:a\s+)?fix|selected\s+for\s+repair|再開(?:する|が必要)|修正(?:が)?必要|修正対象(?:にする|とする))/i
      .test([lines[index - 1], line, lines[index + 1]].filter(Boolean).join(' ')));
}

export default function assertFinalReadinessPrecision(output) {
  const checks = [
    ['approve', hasFinalDecision(output, 'APPROVE')],
    ['no-new-repair-problem', !/(FINAL-(?:NEW|PERSIST)-[^\s|]+)/i.test(output)],
    ['excluded-finding-preserved', hasNearbyEvidence(
      output,
      EXCLUDED_FINDING,
      /(?:根拠なし|必要以上の拡張|今回の範囲外|確認後は問題なし|修正対象(?:にしない|ではない|ではありません|なし)|unsupported|unnecessary expansion|outside this task|no issue after verification|not selected for repair|(?:not|without)\s+reopen)/i,
    )],
    ['old-finding-not-selected-for-repair', !hasNearbyRepairRequirement(output, EXCLUDED_FINDING)],
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
