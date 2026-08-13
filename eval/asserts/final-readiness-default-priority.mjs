const FINDING = 'AIP-DEFAULT-1';

export default function assertFinalReadinessDefaultPriority(output) {
  const findingContext = output.split('\n').filter((line) => line.includes(FINDING)).join('\n');
  const checks = [
    ['fix-required', /(?:(?:結果|裁定|判定|最終裁定)\s*[:：]\s*修正が必要|Result\s*[:：]\s*FIX REQUIRED)/i.test(output)],
    ['finding-retained', findingContext.length > 0],
    ['finding-not-locked-nonactionable', !/adjudicated_non_actionable/i.test(findingContext)],
    ['source-contradiction', /(?:requirements\.md|requirement|要件|受入条件|primary source|正本)/i.test(output)
      && /(?:current implementation|現在実装|現在のコード|現行実装)/i.test(output)
      && /(?:contradict|conflict|violate|unmet|矛盾|違反|不一致|未達|読み替え|逆)/i.test(output)],
    ['not-new-horizontal-family', /(?:same|existing|同じ|既存)[^\n]{0,100}(?:finding|family|指摘)|(?:裁定|adjudication)[^\n]{0,100}(?:invalid|誤り|矛盾|再開)/i.test(output)],
    ['best-effort-weakening-rejected', /(?:best[- ]?effort|optional|任意|努力目標)[^\n]{0,160}(?:absent|not|reject|invent|存在しない|反証|退け|認めない|要求外|弱化|禁止)/i.test(output)
      || /(?:存在しない|反証|退け|認めない|要求外|弱化|禁止)[^\n]{0,160}(?:best[- ]?effort|optional|任意|努力目標)/i.test(output)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'final gate corrects an adjudication that contradicts the primary source'
      : `failed: ${failed.join(', ')}`,
  };
}
