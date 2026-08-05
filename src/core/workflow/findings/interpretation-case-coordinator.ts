import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  computeFindingManagerBudgetScopeId,
  computeFindingManagerRoundIdentity,
} from '../../models/finding-contract-identity.js';
import { createRawCanonicalSnapshot } from './raw-canonical-snapshot.js';
import {
  computeInterpretationBatchId,
  computeInterpretationCohortId,
} from '../../models/finding-interpretation-identity.js';
import {
  InterpretationBatchReceiptSchema,
  InterpretationDecisionSchema,
} from '../../models/finding-schemas.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import {
  createInterpretationCases,
  validateInterpretationCaseDecision,
} from './interpretation-case-model.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import {
  FindingManagerProviderBudgetExhaustedError,
  reserveFindingManagerProviderCall,
  settleFindingManagerProviderCall,
} from './finding-manager-provider-call.js';
import {
  appendStartedInterpretationAttempt,
  latestInterpretationAttempt,
  nextInterpretationAttemptOrdinal,
} from './interpretation-case-begin-records.js';
import { applyInterruptedInterpretationLanding } from './interpretation-unreserved-landing.js';
import {
  selectInterpretationCaseProofFastPath,
  type InterpretationCaseProofFastPathSelection,
} from './interpretation-case-proof-fast-path.js';
export { selectInterpretationCaseProofFastPath } from './interpretation-case-proof-fast-path.js';
import type { LedgerRepository } from './store.js';
import type {
  FindingLedger,
  FindingObservation,
  FindingManagerProviderBudgetLimits,
  FindingEvidenceRecord,
  InterpretationAttempt,
  InterpretationAttemptFence,
  InterpretationBatchReceipt,
  InterpretationCase,
  InterpretationDecision,
} from './types.js';

export interface InterpretationCaseProofFastPathPlan
  extends InterpretationCaseProofFastPathSelection {
  items: CanonicalIntakeItem[];
  plannedCase: InterpretationCase;
  roundIdentity: string;
}

export interface InterpretationCaseDirectPlan {
  plannedCase: InterpretationCase;
  items: CanonicalIntakeItem[];
  decision: Extract<InterpretationDecision, { kind: 'provisional' }>;
  roundIdentity: string;
  unreservedAuthority?: import('../../models/finding-contract-types.js').InterpretationUnreservedLandingAuthority;
}

export interface BeginInterpretationCasesResult {
  providerCases: Array<Extract<InterpretationCase, { kind: 'provider_case' }>>;
  attempts: InterpretationAttempt[];
  /** Persisted completed attempts that the caller must atomically settle and apply. */
  completedAttemptIdsForCommit: string[];
  proofFastPathPlans: InterpretationCaseProofFastPathPlan[];
  directPlans: InterpretationCaseDirectPlan[];
  receipt: InterpretationBatchReceipt;
}

export interface PreparedInterpretationProviderRequest {
  requestBytes: string;
  exactTokenCount?: number;
  adapterSupportsUtf8ByteUpperBound: boolean;
}

interface LiveBeginEntry {
  inputKey: string;
  result: BeginInterpretationCasesResult;
  providerCasesById: ReadonlyMap<string, Extract<InterpretationCase, { kind: 'provider_case' }>>;
  itemsByCaseId: ReadonlyMap<string, CanonicalIntakeItem[]>;
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
}

const liveBeginsByStore = new WeakMap<LedgerRepository, LiveBeginEntry[]>();
const MAX_INTERPRETATION_RETRY_ORDINAL = 1;

function itemsForCase(
  plannedCase: InterpretationCase,
  itemsByRawFindingId: ReadonlyMap<string, CanonicalIntakeItem>,
): CanonicalIntakeItem[] {
  return plannedCase.members.map((member) => {
    const item = itemsByRawFindingId.get(member.rawFindingId);
    if (item === undefined) {
      throw new Error(`Interpretation case "${plannedCase.caseId}" references an unavailable raw member`);
    }
    return item;
  });
}

function beginInputKey(
  items: readonly CanonicalIntakeItem[],
  provisionalOnlyRawFindingIds: ReadonlySet<string>,
): string {
  return canonicalJson({
    items: items
      .map((item) => ({
        rawFindingId: item.canonical.rawFindingId,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
      }))
      .sort((left, right) => compareBinaryStrings(left.rawFindingId, right.rawFindingId)),
    provisionalOnlyRawFindingIds: [...provisionalOnlyRawFindingIds].sort(compareBinaryStrings),
  });
}

function assertCompatibleRawFindings(
  ledger: FindingLedger,
  items: readonly CanonicalIntakeItem[],
): void {
  for (const item of items) {
    const stored = ledger.rawFindings.find(
      (rawFinding) => rawFinding.rawFindingId === item.wire.rawFindingId,
    );
    if (
      stored !== undefined
      && computeRawFindingIntegrityDigest(stored) !== computeRawFindingIntegrityDigest(item.wire)
    ) {
      throw new Error(`Interpretation begin received the same raw identity "${item.wire.rawFindingId}" with a different payload`);
    }
  }
}

