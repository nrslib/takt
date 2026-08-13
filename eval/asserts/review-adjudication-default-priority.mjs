import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-DEFAULT-1';

export default function assertReviewAdjudicationDefaultPriority(output) {
  const { onlyTargetFinding, context: findingContext } = extractFindingObservation(output, FINDING);
  const checks = [
    ['only-target-finding', onlyTargetFinding],
    ['actionable-result', /^result\s*[:：]\s*(?:ACTIONABLE|修正対象あり)\s*$/im.test(findingContext)],
    ['actionable-disposition', /^disposition\s*[:：]\s*actionable\s*$/im.test(findingContext)],
    ['direct-requirement-authority', /(?:direct_acceptance_criterion_violation|受入条件(?:へ|の)?直接違反|明示要件(?:へ|の)?違反)/i.test(findingContext)],
    ['coexistence-winner', /(?:failed|失敗)[^\n]{0,120}(?:default|既定|初期)[^\n]{0,120}(?:Resume|再開)|(?:Resume|再開)[^\n]{0,120}(?:failed|失敗)[^\n]{0,120}(?:default|既定|優先)/i.test(findingContext)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'adjudication keeps the explicit coexistence priority actionable'
      : `failed: ${failed.join(', ')}`,
  };
}
