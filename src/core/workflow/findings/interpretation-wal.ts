/** attempt 固有キーにより、中断済み呼び出しの再利用を防ぎつつ completed decision の同一 attempt 内再利用を保つ。 */

import { randomUUID } from 'node:crypto';
import type {
  AmbiguousInterpretation,
  FindingInterpretationRecord,
  FindingLedger,
  FindingMutationPrecondition,
  FindingObservation,
  InterpretationApplicationResult,
} from './types.js';
import type { FindingManagerStore } from './store.js';
import {
  computeBaseInterpretationKey,
  computeInterpretationAttemptKey,
} from './raw-canonicalization.js';

export function findInterpretationRecord(
  ledger: FindingLedger,
  interpretationKey: string,
): FindingInterpretationRecord | undefined {
  return ledger.interpretations?.find((record) => record.interpretationKey === interpretationKey);
}

export interface NewInterpretationInput {
  baseInterpretationKey: string;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
  promptPreconditions: FindingMutationPrecondition[];
}

export interface BeginInterpretationsResult {
  interruptedPriorKeys: Set<string>;
  completedByKey: Map<string, AmbiguousInterpretation>;
  appliedByKey: Map<string, InterpretationApplicationResult | undefined>;
  attemptByBaseKey: Map<string, {
    interpretationKey: string;
    attemptOrdinal: number;
  }>;
  deferredKeys: Set<string>;
  ownedByKey: Map<string, string>;
}

export async function beginInterpretations(
  store: FindingManagerStore,
  inputs: readonly NewInterpretationInput[],
  observation: FindingObservation,
): Promise<BeginInterpretationsResult> {
  const claimedTokens = new Set<string>();
  try {
    const mutation = await store.updateLedger((ledger) => {
      const result: BeginInterpretationsResult = {
        interruptedPriorKeys: new Set(),
        completedByKey: new Map(),
        appliedByKey: new Map(),
        attemptByBaseKey: new Map(),
        deferredKeys: new Set(),
        ownedByKey: new Map(),
      };
      const interpretations = [...(ledger.interpretations ?? [])];
      for (const input of inputs) {
        if (result.attemptByBaseKey.has(input.baseInterpretationKey)) {
          continue;
        }
        const records = recordsForBaseKey(interpretations, input.baseInterpretationKey);
        const latest = records.at(-1);
        if (latest?.stage === 'interpretation_started'
          && latest.reservationToken !== undefined
          && !store.claimAdjudicationReservation(latest.reservationToken)) {
          result.attemptByBaseKey.set(input.baseInterpretationKey, attemptIdentity(latest));
          result.deferredKeys.add(latest.interpretationKey);
          continue;
        }
        if (latest?.stage === 'interpretation_started' && latest.reservationToken !== undefined) {
          store.releaseAdjudicationReservation(latest.reservationToken);
        }
        if (latest?.stage === 'interpretation_completed') {
          if (latest.reservationToken === undefined || latest.validatedDecision === undefined) {
            throw new Error(`Completed interpretation attempt "${latest.interpretationKey}" is missing its reservation or decision`);
          }
          result.attemptByBaseKey.set(input.baseInterpretationKey, attemptIdentity(latest));
          if (!store.claimAdjudicationReservation(latest.reservationToken)) {
            result.deferredKeys.add(latest.interpretationKey);
            continue;
          }
          claimedTokens.add(latest.reservationToken);
          result.ownedByKey.set(latest.interpretationKey, latest.reservationToken);
          result.completedByKey.set(latest.interpretationKey, latest.validatedDecision);
          continue;
        }
        const attempt = resolveInterpretationAttempt({
          ledger: { ...ledger, interpretations },
          reviewerStableKey: input.reviewerStableKey,
          lineageKey: input.lineageKey,
          candidateEvidenceHash: input.candidateEvidenceHash,
        });
        result.attemptByBaseKey.set(input.baseInterpretationKey, attempt);
        const existing = interpretations.find((record) => record.interpretationKey === attempt.interpretationKey);
        if (existing?.stage === 'ledger_applied') {
          result.appliedByKey.set(attempt.interpretationKey, existing.applicationResult);
          continue;
        }
        if (existing !== undefined) {
          throw new Error(`Interpretation attempt "${attempt.interpretationKey}" cannot be resumed from stage "${existing.stage}"`);
        }
        const interruptedPriorKeys = new Set(records
          .filter((record) => record.stage === 'interpretation_started')
          .map((record) => record.interpretationKey));
        for (const priorKey of interruptedPriorKeys) {
          result.interruptedPriorKeys.add(priorKey);
        }
        for (let index = 0; index < interpretations.length; index += 1) {
          const record = interpretations[index]!;
          if (interruptedPriorKeys.has(record.interpretationKey)) {
            interpretations[index] = { ...record, stage: 'interpretation_interrupted', interruptedAt: observation };
          }
        }
        const reservationToken = randomUUID();
        if (!store.claimAdjudicationReservation(reservationToken)) {
          throw new Error(`New interpretation reservation token collision: "${reservationToken}"`);
        }
        claimedTokens.add(reservationToken);
        result.ownedByKey.set(attempt.interpretationKey, reservationToken);
        interpretations.push({
          interpretationKey: attempt.interpretationKey,
          baseInterpretationKey: input.baseInterpretationKey,
          attemptOrdinal: attempt.attemptOrdinal,
          reviewerStableKey: input.reviewerStableKey,
          lineageKey: input.lineageKey,
          candidateEvidenceHash: input.candidateEvidenceHash,
          policyVersion: 2,
          stage: 'interpretation_started',
          startedAt: observation,
          reservationToken,
          promptPreconditions: input.promptPreconditions,
        });
      }
      return { ledger: { ...ledger, interpretations }, result };
    });
    return mutation.result;
  } catch (error) {
    for (const token of claimedTokens) {
      store.releaseAdjudicationReservation(token);
    }
    throw error;
  }
}

