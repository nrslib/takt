import {
  hasFixVerificationDecision,
  unwrapProviderOutput,
} from './final-readiness-decision.mjs';

export default function assertFixVerificationRegression(output, context = {}) {
  const text = unwrapProviderOutput(output);
  const incomplete = hasFixVerificationDecision(text, 'INCOMPLETE');
  const changeIdentified = /(?:今回の差分|変更したコード|current diff|changed code)/i.test(text);
  const regressionIdentified = /(?:原因|壊|退行|失敗|失われ|違反|未充足|cause|broke|regression|failure|lost|violat|unmet)/i.test(text);
  const preservedConditionIdentified = /(?:維持すべき既存条件|維持条件|既存条件|既存契約|既存の.*(?:条件|契約)|preserved existing condition|existing contract)/i.test(text);
  const implementationGap = /(?:実装不足|修正(?:が|は)?必要|完了とは判定できない|未完了|元に戻す|復元が必要|implementation gap|requires? repair|cannot be considered complete|incomplete|restore)/i.test(text);
  const currentDiffEvidence = /src\/export\.js|exportSummary/i.test(text)
    && /summary/i.test(text)
    && /value/i.test(text)
    && /(?:出力形式|戻り値|JSON|shape|output format|return value)/i.test(text);
  const preservedDefaultEvidence = /src\/mode\.js|normalizeMode/i.test(text)
    && /\blocal\b/i.test(text)
    && /(?:引数(?:なし|を省略|省略時)|既定引数|デフォルト|TypeError|without (?:an )?argument|omitted argument|default argument)/i.test(text);
  const causalEvidence = (changeIdentified
    || preservedConditionIdentified
    || currentDiffEvidence
    || preservedDefaultEvidence)
    && regressionIdentified;
  const regressionCase = context.vars?.regression_case;
  const fixtureEvidence = regressionCase === 'current_diff_export'
    ? currentDiffEvidence
    : regressionCase === 'preserved_default'
      ? preservedDefaultEvidence
      : currentDiffEvidence || preservedDefaultEvidence;
  const checks = [
    ['incomplete', incomplete],
    ['causal-evidence', causalEvidence],
    ['fixture-evidence', fixtureEvidence],
    ['implementation-gap', implementationGap],
    ['not-complete', !hasFixVerificationDecision(text, 'COMPLETE')],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'a causally connected regression is classified as an incomplete implementation'
      : `failed: ${failed.join(', ')}`,
  };
}
