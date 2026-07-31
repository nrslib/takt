import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLifecycleEvent,
  RawRecoveryAttempt,
  RawRecoveryResult,
} from './finding-types.js';

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function lifecycleEventAuthorizesReplayRawFinding(input: {
  event: FindingLifecycleEvent;
  replayRawFindingId: string;
  evidenceBindings: readonly FindingEvidenceBinding[];
  evidenceRecords: readonly FindingEvidenceRecord[];
}): boolean {
  return input.event.evidenceBindingIds.some((bindingId) => {
    const binding = input.evidenceBindings.find(
      (candidate) => candidate.bindingId === bindingId,
    );
    if (binding?.sourceRawFindingId === input.replayRawFindingId) {
      return true;
    }
    const record = binding === undefined
      ? undefined
      : input.evidenceRecords.find(
          (candidate) => candidate.evidenceId === binding.evidenceId,
        );
    return record?.kind === 'engine_proof'
      && record.subject.kind === 'finding_provisional_product_transition'
      && record.subject.sourceRawFindings.some(
        (source) => source.rawFindingId === input.replayRawFindingId,
      );
  });
}

export function rawRecoveryResultEventsViolation(input: {
  attempt: RawRecoveryAttempt;
  result: RawRecoveryResult;
  lifecycleEvents: readonly FindingLifecycleEvent[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  evidenceRecords: readonly FindingEvidenceRecord[];
}): string | undefined {
  if (input.result.outcome !== 'applied') {
    if (input.result.mutationIds.length !== 0) {
      return `Raw recovery result "${input.result.resultId}" has mutations for a non-applied outcome`;
    }
    return undefined;
  }
  if (input.result.replayRawFindingId === null || input.result.mutationIds.length === 0) {
    return `Applied raw recovery result "${input.result.resultId}" requires replay raw and mutations`;
  }
  if (new Set(input.result.mutationIds).size !== input.result.mutationIds.length) {
    return `Raw recovery result "${input.result.resultId}" has duplicate mutations`;
  }
  const eventsByMutationId = new Map(
    input.lifecycleEvents.map((event, ordinal) => [
      event.mutationId,
      { event, ordinal },
    ]),
  );
  let priorOrdinal = -1;
  let expectedBefore = input.attempt.expectedHead;
  for (const mutationId of input.result.mutationIds) {
    const entry = eventsByMutationId.get(mutationId);
    if (entry === undefined) {
      return `Raw recovery result "${input.result.resultId}" references unknown lifecycle mutation "${mutationId}"`;
    }
    if (entry.ordinal <= priorOrdinal) {
      return `Raw recovery result "${input.result.resultId}" mutations are not in ledger ordinal order`;
    }
    const transitions = entry.event.transitions.filter((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === input.attempt.provisionalFindingId
    ));
    if (transitions.length !== 1 || !sameValue(transitions[0]!.before, expectedBefore)) {
      return `Raw recovery result "${input.result.resultId}" has a broken target transition chain`;
    }
    const bindsReplay = lifecycleEventAuthorizesReplayRawFinding({
      event: entry.event,
      replayRawFindingId: input.result.replayRawFindingId,
      evidenceBindings: input.evidenceBindings,
      evidenceRecords: input.evidenceRecords,
    });
    if (!bindsReplay) {
      return `Raw recovery result "${input.result.resultId}" mutation "${mutationId}" does not bind its replay raw`;
    }
    expectedBefore = transitions[0]!.after;
    priorOrdinal = entry.ordinal;
  }
  return undefined;
}

export function assertRawRecoveryResultEvents(input: {
  attempt: RawRecoveryAttempt;
  result: RawRecoveryResult;
  lifecycleEvents: readonly FindingLifecycleEvent[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  evidenceRecords: readonly FindingEvidenceRecord[];
}): void {
  const violation = rawRecoveryResultEventsViolation(input);
  if (violation !== undefined) {
    throw new Error(violation);
  }
}
