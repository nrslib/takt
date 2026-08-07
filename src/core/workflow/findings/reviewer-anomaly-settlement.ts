import {
  reviewerAnomalySettlementEligibilityViolation,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
import type {
  FindingLedger,
  FindingLifecycleEvent,
  ReviewerAnomalyEntry,
  ReviewerAnomalyTargetSettlement,
} from './types.js';
import { isConcludedReviewerAnomaly } from './reviewer-anomalies.js';

function settlementKind(
  event: FindingLifecycleEvent,
): ReviewerAnomalyTargetSettlement['kind'] | undefined {
  if (event.operation === 'resolve_finding') {
    return 'target_resolved_by_verified_evidence';
  }
  return event.operation === 'dismiss_finding'
    ? 'target_dismissed_by_terminal_adjudication'
    : undefined;
}

function eligibleSettlement(input: {
  eventBaselineLedger: FindingLedger;
  nextLedger: FindingLedger;
  anomaly: ReviewerAnomalyEntry;
  workflowTaskDigest: string;
}): ReviewerAnomalyTargetSettlement | undefined {
  for (let index = input.nextLedger.lifecycleEvents.length - 1; index >= 0; index -= 1) {
    const event = input.nextLedger.lifecycleEvents[index]!;
    const kind = settlementKind(event);
    if (kind === undefined) {
      continue;
    }
    for (const transition of event.transitions) {
      if (transition.after.entityKind !== 'finding') {
        continue;
      }
      const settlement: ReviewerAnomalyTargetSettlement = {
        kind,
        findingId: transition.after.entityId,
        lifecycleEventId: event.eventId,
      };
      const violation = reviewerAnomalySettlementEligibilityViolation({
        projection: input.nextLedger,
        anomaly: input.anomaly,
        settlement,
        sourceHead: {
          kind: 'ledger',
          ledger: input.eventBaselineLedger,
        },
        workflowTaskDigest: input.workflowTaskDigest,
      });
      if (violation === undefined) {
        return settlement;
      }
    }
  }
  return undefined;
}

export function settleReviewerAnomaliesFromAuthorizedTerminalEvents(
  eventBaselineLedger: FindingLedger,
  anomalyLedger: FindingLedger,
  nextLedger: FindingLedger,
  workflowTaskDigest: string,
): FindingLedger {
  if (anomalyLedger.reviewerAnomalies === undefined) {
    return nextLedger;
  }
  const settlementByAnomalyId = new Map(
    anomalyLedger.reviewerAnomalies
      .filter((anomaly) => !isConcludedReviewerAnomaly(anomaly))
      .flatMap((anomaly) => {
        const settlement = eligibleSettlement({
          eventBaselineLedger,
          nextLedger,
          anomaly,
          workflowTaskDigest,
        });
        return settlement === undefined
          ? []
          : [[anomaly.id, settlement] as const];
      }),
  );
  const currentAnomalies = nextLedger.reviewerAnomalies ?? [];
  const reviewerAnomalies = currentAnomalies.map((anomaly) => {
    const settlement = settlementByAnomalyId.get(anomaly.id);
    return settlement === undefined ? anomaly : { ...anomaly, settlement };
  });
  return reviewerAnomalies.some((anomaly, index) => (
    anomaly !== currentAnomalies[index]
  ))
    ? { ...nextLedger, reviewerAnomalies }
    : nextLedger;
}
