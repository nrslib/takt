import { hasFinalDecision, unwrapProviderOutput } from './final-readiness-decision.mjs';

const EXCLUDED_FINDING = 'OLD-REVIEW-readme-L1';
const ATTRIBUTED_PRIOR_REPAIR_CLAIM = /(?:「[^」]*(?:修正|対応|是正)[^」]*必要[^」]*」|(?:修正|対応|是正).{0,20}必要).{0,40}(?:記載|報告|主張).{0,20}(?:している|しています|した).{0,20}(?:が|ものの|一方).{0,160}(?:裁定|判断|現在のコード).{0,40}(?:優先|採用)/i;

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
  return lines.some((line, index) => {
    const context = [lines[index - 1], line, lines[index + 1]].filter(Boolean).join(' ');
    return line.includes(anchor)
      && /(?:remains?\s+open|requires?\s+(?:a\s+)?fix|selected\s+for\s+repair|再開(?:する|が必要)|修正(?:が)?必要|修正対象(?:にする|とする))/i.test(context)
      && !ATTRIBUTED_PRIOR_REPAIR_CLAIM.test(context);
  });
}

function hasUnresolvedRepairProblem(output) {
  const repairRequired = /\b(?:remains? open|requires? (?:a )?fix|repair (?:is )?required|must be fixed|unresolved)\b|修正(?:が|は)?必要|修正する必要|修正対象(?:にする|とする|である)|未解消(?:の|で|が|は)|(?:問題|課題|不具合).{0,80}(?:残(?:っている|っており|る)|残存(?:している|し)|対応(?:が|は)?必要|直す必要|是正(?:が|は)?必要)|(?:対応|是正|修復)(?:が|は)?必要/i;
  const repairNotRequired = /\b(?:not selected for repair|does not require (?:a )?fix|no (?:repair|fix) (?:is )?required|not unresolved)\b|修正(?:が|は)?不要|修正(?:する)?必要(?:は|が)?ない|修正対象(?:にしない|ではない|でない|なし|はありません)|未解消(?:の問題)?(?:は|が)?(?:ない|なし)|残(?:っていない|らない)|残存(?:していない|しない)|(?:対応|是正|修復)(?:が|は)?不要|(?:対応|直す|是正|修復)必要(?:は|が)?ない/i;
  return output
    .split(/\r?\n|(?<=[。！？])\s*|(?<=[.!?])(?:\s+|$)/u)
    .some((statement) => repairRequired.test(statement)
      && !repairNotRequired.test(statement)
      && !ATTRIBUTED_PRIOR_REPAIR_CLAIM.test(statement));
}

export default function assertFinalReadinessPrecision(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const checks = [
    ['approve', hasFinalDecision(reviewOutput, 'APPROVE')],
    ['no-unresolved-repair-problem', !hasUnresolvedRepairProblem(reviewOutput)],
    ['excluded-finding-preserved', hasNearbyEvidence(
      reviewOutput,
      EXCLUDED_FINDING,
      /(?:根拠なし|必要以上の拡張|今回の範囲外|確認後は問題なし|修正対象(?:にしない|ではない|ではありません|なし)|overreach|unsupported|unnecessary expansion|outside this task|no issue after verification|not selected for repair|(?:not|without)\s+reopen)/i,
    )],
    ['old-finding-not-selected-for-repair', !hasNearbyRepairRequirement(reviewOutput, EXCLUDED_FINDING)],
    ['not-rejected', !hasFinalDecision(reviewOutput, 'REJECT') && !hasFinalDecision(reviewOutput, 'BLOCKED')],
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
