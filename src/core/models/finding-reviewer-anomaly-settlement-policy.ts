import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import {
  captureFindingMutationPrecondition,
  sameFindingMutationPrecondition,
} from './finding-mutation-precondition.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedgerEntry,
  FindingLifecycleEvent,
  FindingLifecycleReservation,
  FindingMutationPrecondition,
  RawFinding,
  ReviewerAnomalyEntry,
  ReviewerAnomalyReviewWithdrawalSettlement,
  ReviewerAnomalySettlement,
  ReviewerAnomalyTargetSettlement,
} from './finding-types.js';

export interface ReviewerAnomalySettlementProjection {
  findings: readonly FindingLedgerEntry[];
  rawFindings: readonly RawFinding[];
  evidenceRecords: readonly FindingEvidenceRecord[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  lifecycleReservations: readonly FindingLifecycleReservation[];
  lifecycleEvents: readonly FindingLifecycleEvent[];
}

export type ReviewerAnomalySettlementSourceHead =
  | {
      kind: 'ledger';
      ledger: Pick<
        ReviewerAnomalySettlementProjection,
        'findings' | 'rawFindings' | 'lifecycleEvents'
      >;
    }
  | { kind: 'projection' };

function latestFindingHead(
  ledger: Pick<ReviewerAnomalySettlementProjection, 'lifecycleEvents'>,
  findingId: string,
) {
  for (let index = ledger.lifecycleEvents.length - 1; index >= 0; index -= 1) {
    const head = ledger.lifecycleEvents[index]!.transitions.find((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === findingId
    ))?.after;
    if (head !== undefined) {
      return head;
    }
  }
  return undefined;
}

function latestMatchingTerminalEventThroughRevision(
  ledger: Pick<ReviewerAnomalySettlementProjection, 'lifecycleEvents'>,
  event: FindingLifecycleEvent,
  findingId: string,
  revision: number,
): FindingLifecycleEvent | undefined {
  for (let index = ledger.lifecycleEvents.length - 1; index >= 0; index -= 1) {
    const candidate = ledger.lifecycleEvents[index]!;
    if (
      candidate.operation === event.operation
      && candidate.transitions.some((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === findingId
        && transition.after.revision <= revision
      ))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function sourceRawFindings(
  projection: ReviewerAnomalySettlementProjection,
  anomaly: ReviewerAnomalyEntry,
): RawFinding[] | undefined {
  if (anomaly.sourceRawFindingIds.length === 0) {
    return undefined;
  }
  const rawById = new Map(
    projection.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  const sources = anomaly.sourceRawFindingIds.map(
    (rawFindingId) => rawById.get(rawFindingId),
  );
  return sources.every((raw): raw is RawFinding => raw !== undefined)
    ? sources
    : undefined;
}

function sourcesMatchPrecondition(
  sources: readonly RawFinding[],
  findingId: string,
  expected: FindingMutationPrecondition,
): boolean {
  return sources.every((raw) => (
    raw.relation !== null
    && raw.relation !== 'new'
    && raw.targetFindingId === findingId
    && raw.targetPrecondition !== undefined
    && raw.targetPrecondition.targetFindingId === findingId
    && sameFindingMutationPrecondition(raw.targetPrecondition, expected)
  ));
}

function sourcesMatchRequiredHead(input: {
  projection: ReviewerAnomalySettlementProjection;
  anomaly: ReviewerAnomalyEntry;
  settlement: ReviewerAnomalyTargetSettlement;
  event: FindingLifecycleEvent;
  transition: FindingLifecycleEvent['transitions'][number];
  sourceHead: ReviewerAnomalySettlementSourceHead;
}): boolean {
  const sources = sourceRawFindings(input.projection, input.anomaly);
  if (sources === undefined) {
    return false;
  }
  if (input.sourceHead.kind === 'ledger') {
    const expected = captureFindingMutationPrecondition(
      input.sourceHead.ledger,
      input.settlement.findingId,
    );
    if (
      expected === undefined
      || !sourcesMatchPrecondition(sources, input.settlement.findingId, expected)
    ) {
      return false;
    }
    const eventAlreadyExists = input.sourceHead.ledger.lifecycleEvents.some(
      (event) => event.eventId === input.event.eventId,
    );
    if (eventAlreadyExists) {
      return latestMatchingTerminalEventThroughRevision(
        input.sourceHead.ledger,
        input.event,
        input.settlement.findingId,
        expected.targetRevision,
      )?.eventId === input.event.eventId;
    }
    return input.transition.before !== null
      && expected.targetRevision === input.transition.before.revision
      && canonicalJson(latestFindingHead(
        input.sourceHead.ledger,
        input.settlement.findingId,
      )) === canonicalJson(input.transition.before);
  }

  const first = sources[0]?.targetPrecondition;
  if (
    first === undefined
    || !sourcesMatchPrecondition(sources, input.settlement.findingId, first)
  ) {
    return false;
  }
  const matchesPreEventHead = input.transition.before !== null
    && first.targetRevision === input.transition.before.revision;
  if (matchesPreEventHead) {
    return true;
  }
  const expectedStatus = input.settlement.kind
    === 'target_resolved_by_verified_evidence'
    ? 'resolved'
    : 'dismissed';
  return first.targetStatus === expectedStatus
    && first.targetRevision >= input.transition.after.revision
    && latestMatchingTerminalEventThroughRevision(
      input.projection,
      input.event,
      input.settlement.findingId,
      first.targetRevision,
    )?.eventId === input.event.eventId;
}

function matchingReservation(input: {
  projection: ReviewerAnomalySettlementProjection;
  event: FindingLifecycleEvent;
  settlement: ReviewerAnomalyTargetSettlement;
  transition: FindingLifecycleEvent['transitions'][number];
}): FindingLifecycleReservation | undefined {
  const reservation = input.projection.lifecycleReservations.find(
    (candidate) => candidate.reservationId === input.event.reservationId,
  );
  const reservationTarget = reservation?.targets.find((target) => (
    target.entityKind === 'finding'
    && target.entityId === input.settlement.findingId
  ));
  return reservation !== undefined
    && reservation.mutationId === input.event.mutationId
    && reservation.operation === input.event.operation
    && canonicalJson(reservation.evidenceBindingIds)
      === canonicalJson(input.event.evidenceBindingIds)
    && reservationTarget !== undefined
    && canonicalJson(reservationTarget.expectedHead)
      === canonicalJson(input.transition.before)
    ? reservation
    : undefined;
}

function hasVerifiedResolutionEvidence(input: {
  projection: ReviewerAnomalySettlementProjection;
  event: FindingLifecycleEvent;
  findingId: string;
}): boolean {
  const evidenceIds = new Set(
    input.projection.evidenceRecords.map((record) => record.evidenceId),
  );
  return input.event.evidenceBindingIds.some((bindingId) => {
    const binding = input.projection.evidenceBindings.find(
      (candidate) => candidate.bindingId === bindingId,
    );
    return binding?.operation === 'resolve_finding'
      && binding.target.entityKind === 'finding'
      && binding.target.entityId === input.findingId
      && evidenceIds.has(binding.evidenceId);
  });
}

function hasTerminalDismissalAuthority(input: {
  finding: FindingLedgerEntry;
  reservation: FindingLifecycleReservation;
  workflowTaskDigest: string | null;
}): boolean {
  const dismissal = input.finding.dismissal;
  if (
    dismissal?.authority !== 'terminal_adjudication'
    || input.reservation.authority.kind !== 'verified_terminal_adjudication'
  ) {
    return false;
  }
  if (
    dismissal.basis === 'outside_task_scope'
    && (
      dismissal.taskQuote === undefined
      || dismissal.workflowTaskDigest === undefined
      || dismissal.adjudicationTaskId === undefined
      || dismissal.adjudicationTaskId !== input.reservation.authority.attemptId
      || (
        input.workflowTaskDigest !== null
        && dismissal.workflowTaskDigest !== input.workflowTaskDigest
      )
    )
  ) {
    return false;
  }
  return true;
}

/**
 * 「同じレビュアー枠の次の完全なレビューが台帳へ登録された」ことによる決着は
 * product finding を根拠に持たない。成立条件は機械判定できる3点だけ:
 *   - その anomaly をまだ誰も決着させていない(昇格済みは昇格側が決着)
 *   - intake-contract anomaly ではない(あちらは言い直し契約という固有の決着経路を
 *     持ち、presentation / terminalDisposition と二重に決着すると監査記録が矛盾する)
 *   - 決着根拠の reviewer 集合が anomaly の観測者集合と完全一致する
 *
 * 完全一致を要求するのは、取り下げの成立条件が「全観測者の後続レビュー成立」
 * (collectReviewSupersededReviewerAnomalyIds の every 判定)だからで、部分集合を
 * 許すと再提示の機会を得ていない観測者の主張ごとゲートが緩む。過剰(観測者でない
 * レビュアーの混入)も根拠として無効なので拒否する。
 *
 * 1レビュアー枠は同一ラウンドに複数 publication を登録し得る(格上げ再レビューは
 * owner ごとに1呼び出しだが reviewer キーは固定)ので、reviewer の重複そのものは
 * 許す。ただし同じ publication の二重計上は根拠を水増しするため、
 * (reviewer, publicationId) の組の重複は拒否する。網羅性は reviewer 集合の
 * 完全一致で判定するため、重複が観測者の欠落を隠すことはない。
 */
function reviewWithdrawalEligibilityViolation(
  anomaly: ReviewerAnomalyEntry,
  settlement: ReviewerAnomalyReviewWithdrawalSettlement,
): string | undefined {
  if (anomaly.promotedFindingId !== undefined) {
    return 'promoted anomalies cannot be settled';
  }
  if (anomaly.intakeContract !== undefined) {
    return 'intake-contract anomalies settle through their restatement contract';
  }
  const publications = settlement.supersedingPublications;
  if (publications.length === 0) {
    return 'withdrawal must record at least one superseding publication';
  }
  const pairs = publications.map(({ reviewer, publicationId }) => `${reviewer}\u0000${publicationId}`);
  if (new Set(pairs).size !== pairs.length) {
    return 'withdrawal must not record the same superseding publication twice';
  }
  // 型が宣言する不変条件（非空・(reviewer, publicationId) の binary 順）は
  // ここでしか強制できない。1レビュアー枠が同一ラウンドに複数 publication を
  // 持てるようになり並びが揺れる余地が増えたので、順序を強制しないと台帳の
  // バイト列が非決定的になり監査時の再構成と差分比較が壊れる。
  if (canonicalJson(pairs) !== canonicalJson([...pairs].sort(compareBinaryStrings))) {
    return 'withdrawal must record superseding publications in binary order of (reviewer, publicationId)';
  }
  const recordedReviewers = [...new Set(publications.map(({ reviewer }) => reviewer))]
    .sort(compareBinaryStrings);
  return canonicalJson(recordedReviewers)
    === canonicalJson([...new Set(anomaly.reviewers)].sort(compareBinaryStrings))
    ? undefined
    : 'withdrawal must record a superseding review for every reviewer that observed the anomaly';
}

export function reviewerAnomalySettlementEligibilityViolation(input: {
  projection: ReviewerAnomalySettlementProjection;
  anomaly: ReviewerAnomalyEntry;
  settlement: ReviewerAnomalySettlement;
  sourceHead: ReviewerAnomalySettlementSourceHead;
  workflowTaskDigest: string | null;
}): string | undefined {
  const settlement = input.settlement;
  if (settlement.kind === 'withdrawn_by_subsequent_review') {
    return reviewWithdrawalEligibilityViolation(input.anomaly, settlement);
  }
  if (input.anomaly.kind === 'protocol-anomaly') {
    return 'protocol anomalies cannot be settled';
  }
  if (input.anomaly.promotedFindingId !== undefined) {
    return 'promoted anomalies cannot be settled';
  }
  const event = input.projection.lifecycleEvents.find(
    (candidate) => candidate.eventId === settlement.lifecycleEventId,
  );
  const finding = input.projection.findings.find(
    (candidate) => candidate.id === settlement.findingId,
  );
  const transition = event?.transitions.find((candidate) => (
    candidate.after.entityKind === 'finding'
    && candidate.after.entityId === settlement.findingId
  ));
  if (event === undefined || finding === undefined || transition === undefined) {
    return 'settlement target event is incomplete';
  }
  const reservation = matchingReservation({
    projection: input.projection,
    event,
    settlement,
    transition,
  });
  if (reservation === undefined) {
    return 'settlement event is not bound to its reservation';
  }
  if (!sourcesMatchRequiredHead({
    projection: input.projection,
    anomaly: input.anomaly,
    settlement,
    event,
    transition,
    sourceHead: input.sourceHead,
  })) {
    return 'all source raws must match the required target head';
  }
  if (settlement.kind === 'target_resolved_by_verified_evidence') {
    return event.operation === 'resolve_finding'
      && (
        finding.status === 'resolved'
        || input.sourceHead.kind === 'projection'
      )
      && reservation.authority.kind === 'verified_evidence'
      && hasVerifiedResolutionEvidence({
        projection: input.projection,
        event,
        findingId: finding.id,
      })
      ? undefined
      : 'settlement does not reference an authorized verified resolution';
  }
  return event.operation === 'dismiss_finding'
    && (
      finding.status === 'dismissed'
      || input.sourceHead.kind === 'projection'
    )
    && hasTerminalDismissalAuthority({
      finding,
      reservation,
      workflowTaskDigest: input.workflowTaskDigest,
    })
    ? undefined
    : 'settlement does not reference an authorized terminal dismissal';
}
