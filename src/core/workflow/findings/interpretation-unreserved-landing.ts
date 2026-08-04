import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import type { InterpretationUnreservedLandingAuthority } from '../../models/finding-contract-types.js';
import { computeProvisionalStableKey } from './raw-canonicalization.js';
import {
  applyProvisionalFindingSpecsToLedger,
  type ProvisionalFindingSpec,
} from './reconciler.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type {
  FindingLedger,
  FindingEvidenceRecord,
  FindingObservation,
  InterpretationAttempt,
  InterpretationCase,
} from './types.js';

function appendVerifiedEvidenceRecords(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  recordsByRawFindingId: ReadonlyMap<string, readonly FindingEvidenceRecord[]>;
}): FindingLedger {
  const existingById = new Map(input.ledger.evidenceRecords.map((record) => [
    record.evidenceId,
    record,
  ]));
  const appended: FindingEvidenceRecord[] = [];
  for (const item of input.items) {
    for (const record of input.recordsByRawFindingId.get(item.canonical.rawFindingId) ?? []) {
      const existing = existingById.get(record.evidenceId);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error(`Verified evidence record "${record.evidenceId}" has conflicting content`);
      }
      if (existing === undefined) {
        appended.push(structuredClone(record));
        existingById.set(record.evidenceId, record);
      }
    }
  }
  appended.sort((left, right) => compareBinaryStrings(left.evidenceId, right.evidenceId));
  return appended.length === 0
    ? input.ledger
    : { ...input.ledger, evidenceRecords: [...input.ledger.evidenceRecords, ...appended] };
}

function withoutRevision<T extends { revision: number }>(value: T): Omit<T, 'revision'> {
  const { revision: _revision, ...rest } = value;
  void _revision;
  return rest;
}

function provisionalSpec(input: {
  plannedCase: InterpretationCase;
  items: readonly CanonicalIntakeItem[];
  authority: InterpretationUnreservedLandingAuthority;
  reason: string;
}): ProvisionalFindingSpec {
  const first = input.items[0];
  if (first === undefined) {
    throw new Error(`Interpretation case "${input.plannedCase.caseId}" has no canonical members`);
  }
  const canonical = first.canonical;
  return {
    kind: input.authority.reason,
    stableKey: computeProvisionalStableKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: input.plannedCase.lineageKey,
      provisionalKind: input.authority.reason,
    }),
    lineageKey: input.plannedCase.lineageKey,
    sourceRawFindingIds: input.items
      .map((item) => item.canonical.rawFindingId)
      .sort(compareBinaryStrings),
    reason: input.reason,
    title: canonical.title ?? null,
    severity: canonical.severity ?? null,
    ...(canonical.description === undefined ? {} : { description: canonical.description }),
    ...(canonical.suggestion === undefined ? {} : { suggestion: canonical.suggestion }),
    reviewers: [...new Set(input.items.map((item) => item.canonical.reviewer))]
      .sort(compareBinaryStrings),
    target: structuredClone(canonical.target),
    targetIdentityHash: canonical.targetIdentityHash,
    claimIdentityHash: canonical.claimIdentityHash,
    semanticClaimIdentityHash: canonical.semanticClaimIdentityHash,
    recoveryReviewerStableKey: canonical.reviewerStableKey,
    landingAuthority: structuredClone(input.authority),
  };
}

export function applyInterruptedInterpretationLanding(input: {
  ledger: FindingLedger;
  plannedCase: Extract<InterpretationCase, { kind: 'provider_case' }>;
  items: readonly CanonicalIntakeItem[];
  interruptedAttempt: Extract<InterpretationAttempt, { stage: 'interrupted' }>;
  authority: InterpretationUnreservedLandingAuthority;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
  reason: string;
  observation: FindingObservation;
}): FindingLedger {
  const rawFindingIds = input.items
    .map((item) => item.canonical.rawFindingId)
    .sort(compareBinaryStrings);
  if (
    input.interruptedAttempt.caseId !== input.plannedCase.caseId
    || input.interruptedAttempt.rawFindingIds.length !== rawFindingIds.length
    || input.interruptedAttempt.rawFindingIds.some((rawFindingId, index) => (
      rawFindingId !== rawFindingIds[index]
    ))
  ) {
    throw new Error(`Interrupted interpretation attempt "${input.interruptedAttempt.attemptId}" does not own its case`);
  }
  for (const rawFindingId of rawFindingIds) {
    const outcome = input.ledger.rawInterpretationOutcomes.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    );
    if (outcome?.kind !== 'pending_attempt'
      || outcome.attemptId !== input.interruptedAttempt.attemptId) {
      throw new Error(`Interrupted interpretation raw finding "${rawFindingId}" has no pending owner`);
    }
  }
  const ledger = appendVerifiedEvidenceRecords({
    ledger: input.ledger,
    items: input.items,
    recordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
  });
  const evidenceIds = input.items.flatMap((item) => (
    input.verifiedEvidenceRecordsByRawFindingId
      .get(item.canonical.rawFindingId)
      ?.map((record) => record.evidenceId) ?? []
  )).sort(compareBinaryStrings);
  const spec = provisionalSpec({
    plannedCase: input.plannedCase,
    items: input.items,
    authority: input.authority,
    reason: input.reason,
  });
  const projected = applyProvisionalFindingSpecsToLedger(
    ledger,
    [spec],
    {
      workflowName: input.ledger.workflowName,
      stepName: input.observation.stepName,
      runId: input.observation.runId,
      timestamp: input.observation.timestamp,
    },
  );
  const provisional = projected.findings.filter((finding) => (
    finding.status === 'open' && finding.provisional?.stableKey === spec.stableKey
  ));
  if (provisional.length !== 1) {
    throw new Error(`Interrupted interpretation landing requires exact-one provisional for "${spec.stableKey}"`);
  }
  const beforeEventCount = ledger.lifecycleEvents.length;
  const applied = applyFindingLifecycleCommands({
    ledger,
    commands: [{
      operation: 'update_provisional',
      changes: {
        findings: [withoutRevision({
          ...provisional[0]!,
          evidenceIds: [...new Set([...provisional[0]!.evidenceIds, ...evidenceIds])]
            .sort(compareBinaryStrings),
        })],
        conflicts: [],
      },
      authority: structuredClone(input.authority),
      evidenceSourcesByTarget: new Map([[
        `finding\0${provisional[0]!.id}`,
        { sourceRawFindingIds: rawFindingIds, authorityEvidenceIds: [] },
      ]]),
      interpretationCaseIdsByRawFindingId: new Map(
        rawFindingIds.map((rawFindingId) => [rawFindingId, input.plannedCase.caseId]),
      ),
    }],
    occurredAt: input.observation,
  });
  const landingEvents = applied.lifecycleEvents.slice(beforeEventCount);
  if (landingEvents.length !== 1) {
    throw new Error(`Interrupted interpretation landing created ${landingEvents.length} lifecycle events`);
  }
  const landingEventId = landingEvents[0]!.eventId;
  return {
    ...applied,
    updatedAt: input.observation.timestamp,
    rawInterpretationOutcomes: applied.rawInterpretationOutcomes.map((outcome) => (
      outcome.kind === 'pending_attempt'
      && outcome.attemptId === input.interruptedAttempt.attemptId
      && rawFindingIds.includes(outcome.rawFindingId)
        ? {
            rawFindingId: outcome.rawFindingId,
            kind: 'provisional' as const,
            provisionalFindingId: provisional[0]!.id,
            landingEventId,
          }
        : outcome
    )),
  };
}
