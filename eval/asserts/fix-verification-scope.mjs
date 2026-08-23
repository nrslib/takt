import {
  hasFixVerificationDecision,
  unwrapProviderOutput,
} from './final-readiness-decision.mjs';

export default function assertFixVerificationScope(output) {
  const text = unwrapProviderOutput(output);
  const completionDecision = hasFixVerificationDecision(text, 'COMPLETE');
  const incompleteDecision = hasFixVerificationDecision(text, 'INCOMPLETE')
    || hasFixVerificationDecision(text, 'PLAN_INVALID');
  const normalizationEvidence = /trim\(\).{0,40}toLowerCase\(\)|前後.{0,40}(?:大文字小文字|大小文字).{0,40}正規化|空白(?:除去|削除).{0,40}(?:小文字化|大文字小文字|大小文字)/is.test(text);
  const allowedValueEvidence = /(?:local.{0,20}cloud|cloud.{0,20}local).{0,120}(?:許可|返|正規化|allow|return|normaliz)/is.test(text);
  const rejectionEvidence = /(?:不正値|それ以外|許可値以外|unsupported|invalid).{0,120}(?:例外|拒否|throw|reject)/is.test(text)
    || /(?:例外|拒否|throw|reject).{0,120}(?:不正値|それ以外|許可値以外|unsupported|invalid)/is.test(text);
  const plannedConditionSatisfied = normalizationEvidence && allowedValueEvidence && rejectionEvidence;
  const plannedConditionUnmet = text
    .split(/\r?\n|(?<=[。！？])\s*/u)
    .some((statement) => (
      /(?:受入条件|計画した条件|planned (?:condition|acceptance criterion))/i.test(statement)
        && /(?:未成立|不成立|未充足|未完了|未確認|満たしていない|unmet|unverified|not (?:satisfied|complete))/i.test(statement)
        && !/(?:該当しない|ではない|いずれ(?:とも|にも).{0,40}(?:確認できない|確認できません|当たらない|該当しない)|どれにも該当しない|なし|ありません|not applicable|does not apply)/i.test(statement)
    ));
  const hasNearbyEvidence = (anchor, evidence) => {
    let index = text.search(anchor);
    while (index >= 0) {
      const context = text.slice(Math.max(0, index - 500), index + 700);
      if (evidence.test(context)) return true;
      const next = text.slice(index + 1).search(anchor);
      index = next < 0 ? -1 : index + 1 + next;
    }
    return false;
  };
  const baselineEvidence = hasNearbyEvidence(
    /src\/export\.js/i,
    /(?:evidence\/export-before-change\.js|基準|変更前|baseline)[\s\S]{0,300}(?:同じ|一致|same|identical)|(?:同じ|一致|same|identical)[\s\S]{0,300}(?:evidence\/export-before-change\.js|基準|変更前|baseline)/i,
  );
  const referenceEvidence = hasNearbyEvidence(
    /test\/export\.integration\.test\.js|export[`\s]*テスト/i,
    /(?:src\/mode\.js|\bmode\b).{0,180}(?:経路|参照|依存|import).{0,120}(?:無関係|関係がない|関係ありません|存在しない|ない|なし|せず|しない|ありません)/is,
  );
  const checks = [
    ['completion-decision', completionDecision],
    ['planned-condition-satisfied', plannedConditionSatisfied && !plannedConditionUnmet],
    ['unrelated-failure-separated', /(?:無関係|既存不整合|因果関係.{0,20}(?:ない|ありません|認められない|確認できない|確認できず)|別の問題|未完了理由にはしない|out_of_scope|no_issue_after_verification|unrelated|no (?:verified )?causal connection|separate problem)/i.test(text)],
    ['causal-evidence-recorded', baselineEvidence || referenceEvidence],
    ['no-repair-expansion', !/(?:既存の export|export 用|legacy export).{0,120}(?:修正(?:する|が必要|対象)|変更(?:する|が必要)|repair|required change|must change)/is.test(text)],
    ['not-incomplete', !incompleteDecision],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'planned conditions are verified without expanding repair scope to an unrelated gate failure'
      : `failed: ${failed.join(', ')}`,
  };
}
