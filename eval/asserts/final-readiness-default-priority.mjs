import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-DEFAULT-1';

export default function assertFinalReadinessDefaultPriority(output) {
  const { onlyTargetFinding, fields } = extractFindingObservation(output, FINDING);
  const requiredFields = [
    'result',
    'disposition',
    'authority',
    'family',
    'source_contradiction',
    'weakening',
    'evidence',
  ];
  const hasRequiredFields = requiredFields.every((field) => (
    fields[field]?.count === 1 && fields[field].value.length > 0
  ));
  const evidence = fields.evidence?.value ?? '';
  const checks = [
    ['only-target-finding', onlyTargetFinding],
    ['required-fields', hasRequiredFields],
    ['fix-required', /^(?:FIX REQUIRED|修正が必要)$/i.test(fields.result?.value ?? '')],
    ['finding-reopened', /^(?:reopen(?:ed)?|persist(?:s|ed)?|actionable|修正対象)$/i.test(fields.disposition?.value ?? '')],
    ['reopen-authority', /^DIRECT_ACCEPTANCE_CRITERION_VIOLATION$/i.test(fields.authority?.value ?? '')],
    ['source-contradiction-confirmed', /^CONFIRMED$/i.test(fields.source_contradiction?.value ?? '')],
    ['weakening-rejected', /^REJECTED$/i.test(fields.weakening?.value ?? '')],
    ['source-contradiction', /(?:requirements\.md|requirement|要件|受入条件|primary source|正本)/i.test(evidence)
      && /(?:current implementation|現在実装|現在(?:の)?コード|現行実装)/i.test(evidence)
      && /(?:contradict|conflict|violate|unmet|矛盾|違反|不一致|未達|読み替え|逆)/i.test(evidence)],
    ['existing-family', /^EXISTING\s+AIP-DEFAULT-1$/i.test(fields.family?.value ?? '')],
    ['weakening-evidence', /(?:best[- ]?effort|optional|任意|努力目標)/i.test(evidence)],
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
