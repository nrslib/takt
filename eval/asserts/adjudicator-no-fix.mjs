export default function gradeAdjudicatorActions(_output, context) {
  const audit = context?.providerResponse?.metadata?.phase1_audit;
  return audit?.pass === true
    ? { pass: true, score: 1, reason: 'Phase 1: no changes or test/build attempts' }
    : { pass: false, score: 0, reason: audit?.violations.join('; ') ?? 'Missing Phase 1 audit' };
}