function assertCompatibleObservations(
  ledger: FindingLedger,
  cases: readonly InterpretationCase[],
  itemsByRawFindingId: ReadonlyMap<string, CanonicalIntakeItem>,
): void {
  for (const plannedCase of cases) {
    const cohortId = cohortIdForCase(plannedCase);
    for (const member of plannedCase.members) {
      const observation = ledger.interpretationRawObservations.find(
        (candidate) => candidate.rawFindingId === member.rawFindingId,
      );
      if (observation === undefined) {
        continue;
      }
      const item = itemsByRawFindingId.get(member.rawFindingId);
      if (item === undefined) {
        throw new Error(`Interpretation case "${plannedCase.caseId}" references an unavailable raw member`);
      }
      if (
        ledger.rawCanonicalSnapshots.find(
          (snapshot) => snapshot.rawCanonicalSnapshotId === observation.rawCanonicalSnapshotId,
        )?.canonicalIntegrityDigest !== canonicalRawIntegrityDigestOf(item.canonical)
        || observation.caseId !== plannedCase.caseId
        || observation.cohortId !== cohortId
        || observation.lineageKey !== plannedCase.lineageKey
        || observation.semanticProjectionDigest !== plannedCase.semanticProjectionDigest
      ) {
        throw new Error(`Interpretation observation for raw finding "${member.rawFindingId}" is incompatible with the current canonical case`);
      }
    }
  }
}

function isLiveResultCurrent(
  ledger: FindingLedger,
  result: BeginInterpretationCasesResult,
): boolean {
  return result.attempts.every((owned) => {
    const attempt = ledger.interpretationAttempts.find(
      (candidate) => candidate.attemptId === owned.attemptId,
    );
    const call = attempt === undefined ? undefined : ledger.findingManagerProviderCalls.find(
      (candidate) => candidate.providerCallId === attempt.providerCallId,
    );
    return attempt?.stage === 'started'
      && call?.state === 'reserved'
      && attempt.rawFindingIds.every((rawFindingId) => (
        ledger.rawInterpretationOutcomes.some((outcome) => (
          outcome.rawFindingId === rawFindingId
          && outcome.kind === 'pending_attempt'
          && outcome.attemptId === attempt.attemptId
        ))
      ));
  });
}

function activeLiveBegin(
  store: LedgerRepository,
  inputKey: string,
  ledger: FindingLedger,
): BeginInterpretationCasesResult | undefined {
  const entries = liveBeginsByStore.get(store) ?? [];
  const active = entries.filter((entry) => isLiveResultCurrent(ledger, entry.result));
  if (active.length === 0) {
    liveBeginsByStore.delete(store);
  } else if (active.length !== entries.length) {
    liveBeginsByStore.set(store, active);
  }
  return active.find((entry) => entry.inputKey === inputKey)?.result;
}

function rememberLiveBegin(
  store: LedgerRepository,
  inputKey: string,
  result: BeginInterpretationCasesResult,
  items: readonly CanonicalIntakeItem[],
  provisionalOnlyRawFindingIds: ReadonlySet<string>,
): void {
  const entries = liveBeginsByStore.get(store) ?? [];
  const itemsByRawFindingId = new Map(
    items.map((item) => [item.canonical.rawFindingId, item]),
  );
  liveBeginsByStore.set(store, [
    ...entries.filter((entry) => entry.inputKey !== inputKey),
    {
      inputKey,
      result,
      providerCasesById: new Map(result.providerCases.map((plannedCase) => [
        plannedCase.caseId,
        plannedCase,
      ])),
      itemsByCaseId: new Map(result.providerCases.map((plannedCase) => [
        plannedCase.caseId,
        itemsForCase(plannedCase, itemsByRawFindingId),
      ])),
      provisionalOnlyRawFindingIds: new Set(provisionalOnlyRawFindingIds),
    },
  ]);
}

function liveBeginForReceipt(
  store: LedgerRepository,
  receipt: InterpretationBatchReceipt,
): LiveBeginEntry {
  const entry = (liveBeginsByStore.get(store) ?? []).find(
    (candidate) => candidate.result.receipt.batchId === receipt.batchId,
  );
  if (entry === undefined) {
    throw new Error(`Interpretation batch receipt "${receipt.batchId}" has no live context for this store or is late`);
  }
  if (canonicalJson(entry.result.receipt) !== canonicalJson(receipt)) {
    throw new Error(`Interpretation batch receipt "${receipt.batchId}" does not match its live context`);
  }
  return entry;
}

function releaseCompletedLiveBegins(
  store: LedgerRepository,
  attemptIds: ReadonlySet<string>,
): void {
  const remaining = (liveBeginsByStore.get(store) ?? []).filter((entry) => (
    entry.result.attempts.every((attempt) => !attemptIds.has(attempt.attemptId))
  ));
  if (remaining.length === 0) {
    liveBeginsByStore.delete(store);
  } else {
    liveBeginsByStore.set(store, remaining);
  }
}

function receiptFor(attempts: readonly InterpretationAttempt[]): InterpretationBatchReceipt {
  const fences: InterpretationAttemptFence[] = attempts
    .map((attempt) => ({
      attemptId: attempt.attemptId,
      caseId: attempt.caseId,
      semanticProjectionDigest: attempt.semanticProjectionDigest,
      rawFindingIds: [...attempt.rawFindingIds],
    }))
    .sort((left, right) => compareBinaryStrings(left.attemptId, right.attemptId));
  return {
    batchId: computeInterpretationBatchId(fences),
    fences,
  };
}

