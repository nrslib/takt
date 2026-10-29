import { middleObservationParts } from '../phase1-execution-log-fixtures.mjs';

export default function gradePhase2(output, context) {
  const metadata = context?.providerResponse?.metadata;
  const audit = metadata?.phase2_audit;
  if (!audit?.pass) return { pass: false, score: 0, reason: audit?.violations.join('; ') ?? 'Missing tool audit' };
  if (context.vars.large_record && !middleObservationParts.every((part) => output.includes(part))) {
    return { pass: false, score: 0, reason: 'Missing the observation available only in the middle of the record' };
  }
  if (context.vars.phase1_session_prompt && (!metadata.resumed || !/次はテストを流す/.test(metadata.phase1_response))) {
    return { pass: false, score: 0, reason: 'Missing the same-session Phase 1 carryover' };
  }
  return { pass: true, score: 1, reason: 'Readonly Phase 2 constraints satisfied' };
}
