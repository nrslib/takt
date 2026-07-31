import { formatConflictId, type ConflictIdentity } from './finding-conflict-identity.js';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import {
  rawRecoveryAttemptIdentityViolation,
  rawRecoveryResultIdentityViolation,
} from './finding-raw-recovery.js';
import { rawRecoveryResultEventsViolation } from './finding-raw-recovery-validation.js';
import { computeRawFindingIntegrityDigest } from './finding-raw-integrity.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingLifecycleEvent,
  FindingLifecycleReservation,
  RawFinding,
  RawRecoveryAttempt,
  RawRecoveryResult,
  ReviewerAnomalyEntry,
} from './finding-types.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

export interface FindingLedgerProjectionInvariantInput {
  nextId: number;
  findings: readonly FindingLedgerEntry[];
  evidenceRecords: readonly FindingEvidenceRecord[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  lifecycleReservations: readonly FindingLifecycleReservation[];
  lifecycleEvents: readonly FindingLifecycleEvent[];
  rawRecoveryAttempts: readonly RawRecoveryAttempt[];
  rawRecoveryResults: readonly RawRecoveryResult[];
  rawFindings: readonly RawFinding[];
  conflicts: readonly (ConflictIdentity & FindingLedgerConflict)[];
  reviewerAnomalies?: readonly ReviewerAnomalyEntry[];
}

export interface FindingLedgerProjectionInvariantViolation {
  path: Array<string | number>;
  message: string;
}

function formatFindingIdNumber(idNumber: number): string {
  return `F-${String(idNumber).padStart(4, '0')}`;
}

export function collectFindingLedgerProjectionInvariantViolations(
  projection: FindingLedgerProjectionInvariantInput,
): FindingLedgerProjectionInvariantViolation[] {
  const violations: FindingLedgerProjectionInvariantViolation[] = [];
  const seen = new Set<string>();
  const evidenceIds = new Set<string>();
  projection.evidenceRecords.forEach((record, index) => {
    if (evidenceIds.has(record.evidenceId)) {
      violations.push({
        path: ['evidenceRecords', index, 'evidenceId'],
        message: `Duplicate evidence id "${record.evidenceId}"`,
      });
    }
    evidenceIds.add(record.evidenceId);
  });
  let maxFindingId = 0;
  projection.findings.forEach((finding, index) => {
    if (seen.has(finding.id)) {
      violations.push({
        path: ['findings', index, 'id'],
        message: `Duplicate finding id "${finding.id}"`,
      });
      return;
    }
    seen.add(finding.id);
    const match = FINDING_ID_PATTERN.exec(finding.id);
    if (match === null) {
      violations.push({
        path: ['findings', index, 'id'],
        message: `Invalid finding id format "${finding.id}"`,
      });
      return;
    }
    maxFindingId = Math.max(maxFindingId, Number(match[1]));
    finding.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        violations.push({
          path: ['findings', index, 'evidenceIds', evidenceIndex],
          message: `Finding "${finding.id}" references unknown evidence id "${evidenceId}"`,
        });
      }
    });
  });
  const findingsById = new Map(projection.findings.map((finding) => [finding.id, finding]));
  projection.findings.forEach((finding, index) => {
    if (finding.status !== 'superseded' || finding.supersededByFindingId === undefined) {
      return;
    }
    const canonical = findingsById.get(finding.supersededByFindingId);
    if (canonical === undefined) {
      violations.push({
        path: ['findings', index, 'supersededByFindingId'],
        message: `Superseded finding "${finding.id}" references unknown canonical finding "${finding.supersededByFindingId}"`,
      });
      return;
    }
    const canonicalEvidenceIds = new Set(canonical.evidenceIds);
    const missingEvidenceId = finding.evidenceIds.find(
      (evidenceId) => !canonicalEvidenceIds.has(evidenceId),
    );
    if (missingEvidenceId !== undefined) {
      violations.push({
        path: ['findings', index, 'evidenceIds'],
        message: `Superseded finding "${finding.id}" evidence id "${missingEvidenceId}" must also be referenced by canonical finding "${canonical.id}"`,
      });
    }
  });
  if (projection.nextId <= maxFindingId) {
    violations.push({
      path: ['nextId'],
      message: `Finding ledger nextId ${projection.nextId} must be greater than existing finding id ${formatFindingIdNumber(maxFindingId)}`,
    });
  }
  projection.conflicts.forEach((conflict, index) => {
    const canonicalId = formatConflictId(conflict);
    if (conflict.id !== canonicalId) {
      violations.push({
        path: ['conflicts', index, 'id'],
        message: `Conflict id "${conflict.id}" must equal its canonical content-derived id "${canonicalId}"`,
      });
    }
  });
  const rawById = new Map(projection.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  collectReviewerAnomalySettlementViolations(projection, violations, rawById);
  const attemptsById = new Map<string, RawRecoveryAttempt>();
  projection.rawRecoveryAttempts.forEach((attempt, index) => {
    const identityViolation = rawRecoveryAttemptIdentityViolation(attempt);
    if (identityViolation !== undefined) {
      violations.push({ path: ['rawRecoveryAttempts', index, 'attemptId'], message: identityViolation });
    }
    if (attemptsById.has(attempt.attemptId)) {
      violations.push({
        path: ['rawRecoveryAttempts', index, 'attemptId'],
        message: `Duplicate raw recovery attempt "${attempt.attemptId}"`,
      });
    }
    const raw = rawById.get(attempt.sourceRawFindingId);
    if (
      raw !== undefined
      && attempt.sourceRawIntegrityDigest !== computeRawFindingIntegrityDigest(raw)
    ) {
      violations.push({
        path: ['rawRecoveryAttempts', index, 'sourceRawIntegrityDigest'],
        message: `Raw recovery attempt "${attempt.attemptId}" has stale source integrity`,
      });
    }
    if (raw === undefined && attempt.sourceRawIntegrityDigest !== null) {
      violations.push({
        path: ['rawRecoveryAttempts', index, 'sourceRawIntegrityDigest'],
        message: `Raw recovery attempt "${attempt.attemptId}" has integrity for a missing source`,
      });
    }
    const expectedEvent = projection.lifecycleEvents.find(
      (event) => event.eventId === attempt.expectedHead.eventId,
    );
    const expectedTransition = expectedEvent?.transitions.find((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === attempt.provisionalFindingId
    ));
    if (
      expectedTransition === undefined
      || expectedTransition.after.revision !== attempt.expectedHead.revision
      || expectedTransition.after.projectionDigest !== attempt.expectedHead.projectionDigest
    ) {
      violations.push({
        path: ['rawRecoveryAttempts', index, 'expectedHead'],
        message: `Raw recovery attempt "${attempt.attemptId}" does not reference an exact lifecycle head`,
      });
    }
    attemptsById.set(attempt.attemptId, attempt);
  });
  const resultAttempts = new Set<string>();
  projection.rawRecoveryResults.forEach((result, index) => {
    const identityViolation = rawRecoveryResultIdentityViolation(result);
    if (identityViolation !== undefined) {
      violations.push({ path: ['rawRecoveryResults', index, 'resultId'], message: identityViolation });
    }
    const attempt = attemptsById.get(result.attemptId);
    if (attempt === undefined) {
      violations.push({
        path: ['rawRecoveryResults', index, 'attemptId'],
        message: `Raw recovery result "${result.resultId}" references an unknown attempt`,
      });
    }
    if (resultAttempts.has(result.attemptId)) {
      violations.push({
        path: ['rawRecoveryResults', index, 'attemptId'],
        message: `Raw recovery attempt "${result.attemptId}" has multiple results`,
      });
    }
    const replayRaw = result.replayRawFindingId === null
      ? undefined
      : rawById.get(result.replayRawFindingId);
    if (
      result.outcome === 'applied'
      && result.replayRawFindingId !== null
      && replayRaw === undefined
    ) {
      violations.push({
        path: ['rawRecoveryResults', index, 'replayRawFindingId'],
        message: `Raw recovery result "${result.resultId}" references unknown replay raw finding "${result.replayRawFindingId}"`,
      });
    }
    const sourceRaw = attempt === undefined
      ? undefined
      : rawById.get(attempt.sourceRawFindingId);
    if (
      replayRaw !== undefined
      && sourceRaw !== undefined
      && canonicalJson({ ...replayRaw, rawFindingId: null })
        !== canonicalJson({ ...sourceRaw, rawFindingId: null })
    ) {
      violations.push({
        path: ['rawRecoveryResults', index, 'replayRawFindingId'],
        message: `Raw recovery result "${result.resultId}" replay raw finding does not match its attempt source`,
      });
    }
    if (attempt !== undefined) {
      const eventViolation = rawRecoveryResultEventsViolation({
        attempt,
        result,
        lifecycleEvents: projection.lifecycleEvents,
        evidenceBindings: projection.evidenceBindings,
      });
      if (eventViolation !== undefined) {
        violations.push({
          path: ['rawRecoveryResults', index, 'mutationIds'],
          message: eventViolation,
        });
      }
    }
    resultAttempts.add(result.attemptId);
  });
  return violations;
}

