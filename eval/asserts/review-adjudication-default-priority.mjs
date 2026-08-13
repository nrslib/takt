import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-DEFAULT-1';

export default function assertReviewAdjudicationDefaultPriority(output) {
  const { onlyTargetFinding, fields } = extractFindingObservation(output, FINDING);
  const requiredFields = ['result', 'disposition', 'authority', 'winner', 'preserved', 'evidence'];
  const hasRequiredFields = requiredFields.every((field) => (
    fields[field]?.count === 1 && fields[field].value.length > 0
  ));
  const checks = [
    ['only-target-finding', onlyTargetFinding],
    ['required-fields', hasRequiredFields],
    ['actionable-result', /^(?:ACTIONABLE|修正対象あり)$/i.test(fields.result?.value ?? '')],
    ['actionable-disposition', /^actionable$/i.test(fields.disposition?.value ?? '')],
    ['direct-requirement-authority', /^DIRECT_ACCEPTANCE_CRITERION_VIOLATION$/i.test(fields.authority?.value ?? '')],
    ['coexistence-winner', /^FAILED_LEAF$/i.test(fields.winner?.value ?? '')],
    ['resume-preserved', /^RESUME$/i.test(fields.preserved?.value ?? '')],
    ['coexistence-evidence', /(?:failed|失敗)[^\n]{0,160}(?:Resume|再開)|(?:Resume|再開)[^\n]{0,160}(?:failed|失敗)/i.test(fields.evidence?.value ?? '')],
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