function recordsForBaseKey(
  interpretations: readonly FindingInterpretationRecord[],
  baseInterpretationKey: string,
): FindingInterpretationRecord[] {
  return interpretations
    .filter((record) => baseKeyOf(record) === baseInterpretationKey)
    .sort((left, right) => (left.attemptOrdinal ?? 1) - (right.attemptOrdinal ?? 1));
}

function attemptIdentity(record: FindingInterpretationRecord): {
  interpretationKey: string;
  attemptOrdinal: number;
} {
  return {
    interpretationKey: record.interpretationKey,
    attemptOrdinal: record.attemptOrdinal ?? 1,
  };
}

function baseKeyOf(record: FindingInterpretationRecord): string {
  return record.baseInterpretationKey ?? computeBaseInterpretationKey({
    reviewerStableKey: record.reviewerStableKey,
    lineageKey: record.lineageKey,
    candidateEvidenceHash: record.candidateEvidenceHash,
  });
}

export function resolveInterpretationAttempt(input: {
  ledger: FindingLedger;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
}): { baseInterpretationKey: string; interpretationKey: string; attemptOrdinal: number } {
  const baseInterpretationKey = computeBaseInterpretationKey(input);
  const records = recordsForBaseKey(input.ledger.interpretations ?? [], baseInterpretationKey);
  const latest = records.at(-1);
  const latestOrdinal = latest?.attemptOrdinal ?? (latest === undefined ? 0 : 1);
  const advances = latest?.stage === 'interpretation_started'
    || latest?.stage === 'interpretation_interrupted'
    || (latest?.stage === 'ledger_applied'
      && (latest.applicationResult === 'provisional_created'
        || latest.applicationResult === 'provisional_updated'
        || latest.applicationResult === 'stale_precondition'));
  const attemptOrdinal = advances ? latestOrdinal + 1 : Math.max(1, latestOrdinal);
  return {
    baseInterpretationKey,
    interpretationKey: latest !== undefined && !advances
      ? latest.interpretationKey
      : computeInterpretationAttemptKey(baseInterpretationKey, attemptOrdinal),
    attemptOrdinal,
  };
}

/** 検証済み decision を interpretation_completed として保存する。 */
export async function completeInterpretations(
  store: FindingManagerStore,
  decisions: ReadonlyMap<string, AmbiguousInterpretation>,
  ownedByKey: ReadonlyMap<string, string>,
  observation: FindingObservation,
): Promise<Map<string, AmbiguousInterpretation>> {
  if (decisions.size === 0) {
    return new Map();
  }
  const mutation = await store.updateLedger((ledger) => {
    const completed = new Map<string, AmbiguousInterpretation>();
    const interpretations = (ledger.interpretations ?? []).map((record) => {
      const decision = decisions.get(record.interpretationKey);
      const reservationToken = ownedByKey.get(record.interpretationKey);
      if (decision === undefined
        || reservationToken === undefined
        || record.stage !== 'interpretation_started'
        || record.reservationToken !== reservationToken) {
        return record;
      }
      completed.set(record.interpretationKey, decision);
      return {
        ...record,
        stage: 'interpretation_completed' as const,
        completedAt: observation,
        validatedDecision: decision,
      };
    });
    return {
      ledger: {
        ...ledger,
        interpretations,
      },
      result: completed,
    };
  });
  return mutation.result;
}

export function releaseInterpretationReservations(
  store: FindingManagerStore,
  ownedByKey: ReadonlyMap<string, string>,
): void {
  for (const reservationToken of ownedByKey.values()) {
    store.releaseAdjudicationReservation(reservationToken);
  }
}

/**
 * finding mutation と同じ updateLedger mutator の中で呼ぶ純関数:
 * 対象レコードを ledger_applied に進める。
 */
export function markInterpretationsApplied(
  ledger: FindingLedger,
  results: ReadonlyMap<string, InterpretationApplicationResult>,
  ownedByKey: ReadonlyMap<string, string>,
  observation: FindingObservation,
): FindingLedger {
  if (results.size === 0) {
    return ledger;
  }
  return {
    ...ledger,
    interpretations: (ledger.interpretations ?? []).map((record) => {
      const applicationResult = results.get(record.interpretationKey);
      if (applicationResult === undefined
        || record.stage !== 'interpretation_completed'
        || record.reservationToken !== ownedByKey.get(record.interpretationKey)) {
        return record;
      }
      return {
        ...record,
        stage: 'ledger_applied' as const,
        appliedAt: observation,
        applicationResult,
      };
    }),
  };
}

/** lineage ごとの消費済み解釈 epoch 数（WAL レコード数で数える）。 */
export function countInterpretationEpochs(ledger: FindingLedger, lineageKey: string): number {
  return (ledger.interpretations ?? []).filter((record) => record.lineageKey === lineageKey).length;
}

/** interpretation epoch の正本は WAL だけである。 */
export function normalizeProvisionalInterpretationEpochs(ledger: FindingLedger): FindingLedger {
  const epochsByLineage = new Map<string, number>();
  for (const record of ledger.interpretations ?? []) {
    epochsByLineage.set(record.lineageKey, (epochsByLineage.get(record.lineageKey) ?? 0) + 1);
  }
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      if (finding.provisional === undefined) {
        return finding;
      }
      return {
        ...finding,
        provisional: {
          ...finding.provisional,
          interpretationEpochs: epochsByLineage.get(finding.provisional.lineageKey) ?? 0,
        },
      };
    }),
  };
}
