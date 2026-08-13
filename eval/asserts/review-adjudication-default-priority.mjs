import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-PRIMARY-1';

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
    ['primary-operation-winner', /^REQUEUE$/i.test(fields.winner?.value ?? '')],
    ['checkpoint-preserved', /^CHECKPOINT$/i.test(fields.preserved?.value ?? '')],
    ['primary-path-evidence', /(?:Requeue|再投入|再キュー)/i.test(fields.evidence?.value ?? '')
      && /(?:pending|保留|restartPoint|再実行位置)/i.test(fields.evidence?.value ?? '')
      && /(?:runner|takt run|通常実行)/i.test(fields.evidence?.value ?? '')
      && /(?:fresh|selected leaf|failed leaf|選択(?:した)?(?:失敗)?leaf|新規実行)/i.test(fields.evidence?.value ?? '')],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'adjudication keeps the primary Requeue-to-runner contract actionable'
      : `failed: ${failed.join(', ')}`,
  };
}
