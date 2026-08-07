import {
  isConcludedReviewerAnomaly,
  reviewerAnomalySettlementEligibilityViolation,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
import type {
  FindingLedger,
  FindingLifecycleEvent,
  ReviewerAnomalyEntry,
  ReviewerAnomalyTargetSettlement,
} from './types.js';

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
  // 決着判定は書き込み先（nextLedger）の episode で行う。候補を選ぶ anomalyLedger は
  // このコミットの途中ビューであり、同じ id が nextLedger 側で終端処分や昇格を
  // 得ていることがある。古いビューで判定すると、決着済みへ settlement を書いて
  // 終端処分との同居違反を作る。
  const writeTargetById = new Map(
    (nextLedger.reviewerAnomalies ?? []).map((anomaly) => [anomaly.id, anomaly] as const),
  );
  const settlementByAnomalyId = new Map(
    anomalyLedger.reviewerAnomalies
      .filter((anomaly) => {
        const writeTarget = writeTargetById.get(anomaly.id);
        return writeTarget !== undefined && !isConcludedReviewerAnomaly(writeTarget);
      })
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