function cohortIdForCase(plannedCase: InterpretationCase): string {
  return computeInterpretationCohortId(
    plannedCase.caseId,
    plannedCase.semanticProjectionDigest,
    plannedCase.members.map((member) => member.rawFindingId),
  );
}

function unreservedAuthority(input: {
  roundIdentity: string;
  reason: import('../../models/finding-contract-types.js').InterpretationUnreservedLandingAuthority['reason'];
  items: readonly CanonicalIntakeItem[];
  observation: FindingObservation;
}): import('../../models/finding-contract-types.js').InterpretationUnreservedLandingAuthority {
  return {
    kind: 'interpretation_unreserved_landing',
    roundIdentity: input.roundIdentity,
    budgetScopeId: computeFindingManagerBudgetScopeId(input.roundIdentity),
    reason: input.reason,
    rawFindingIds: input.items.map((item) => item.canonical.rawFindingId)
      .sort(compareBinaryStrings),
    rawCanonicalSnapshotIds: input.items.map((item) => createRawCanonicalSnapshot({
      item,
      capturedAt: input.observation,
    }).rawCanonicalSnapshotId).sort(compareBinaryStrings),
  };
}

type ExistingCohortState =
  | { kind: 'attempt'; attempt: InterpretationAttempt }
  | { kind: 'terminal' };

function existingCohortState(
  ledger: FindingLedger,
  plannedCase: InterpretationCase,
): ExistingCohortState | null {
  const cohortId = cohortIdForCase(plannedCase);
  const rawFindingIds = plannedCase.members.map((member) => member.rawFindingId);
  const observed = rawFindingIds.filter((rawFindingId) => (
    ledger.interpretationRawObservations.some(
      (observation) => observation.rawFindingId === rawFindingId,
    )
  ));
  if (observed.length === 0) {
    return null;
  }
  if (observed.length !== rawFindingIds.length) {
    throw new Error(`Interpretation cohort "${cohortId}" is only partially observed`);
  }
  const outcomes = rawFindingIds.map((rawFindingId) => {
    const outcome = ledger.rawInterpretationOutcomes.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    );
    if (outcome === undefined) {
      throw new Error(`Interpretation observation for "${rawFindingId}" has no outcome`);
    }
    return outcome;
  });
  const pendingAttemptIds = [...new Set(outcomes.flatMap((outcome) => (
    outcome.kind === 'pending_attempt' ? [outcome.attemptId] : []
  )))];
  if (pendingAttemptIds.length === 0) {
    return { kind: 'terminal' };
  }
  if (pendingAttemptIds.length !== 1 || outcomes.some((outcome) => outcome.kind !== 'pending_attempt')) {
    throw new Error(`Interpretation cohort "${cohortId}" has mixed ownership`);
  }
  const attempt = latestInterpretationAttempt(ledger, plannedCase.caseId, cohortId);
  if (attempt === undefined) {
    throw new Error(`Interpretation cohort "${cohortId}" references a missing attempt`);
  }
  if (
    attempt.caseId !== plannedCase.caseId
    || attempt.cohortId !== cohortId
    || attempt.lineageKey !== plannedCase.lineageKey
    || attempt.semanticProjectionDigest !== plannedCase.semanticProjectionDigest
    || canonicalJson(attempt.rawFindingIds) !== canonicalJson(
      [...rawFindingIds].sort(compareBinaryStrings),
    )
  ) {
    throw new Error(`Interpretation cohort "${cohortId}" has incompatible attempt ownership`);
  }
  return { kind: 'attempt', attempt };
}

