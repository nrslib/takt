import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-DEFAULT-1';

export default function assertFinalReadinessDefaultPriority(output) {
  const { onlyTargetFinding, context: findingContext } = extractFindingObservation(output, FINDING);
  const checks = [
    ['only-target-finding', onlyTargetFinding],
    ['fix-required', /^result\s*[:：]\s*(?:FIX REQUIRED|修正が必要)\s*$/im.test(findingContext)],
    ['finding-reopened', /^disposition\s*[:：]\s*(?:reopen(?:ed)?|persist(?:s|ed)?|actionable|修正対象)\s*$/im.test(findingContext)],
    ['source-contradiction', /(?:requirements\.md|requirement|要件|受入条件|primary source|正本)/i.test(findingContext)
      && /(?:current implementation|現在実装|現在(?:の)?コード|現行実装)/i.test(findingContext)
      && /(?:contradict|conflict|violate|unmet|矛盾|違反|不一致|未達|読み替え|逆)/i.test(findingContext)],
    ['existing-family', /^family\s*[:：]\s*EXISTING\s+AIP-DEFAULT-1\s*$/im.test(findingContext)],
    ['best-effort-weakening-rejected', /(?:best[- ]?effort|optional|任意|努力目標)[^\n]{0,160}(?:absent|not|reject|invent|存在しない|反証|退け|認めない|要求外|弱化|禁止)/i.test(findingContext)
      || /(?:存在しない|反証|退け|認めない|要求外|弱化|禁止)[^\n]{0,160}(?:best[- ]?effort|optional|任意|努力目標)/i.test(findingContext)],
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