function collectReviewerAnomalySettlementViolations(
  projection: FindingLedgerProjectionInvariantInput,
  violations: FindingLedgerProjectionInvariantViolation[],
  rawById: ReadonlyMap<string, RawFinding>,
): void {
  const anomalyIds = new Set<string>();
  const findingsById = new Map(projection.findings.map((finding) => [finding.id, finding]));
  const eventsById = new Map(projection.lifecycleEvents.map((event) => [event.eventId, event]));
  const reservationsById = new Map(
    projection.lifecycleReservations.map((reservation) => [reservation.reservationId, reservation]),
  );
  const bindingsById = new Map(
    projection.evidenceBindings.map((binding) => [binding.bindingId, binding]),
  );
  const evidenceIds = new Set(projection.evidenceRecords.map((record) => record.evidenceId));

  for (const [index, anomaly] of (projection.reviewerAnomalies ?? []).entries()) {
    if (anomalyIds.has(anomaly.id)) {
      violations.push({
        path: ['reviewerAnomalies', index, 'id'],
        message: `Duplicate reviewer anomaly id "${anomaly.id}"`,
      });
    }
    anomalyIds.add(anomaly.id);
    const settlement = anomaly.settlement;
    if (settlement === undefined) {
      continue;
    }
    if (anomaly.promotedFindingId !== undefined) {
      violations.push({
        path: ['reviewerAnomalies', index, 'settlement'],
        message: `Reviewer anomaly "${anomaly.id}" cannot be both promoted and settled`,
      });
    }
    const targetIds = new Set(anomaly.sourceRawFindingIds.flatMap((rawFindingId) => {
      const targetFindingId = rawById.get(rawFindingId)?.targetFindingId;
      return targetFindingId === null || targetFindingId === undefined ? [] : [targetFindingId];
    }));
    const event = eventsById.get(settlement.lifecycleEventId);
    const reservation = event === undefined
      ? undefined
      : reservationsById.get(event.reservationId);
    const transitionMatches = event?.operation === 'resolve_finding'
      && event.transitions.some((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === settlement.findingId
      ));
    const bindingMatches = event?.evidenceBindingIds.some((bindingId) => {
      const binding = bindingsById.get(bindingId);
      return binding?.operation === 'resolve_finding'
        && binding.target.entityKind === 'finding'
        && binding.target.entityId === settlement.findingId
        && evidenceIds.has(binding.evidenceId);
    }) === true;
    if (
      !targetIds.has(settlement.findingId)
      || !findingsById.has(settlement.findingId)
      || transitionMatches !== true
      || reservation?.authority.kind !== 'verified_evidence'
      || bindingMatches !== true
    ) {
      violations.push({
        path: ['reviewerAnomalies', index, 'settlement'],
        message: `Reviewer anomaly "${anomaly.id}" has an invalid verified-resolution settlement`,
      });
    }
  }
}

export function assertFindingLedgerProjectionInvariant(
  projection: FindingLedgerProjectionInvariantInput,
): void {
  const violation = collectFindingLedgerProjectionInvariantViolations(projection)[0];
  if (violation !== undefined) {
    throw new Error(violation.message);
  }
}