function planInterpretationBatch(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  observation: FindingObservation;
  maxEpochsPerLineage: number;
  roundIdentity: string;
  scopeIdentity: string;
  roundMarker: string;
  budgetLimits: FindingManagerProviderBudgetLimits;
  maxCasesPerProviderCall: number;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
  prepareProviderRequest: (
    ledger: FindingLedger,
    cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[],
  ) => PreparedInterpretationProviderRequest;
}): { ledger: FindingLedger; result: BeginInterpretationCasesResult } {
  const cases = createInterpretationCases({
    items: input.items,
    ledger: input.ledger,
    provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
  }).sort((left, right) => compareBinaryStrings(left.caseId, right.caseId));
  const itemsByRawFindingId = new Map(
    input.items.map((item) => [item.canonical.rawFindingId, item]),
  );
  assertCompatibleObservations(input.ledger, cases, itemsByRawFindingId);
  const proofFastPathPlans: InterpretationCaseProofFastPathPlan[] = [];
  const directPlans: InterpretationCaseDirectPlan[] = [];
  const providerCases: Array<Extract<InterpretationCase, { kind: 'provider_case' }>> = [];
  const attempts: InterpretationAttempt[] = [];
  const completedAttemptIdsForCommit: string[] = [];
  let ledger = input.ledger;
  const initialRawFindingIds = new Set(input.ledger.rawFindings.map(
    ({ rawFindingId }) => rawFindingId,
  ));
  const initialSnapshotIds = new Set(input.ledger.rawCanonicalSnapshots.map(
    ({ rawCanonicalSnapshotId }) => rawCanonicalSnapshotId,
  ));
  const initialCaseSnapshotIds = new Set(input.ledger.interpretationCaseSnapshots.map(
    ({ caseSnapshotId }) => caseSnapshotId,
  ));
  const initialObservationDigests = new Set(input.ledger.interpretationRawObservations.map(
    ({ observationDigest }) => observationDigest,
  ));
  const initialOriginBindingIds = new Set(input.ledger.interpretationRecoveryOriginBindings.map(
    ({ bindingId }) => bindingId,
  ));

  for (const plannedCase of cases) {
    const caseItems = itemsForCase(plannedCase, itemsByRawFindingId);
    const existing = existingCohortState(ledger, plannedCase);
    if (existing?.kind === 'terminal') {
      continue;
    }
    if (existing?.kind === 'attempt') {
      if (existing.attempt.stage === 'completed') {
        completedAttemptIdsForCommit.push(existing.attempt.attemptId);
        continue;
      }
      if (existing.attempt.stage === 'applied') {
        continue;
      }
      if (plannedCase.kind !== 'provider_case') {
        throw new Error(`Interpretation cohort "${existing.attempt.cohortId}" has invalid persisted ownership`);
      }
      if (existing.attempt.stage === 'started') {
        const call = ledger.findingManagerProviderCalls.find(
          (candidate) => candidate.providerCallId === existing.attempt.providerCallId,
        );
        if (call?.state === 'reserved') {
          providerCases.push(plannedCase);
          attempts.push(existing.attempt);
          continue;
        }
        if (call?.state !== 'dispatched') {
          throw new Error(
            `Started interpretation attempt "${existing.attempt.attemptId}" has no live provider call`,
          );
        }
        const settled = settleFindingManagerProviderCall({
          calls: ledger.findingManagerProviderCalls,
          providerCallId: call.providerCallId,
          settledAt: input.observation,
          resultKind: 'interrupted_unknown',
          failurePhase: 'provider_result_unknown',
        });
        ledger = {
          ...ledger,
          findingManagerProviderCalls: settled.calls,
          interpretationAttempts: ledger.interpretationAttempts.map((attempt) => (
            attempt.attemptId === existing.attempt.attemptId
              ? {
                  ...existing.attempt,
                  stage: 'interrupted' as const,
                  interruptedAt: structuredClone(input.observation),
                  reason: 'provider_result_unknown' as const,
                }
            : attempt
          )),
        };
        const interrupted = ledger.interpretationAttempts.find(
          (attempt) => attempt.attemptId === existing.attempt.attemptId,
        );
        if (interrupted?.stage !== 'interrupted') {
          throw new Error(`Interpretation attempt "${existing.attempt.attemptId}" was not interrupted`);
        }
        if (interrupted.retryOrdinal >= MAX_INTERPRETATION_RETRY_ORDINAL) {
          const authority = unreservedAuthority({
            roundIdentity: input.roundIdentity,
            reason: 'interpretation-interrupted',
            items: caseItems,
            observation: input.observation,
          });
          ledger = applyInterruptedInterpretationLanding({
            ledger,
            plannedCase,
            items: caseItems,
            interruptedAttempt: interrupted,
            authority,
            verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
            reason: 'Interpretation provider result remained unknown after the bounded retry',
            observation: input.observation,
          });
          continue;
        }
        const appended = appendStartedInterpretationAttempt({
          ledger,
          plannedCase,
          items: caseItems,
          observation: input.observation,
          roundIdentity: input.roundIdentity,
          cohortId: cohortIdForCase(plannedCase),
        });
        ledger = appended.ledger;
        providerCases.push(plannedCase);
        attempts.push(appended.attempt);
        continue;
      }
      if (existing.attempt.retryOrdinal >= MAX_INTERPRETATION_RETRY_ORDINAL) {
        const authority = unreservedAuthority({
          roundIdentity: input.roundIdentity,
          reason: 'interpretation-interrupted',
          items: caseItems,
          observation: input.observation,
        });
        ledger = applyInterruptedInterpretationLanding({
          ledger,
          plannedCase,
          items: caseItems,
          interruptedAttempt: existing.attempt,
          authority,
          verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
          reason: 'Interpretation retry limit was exhausted',
          observation: input.observation,
        });
        continue;
      }
      const appended = appendStartedInterpretationAttempt({
        ledger,
        plannedCase,
        items: caseItems,
        observation: input.observation,
        roundIdentity: input.roundIdentity,
        cohortId: cohortIdForCase(plannedCase),
      });
      ledger = appended.ledger;
      providerCases.push(plannedCase);
      attempts.push(appended.attempt);
      continue;
    }
    const proof = selectInterpretationCaseProofFastPath({ plannedCase, ledger });
    if (proof !== null) {
      proofFastPathPlans.push({
        ...proof,
        items: caseItems,
        plannedCase,
        roundIdentity: input.roundIdentity,
      });
      continue;
    }
    if (plannedCase.kind === 'case_provisional') {
      directPlans.push({
        plannedCase,
        items: caseItems,
        decision: { kind: 'provisional', reason: plannedCase.reason },
        roundIdentity: input.roundIdentity,
      });
      continue;
    }
    if (
      nextInterpretationAttemptOrdinal(ledger, plannedCase.lineageKey)
      > input.maxEpochsPerLineage
    ) {
      directPlans.push({
        plannedCase,
        items: caseItems,
        decision: {
          kind: 'provisional',
          reason: 'Interpretation semantic epoch budget is exhausted for this lineage',
        },
        roundIdentity: input.roundIdentity,
      });
      continue;
    }
    const appended = appendStartedInterpretationAttempt({
      ledger,
      plannedCase,
      items: caseItems,
      observation: input.observation,
      roundIdentity: input.roundIdentity,
      cohortId: cohortIdForCase(plannedCase),
    });
    ledger = appended.ledger;
    providerCases.push(plannedCase);
    attempts.push(appended.attempt);
  }

  const attemptByCaseId = new Map(attempts.map((attempt) => [attempt.caseId, attempt]));
  let providerCalls = ledger.findingManagerProviderCalls;
  let budgetScopes = ledger.findingManagerProviderBudgetScopes;
  const unleasedProviderCases = providerCases.filter((plannedCase) => (
    attemptByCaseId.get(plannedCase.caseId)?.providerCallId === ''
  ));
  const discardUnreservedCases = (caseIds: ReadonlySet<string>): void => {
    const unreservedAttempts = attempts.filter((attempt) => caseIds.has(attempt.caseId));
    const unreservedAttemptIds = new Set(unreservedAttempts.map(({ attemptId }) => attemptId));
    const unreservedRawFindingIds = new Set(unreservedAttempts.flatMap(
      ({ rawFindingIds }) => rawFindingIds,
    ));
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (caseIds.has(attempts[index]!.caseId)) {
        attempts.splice(index, 1);
      }
    }
    for (let index = providerCases.length - 1; index >= 0; index -= 1) {
      if (caseIds.has(providerCases[index]!.caseId)) {
        providerCases.splice(index, 1);
      }
    }
    ledger = {
      ...ledger,
      rawFindings: ledger.rawFindings.filter((raw) => (
        initialRawFindingIds.has(raw.rawFindingId)
        || !unreservedRawFindingIds.has(raw.rawFindingId)
      )),
      interpretationCaseSnapshots: ledger.interpretationCaseSnapshots.filter((snapshot) => (
        initialCaseSnapshotIds.has(snapshot.caseSnapshotId)
        || !caseIds.has(snapshot.caseId)
      )),
      interpretationAttempts: ledger.interpretationAttempts.filter(
        (attempt) => !unreservedAttemptIds.has(attempt.attemptId),
      ),
      interpretationRawObservations: ledger.interpretationRawObservations.filter((observation) => (
        initialObservationDigests.has(observation.observationDigest)
          || !unreservedRawFindingIds.has(observation.rawFindingId)
      )),
      interpretationRecoveryOriginBindings: ledger.interpretationRecoveryOriginBindings.filter((binding) => (
        initialOriginBindingIds.has(binding.bindingId)
          || !caseIds.has(binding.caseId)
      )),
      rawInterpretationOutcomes: ledger.rawInterpretationOutcomes.filter((outcome) => (
        outcome.kind !== 'pending_attempt' || !unreservedAttemptIds.has(outcome.attemptId)
      )),
      rawCanonicalSnapshots: ledger.rawCanonicalSnapshots.filter((snapshot) => (
        initialSnapshotIds.has(snapshot.rawCanonicalSnapshotId)
          || !unreservedRawFindingIds.has(snapshot.rawFindingId)
      )),
    };
  };

  const handleUnreservedCase = (plannedCase: Extract<InterpretationCase, { kind: 'provider_case' }>, reason: 'manager-input-overflow' | 'manager-budget-exhausted'): void => {
    const caseItems = itemsForCase(plannedCase, itemsByRawFindingId);
    const unreservedAttempt = attempts.find((attempt) => attempt.caseId === plannedCase.caseId);
    const prior = ledger.interpretationAttempts
      .filter((attempt) => (
        attempt.caseId === plannedCase.caseId
        && attempt.attemptId !== unreservedAttempt?.attemptId
      ))
      .sort((left, right) => left.retryOrdinal - right.retryOrdinal)
      .at(-1);
    if (unreservedAttempt !== undefined && prior?.stage === 'interrupted') {
      ledger = {
        ...ledger,
        interpretationAttempts: ledger.interpretationAttempts.filter(
          (attempt) => attempt.attemptId !== unreservedAttempt.attemptId,
        ),
        rawInterpretationOutcomes: ledger.rawInterpretationOutcomes.map((outcome) => (
          outcome.kind === 'pending_attempt'
          && outcome.attemptId === unreservedAttempt.attemptId
            ? { ...outcome, attemptId: prior.attemptId }
            : outcome
        )),
      };
      const authority = unreservedAuthority({
        roundIdentity: input.roundIdentity,
        reason,
        items: caseItems,
        observation: input.observation,
      });
      ledger = applyInterruptedInterpretationLanding({
        ledger,
        plannedCase,
        items: caseItems,
        interruptedAttempt: prior,
        authority,
        verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
        reason: reason === 'manager-input-overflow'
          ? 'Interpretation request exceeded the provider byte ceiling'
          : 'Interpretation manager provider budget is exhausted',
        observation: input.observation,
      });
      return;
    }
    directPlans.push({
      plannedCase,
      items: caseItems,
      decision: {
        kind: 'provisional',
        reason: reason === 'manager-input-overflow'
          ? 'Input exceeded the manager provider byte ceiling for the interpretation request'
          : 'Interpretation manager provider budget is exhausted',
      },
      roundIdentity: input.roundIdentity,
      unreservedAuthority: unreservedAuthority({
        roundIdentity: input.roundIdentity,
        reason,
        items: caseItems,
        observation: input.observation,
      }),
    });
  };

  let cursor = 0;
  while (cursor < unleasedProviderCases.length) {
    const maxBatchLength = Math.min(
      input.maxCasesPerProviderCall,
      unleasedProviderCases.length - cursor,
    );
    let lower = 1;
    let upper = maxBatchLength;
    let batch: typeof unleasedProviderCases = [];
    let prepared: PreparedInterpretationProviderRequest | undefined;
    while (lower <= upper) {
      const candidateLength = Math.floor((lower + upper) / 2);
      const candidateBatch = unleasedProviderCases.slice(
        cursor,
        cursor + candidateLength,
      );
      const candidatePrepared = input.prepareProviderRequest(ledger, candidateBatch);
      if (
        Buffer.byteLength(candidatePrepared.requestBytes, 'utf8')
        <= input.budgetLimits.maxAdapterVisibleInputBytesPerCall
      ) {
        batch = candidateBatch;
        prepared = candidatePrepared;
        lower = candidateLength + 1;
      } else {
        upper = candidateLength - 1;
      }
    }
    if (prepared === undefined) {
      batch = unleasedProviderCases.slice(cursor, cursor + 1);
      prepared = input.prepareProviderRequest(ledger, batch);
    }
    const batchAttempts = batch.map((plannedCase) => {
      const attempt = attemptByCaseId.get(plannedCase.caseId);
      if (attempt === undefined) {
        throw new Error(`Interpretation case "${plannedCase.caseId}" has no started attempt`);
      }
      return attempt;
    });
    let reserved: ReturnType<typeof reserveFindingManagerProviderCall>;
    try {
      reserved = reserveFindingManagerProviderCall({
      scopes: budgetScopes,
      calls: providerCalls,
      scopeIdentity: input.scopeIdentity,
      workflowName: ledger.workflowName,
      roundMarker: input.roundMarker,
      limits: input.budgetLimits,
      purpose: 'interpretation',
      ownerAttemptKind: 'interpretation',
      attemptIds: batchAttempts.map((attempt) => attempt.attemptId),
      requestBytes: prepared.requestBytes,
      ...(prepared.exactTokenCount === undefined
        ? {}
        : { exactTokenCount: prepared.exactTokenCount }),
      adapterSupportsUtf8ByteUpperBound: prepared.adapterSupportsUtf8ByteUpperBound,
      reservedAt: input.observation,
      });
    } catch (error) {
      if (!(error instanceof FindingManagerProviderBudgetExhaustedError)) {
        throw error;
      }
      const reason = error.reason === 'adapter_visible_input_ceiling'
        ? 'manager-input-overflow' as const
        : 'manager-budget-exhausted' as const;
      const unreservedCases = error.reason === 'adapter_visible_input_ceiling'
        ? [batch[0]!]
        : unleasedProviderCases.slice(cursor);
      const unreservedCaseIds = new Set(unreservedCases.map(({ caseId }) => caseId));
      for (const plannedCase of unreservedCases) {
        handleUnreservedCase(plannedCase, reason);
      }
      discardUnreservedCases(unreservedCaseIds);
      if (error.reason === 'adapter_visible_input_ceiling') {
        cursor += 1;
        continue;
      }
      break;
    }
    budgetScopes = reserved.scopes;
    providerCalls = reserved.calls;
    for (const attempt of batchAttempts) {
      attemptByCaseId.set(attempt.caseId, {
        ...attempt,
        providerCallId: reserved.call.providerCallId,
      });
    }
    cursor += batch.length;
  }
  const leasedAttempts = attempts.map((attempt) => attemptByCaseId.get(attempt.caseId)!);
  const leasedAttemptsById = new Map(
    leasedAttempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  ledger = {
    ...ledger,
    interpretationAttempts: ledger.interpretationAttempts.map(
      (attempt) => leasedAttemptsById.get(attempt.attemptId) ?? attempt,
    ),
    findingManagerProviderBudgetScopes: budgetScopes,
    findingManagerProviderCalls: providerCalls,
  };

  return {
    ledger,
    result: {
      providerCases,
      attempts: leasedAttempts,
      completedAttemptIdsForCommit: completedAttemptIdsForCommit.sort(compareBinaryStrings),
      proofFastPathPlans,
      directPlans,
      receipt: receiptFor(attempts),
    },
  };
}

