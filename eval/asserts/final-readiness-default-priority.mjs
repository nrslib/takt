import { extractFindingObservation } from './finding-observation.mjs';

const FINDING = 'AIP-PRIMARY-1';

export const WEAKENING_EVIDENCE_PATTERN = /(?:\b(?:best[- ]?effort|optional|(?:safe|safer) default|safety preference)\b|任意|安全(?:性)?(?:を|の)?(?:優先|重視|好み|選好)|安全(?:なので|だから)(?:既定|デフォルト)?|安全側(?:の)?(?:既定値|デフォルト)|努力目標)/i;

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
      && /(?:current implementation|現在(?:の)?実装|現在(?:の)?コード|現行実装)/i.test(evidence)
      && /(?:contradict|conflict|violate|unmet|missing|omits|矛盾|違反|不一致|未達|欠落|省略|読み替え|逆)/i.test(evidence)
      && /(?:manual(?:ly)?(?:[- ]triggered)?\s+Requeue|手動(?:の|で)?\s*(?:Requeue|再投入|再キュー))/i.test(evidence)
      && /(?:default|既定(?:値)?|デフォルト)/i.test(evidence)
      && /(?:initial cursor|初期カーソル)/i.test(evidence)
      && /(?:pending|保留)/i.test(evidence)
      && /(?:restartPoint|再実行位置)/i.test(evidence)
      && /(?:normal[- ]runner|takt run|通常(?:の)?(?:runner|ランナー|実行))/i.test(evidence)
      && /(?:claim(?:ed|ing|s)?|取得)/i.test(evidence)
      && /(?:fresh|新規実行)/i.test(evidence)
      && /(?:selected leaf|failed leaf|選択(?:した)?\s*(?:失敗)?\s*leaf|失敗\s*leaf)/i.test(evidence)],
    ['existing-family', /^EXISTING\s+AIP-PRIMARY-1$/i.test(fields.family?.value ?? '')],
    ['weakening-evidence', WEAKENING_EVIDENCE_PATTERN.test(evidence)],
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
