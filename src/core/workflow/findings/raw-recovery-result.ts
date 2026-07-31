import { createRawRecoveryResult } from '../../models/finding-raw-recovery.js';
import {
  assertRawRecoveryResultEvents,
  lifecycleEventAuthorizesReplayRawFinding,
} from '../../models/finding-raw-recovery-validation.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import type { FindingLedger, FindingObservation } from './types.js';

export function completeRawRecoveryAttempts(
  before: FindingLedger,
  after: FindingLedger,
  attemptIds: ReadonlySet<string>,
  replayRawFindingIdByAttemptId: ReadonlyMap<string, string>,
  observation: FindingObservation,
): FindingLedger {
  if (attemptIds.size === 0) {
    return after;
  }
  const existingResultAttemptIds = new Set(
    after.rawRecoveryResults.map((result) => result.attemptId),
  );
  const newEvents = after.lifecycleEvents.slice(before.lifecycleEvents.length);
  const additions = [...attemptIds].flatMap((attemptId) => {
    if (existingResultAttemptIds.has(attemptId)) {
      return [];
    }
    const attempt = after.rawRecoveryAttempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) {
      throw new Error(`Raw recovery result references unknown attempt "${attemptId}"`);
    }
    const replayRawFindingId = replayRawFindingIdByAttemptId.get(attemptId);
    const mutationIds = newEvents.flatMap((event) => {
      const bindsReplay = replayRawFindingId !== undefined
        && lifecycleEventAuthorizesReplayRawFinding({
          event,
          replayRawFindingId,
          evidenceBindings: after.evidenceBindings,
          evidenceRecords: after.evidenceRecords,
        });
      return bindsReplay && event.transitions.some((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === attempt.provisionalFindingId
      ))
        ? [event.mutationId]
        : [];
    });
    const currentHead = captureFindingLifecycleHead(
      before,
      'finding',
      attempt.provisionalFindingId,
    );
    const outcome = currentHead?.eventId !== attempt.expectedHead.eventId
      ? 'stale' as const
      : mutationIds.length > 0
        ? 'applied' as const
        : 'failed' as const;
    const result = createRawRecoveryResult({
      attemptId,
      replayRawFindingId: replayRawFindingId ?? null,
      mutationIds,
      outcome,
      completedAt: observation,
    });
    assertRawRecoveryResultEvents({
      attempt,
      result,
      lifecycleEvents: after.lifecycleEvents,
      evidenceBindings: after.evidenceBindings,
      evidenceRecords: after.evidenceRecords,
    });
    return [result];
  });
  return {
    ...after,
    rawRecoveryResults: [...after.rawRecoveryResults, ...additions],
  };
}