export async function beginInterpretationCases(input: {
  store: LedgerRepository;
  items: readonly CanonicalIntakeItem[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  observation: FindingObservation;
  maxEpochsPerLineage: number;
  roundMarker: string;
  scopeIdentity: string;
  budgetLimits: FindingManagerProviderBudgetLimits;
  maxCasesPerProviderCall: number;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
  prepareProviderRequest: (
    ledger: FindingLedger,
    cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[],
  ) => PreparedInterpretationProviderRequest;
}): Promise<BeginInterpretationCasesResult> {
  if (!Number.isInteger(input.maxEpochsPerLineage) || input.maxEpochsPerLineage <= 0) {
    throw new Error('Interpretation epoch budget must be a positive integer');
  }
  if (!Number.isSafeInteger(input.maxCasesPerProviderCall) || input.maxCasesPerProviderCall <= 0) {
    throw new Error('Interpretation provider batch size must be a positive safe integer');
  }
  const roundIdentity = computeFindingManagerRoundIdentity({
    scopeIdentity: input.scopeIdentity,
    workflowName: input.store.workflowName,
    roundMarker: input.roundMarker,
  });
  const inputKey = beginInputKey(input.items, input.provisionalOnlyRawFindingIds);
  const loaded = input.store.loadLedger();
  assertCompatibleRawFindings(loaded, input.items);
  const live = activeLiveBegin(input.store, inputKey, loaded);
  if (live !== undefined) {
    return live;
  }

  const initialPlan = planInterpretationBatch({
    ledger: loaded,
    items: input.items,
    provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
    observation: input.observation,
    maxEpochsPerLineage: input.maxEpochsPerLineage,
    roundIdentity,
    scopeIdentity: input.scopeIdentity,
    roundMarker: input.roundMarker,
    budgetLimits: input.budgetLimits,
    maxCasesPerProviderCall: input.maxCasesPerProviderCall,
    verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
    prepareProviderRequest: input.prepareProviderRequest,
  });
  if (
    initialPlan.result.attempts.length === 0
    && canonicalJson(initialPlan.ledger) === canonicalJson(loaded)
  ) {
    return initialPlan.result;
  }

  const mutation = await input.store.updateLedger((ledger) => {
    assertCompatibleRawFindings(ledger, input.items);
    const freshPlan = planInterpretationBatch({
      ledger,
      items: input.items,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
      observation: input.observation,
      maxEpochsPerLineage: input.maxEpochsPerLineage,
      roundIdentity,
      scopeIdentity: input.scopeIdentity,
      roundMarker: input.roundMarker,
      budgetLimits: input.budgetLimits,
      maxCasesPerProviderCall: input.maxCasesPerProviderCall,
      verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
      prepareProviderRequest: input.prepareProviderRequest,
    });
    return { ledger: freshPlan.ledger, result: freshPlan.result };
  });
  if (mutation.result.attempts.length > 0) {
    rememberLiveBegin(
      input.store,
      inputKey,
      mutation.result,
      input.items,
      input.provisionalOnlyRawFindingIds,
    );
  }
  return mutation.result;
}

function assertUniqueCompletionInputs(input: {
  responses: readonly { caseId: string; decision: InterpretationDecision }[];
  providerFailures: readonly { caseId: string; reason: string }[];
}): void {
  const responseCaseIds = input.responses.map((response) => response.caseId);
  const failureCaseIds = input.providerFailures.map((failure) => failure.caseId);
  if (
    new Set(responseCaseIds).size !== responseCaseIds.length
    || new Set(failureCaseIds).size !== failureCaseIds.length
    || responseCaseIds.some((caseId) => failureCaseIds.includes(caseId))
  ) {
    throw new Error('Interpretation completion contains duplicate or overlapping case results');
  }
}

function validateLiveProviderDecision(input: {
  live: LiveBeginEntry;
  attempt: InterpretationAttempt;
  decision: InterpretationDecision;
  ledger: FindingLedger;
}): InterpretationDecision {
  const plannedCase = input.live.providerCasesById.get(input.attempt.caseId);
  const items = input.live.itemsByCaseId.get(input.attempt.caseId);
  if (plannedCase === undefined || items === undefined) {
    throw new Error(`Interpretation attempt "${input.attempt.attemptId}" has no planned live case`);
  }
  const policyValidated = validateInterpretationCaseDecision({
    plannedCase,
    decision: input.decision,
    ledger: input.ledger,
  });
  if (policyValidated.kind === 'provisional') {
    return policyValidated;
  }
  const freshCase = createInterpretationCases({
    items,
    ledger: input.ledger,
    provisionalOnlyRawFindingIds: input.live.provisionalOnlyRawFindingIds,
  }).find((candidate) => candidate.caseId === plannedCase.caseId);
  if (
    freshCase === undefined
    || freshCase.kind !== 'provider_case'
    || freshCase.semanticProjectionDigest !== plannedCase.semanticProjectionDigest
  ) {
    return {
      kind: 'provisional',
      reason: 'Interpretation case semantics changed before provider completion',
    };
  }
  const freshValidated = validateInterpretationCaseDecision({
    plannedCase: freshCase,
    decision: policyValidated,
    ledger: input.ledger,
  });
  if (freshValidated.kind !== 'open_conflict') {
    return freshValidated;
  }
  const targetFindingId = freshValidated.targetFindingId;
  const preconditionsAreFresh = items.every((item) => (
    item.canonical.targetPrecondition?.targetFindingId === targetFindingId
    && findingMatchesMutationPrecondition(
      input.ledger,
      item.canonical.targetPrecondition,
    )
  ));
  return preconditionsAreFresh
    ? freshValidated
    : {
        kind: 'provisional',
        reason: 'Conflict target changed after interpretation planning',
      };
}

export async function completeInterpretationCases(input: {
  store: LedgerRepository;
  receipt: InterpretationBatchReceipt;
  responses: readonly { caseId: string; decision: InterpretationDecision }[];
  providerFailures: readonly { caseId: string; reason: string }[];
  providerCallResults: readonly {
    providerCallId: string;
    resultKind: 'accepted' | 'rejected' | 'interrupted_unknown';
    failurePhase?: 'provider_failed' | 'parse_failed' | 'provider_contract_rejected' | 'output_oversize' | 'provider_result_unknown';
    responseBytes?: string;
    providerUsage?: { inputTokens: number; outputTokens: number };
  }[];
  observation: FindingObservation;
}): Promise<{ attempts: InterpretationAttempt[] }> {
  const receipt = InterpretationBatchReceiptSchema.parse(input.receipt);
  const live = liveBeginForReceipt(input.store, receipt);
  assertUniqueCompletionInputs(input);
  const responses = new Map(input.responses.map((response) => [
    response.caseId,
    InterpretationDecisionSchema.parse(response.decision),
  ]));
  const failures = new Map(input.providerFailures.map((failure) => {
    if (failure.reason.trim().length === 0) {
      throw new Error(`Interpretation provider failure for "${failure.caseId}" has no reason`);
    }
    return [failure.caseId, failure.reason] as const;
  }));
  const ownedCaseIds = new Set(receipt.fences.map((fence) => fence.caseId));
  for (const caseId of [...responses.keys(), ...failures.keys()]) {
    if (!ownedCaseIds.has(caseId)) {
      throw new Error(`Interpretation case "${caseId}" is not owned by this batch receipt`);
    }
  }

  const mutation = await input.store.updateLedger((ledger) => {
    let providerCalls = ledger.findingManagerProviderCalls;
    for (const result of input.providerCallResults) {
      const settled = settleFindingManagerProviderCall({
        calls: providerCalls,
        providerCallId: result.providerCallId,
        settledAt: input.observation,
        resultKind: result.resultKind,
        ...(result.failurePhase === undefined ? {} : { failurePhase: result.failurePhase }),
        ...(result.responseBytes === undefined
          ? {}
          : { response: { bytes: result.responseBytes } }),
        ...(result.providerUsage === undefined
          ? {}
          : { providerUsage: result.providerUsage }),
      });
      providerCalls = settled.calls;
    }
    const completed: InterpretationAttempt[] = [];
    const interruptedAttemptIds = new Set(input.providerCallResults
      .filter((result) => result.resultKind === 'interrupted_unknown')
      .flatMap((result) => providerCalls.find(
        (call) => call.providerCallId === result.providerCallId,
      )?.attemptIds ?? []));
    const attemptsById = new Map(ledger.interpretationAttempts.map((attempt) => [
      attempt.attemptId,
      attempt,
    ]));
    for (const fence of receipt.fences) {
      const attempt = attemptsById.get(fence.attemptId);
      if (attempt === undefined) {
        throw new Error(`Interpretation batch receipt references unknown attempt "${fence.attemptId}"`);
      }
      if (attempt.stage !== 'started') {
        throw new Error(`Interpretation batch receipt is late because attempt "${fence.attemptId}" is already ${attempt.stage}`);
      }
      if (
        attempt.caseId !== fence.caseId
        || attempt.semanticProjectionDigest !== fence.semanticProjectionDigest
        || canonicalJson(attempt.rawFindingIds) !== canonicalJson(fence.rawFindingIds)
      ) {
        throw new Error(`Interpretation batch receipt fence for "${fence.attemptId}" does not match the current ledger`);
      }
    }
    const completedById = new Map<string, InterpretationAttempt>();
    for (const fence of receipt.fences) {
      const attempt = attemptsById.get(fence.attemptId)!;
      const response = responses.get(attempt.caseId);
      if (interruptedAttemptIds.has(attempt.attemptId)) {
        const next: InterpretationAttempt = {
          ...attempt,
          stage: 'interrupted',
          interruptedAt: { ...input.observation },
          reason: 'provider_result_unknown',
        };
        completedById.set(next.attemptId, next);
        continue;
      }
      const decision = response === undefined
        ? {
            kind: 'provisional' as const,
            reason: failures.get(attempt.caseId)
              ?? 'The interpretation provider omitted this case from its batch response.',
          }
        : validateLiveProviderDecision({
            live,
            attempt,
            decision: response,
            ledger,
          });
      const next: InterpretationAttempt = {
        ...attempt,
        stage: 'completed',
        completedAt: { ...input.observation },
        decision,
      };
      completed.push(next);
      completedById.set(next.attemptId, next);
    }
    return {
      ledger: {
        ...ledger,
        updatedAt: input.observation.timestamp,
        findingManagerProviderCalls: providerCalls,
        interpretationAttempts: ledger.interpretationAttempts.map(
          (attempt) => completedById.get(attempt.attemptId) ?? attempt,
        ),
      },
      result: { attempts: completed },
    };
  });
  releaseCompletedLiveBegins(
    input.store,
    new Set(receipt.fences.map((fence) => fence.attemptId)),
  );
  return mutation.result;
}
