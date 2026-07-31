import type {
  FindingLedger,
  FindingLifecycleEvent,
  ReviewerAnomalyEntry,
} from './types.js';
import { isOutstandingReviewerAnomaly } from './reviewer-anomalies.js';

function hasVerifiedTargetBinding(
  ledger: FindingLedger,
  event: FindingLifecycleEvent,
  findingId: string,
): boolean {
  const evidenceRecordIds = new Set(
    ledger.evidenceRecords.map((record) => record.evidenceId),
  );
  return event.evidenceBindingIds.some((bindingId) => {
    const binding = ledger.evidenceBindings.find((candidate) => candidate.bindingId === bindingId);
    return binding?.operation === 'resolve_finding'
      && binding.target.entityKind === 'finding'
      && binding.target.entityId === findingId
      && evidenceRecordIds.has(binding.evidenceId);
  });
}

function verifiedResolutionTargetIds(
  previousLedger: FindingLedger,
  nextLedger: FindingLedger,
): ReadonlyMap<string, string> {
  const previousEventIds = new Set(previousLedger.lifecycleEvents.map((event) => event.eventId));
  const reservationsById = new Map(
    nextLedger.lifecycleReservations.map((reservation) => [reservation.reservationId, reservation]),
  );
  const eventIdByFindingId = new Map<string, string>();

  for (const event of nextLedger.lifecycleEvents) {
    if (
      previousEventIds.has(event.eventId)
      || event.operation !== 'resolve_finding'
      || reservationsById.get(event.reservationId)?.authority.kind !== 'verified_evidence'
    ) {
      continue;
    }
    for (const transition of event.transitions) {
      const findingId = transition.after.entityKind === 'finding'
        ? transition.after.entityId
        : undefined;
      if (
        findingId !== undefined
        && hasVerifiedTargetBinding(nextLedger, event, findingId)
      ) {
        eventIdByFindingId.set(findingId, event.eventId);
      }
    }
  }
  return eventIdByFindingId;
}

function anomalyTargetFindingIds(
  ledger: FindingLedger,
  anomaly: ReviewerAnomalyEntry,
): string[] {
  const rawFindingById = new Map(
    ledger.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]),
  );
  return [...new Set(anomaly.sourceRawFindingIds.flatMap((rawFindingId) => {
    const targetFindingId = rawFindingById.get(rawFindingId)?.targetFindingId;
    return targetFindingId === null || targetFindingId === undefined
      ? []
      : [targetFindingId];
  }))];
}

function settleAnomaly(
  anomaly: ReviewerAnomalyEntry,
  ledger: FindingLedger,
  resolutionEventIdByFindingId: ReadonlyMap<string, string>,
): ReviewerAnomalyEntry {
  const findingId = anomalyTargetFindingIds(ledger, anomaly).find((targetId) => (
    ledger.findings.some((finding) => finding.id === targetId && finding.status === 'resolved')
    && resolutionEventIdByFindingId.has(targetId)
  ));
  const lifecycleEventId = findingId === undefined
    ? undefined
    : resolutionEventIdByFindingId.get(findingId);
  return findingId === undefined || lifecycleEventId === undefined
    ? anomaly
    : {
        ...anomaly,
        settlement: {
          kind: 'target_resolved_by_verified_evidence',
          findingId,
          lifecycleEventId,
        },
      };
}

/**
 * 既存 anomaly の対象が、anomaly 観測後の lifecycle transaction で検証済み解消
 * された場合だけ監査レコードへ決着を追記する。観測自体と revision 履歴は消さない。
 */
export function settleReviewerAnomaliesFromVerifiedResolutions(
  eventBaselineLedger: FindingLedger,
  anomalyLedger: FindingLedger,
  nextLedger: FindingLedger,
): FindingLedger {
  if (anomalyLedger.reviewerAnomalies === undefined) {
    return nextLedger;
  }
  const resolutionEventIds = verifiedResolutionTargetIds(eventBaselineLedger, nextLedger);
  const settlementByAnomalyId = new Map(
    anomalyLedger.reviewerAnomalies
      .filter(isOutstandingReviewerAnomaly)
      .flatMap((anomaly) => {
        const settled = settleAnomaly(anomaly, nextLedger, resolutionEventIds);
        return settled.settlement === undefined ? [] : [[anomaly.id, settled] as const];
      }),
  );
  const currentAnomalies = nextLedger.reviewerAnomalies ?? [];
  const reviewerAnomalies = currentAnomalies.map(
    (anomaly) => settlementByAnomalyId.get(anomaly.id) ?? anomaly,
  );
  return reviewerAnomalies.some((anomaly, index) => anomaly !== currentAnomalies[index])
    ? { ...nextLedger, reviewerAnomalies }
    : nextLedger;
}
