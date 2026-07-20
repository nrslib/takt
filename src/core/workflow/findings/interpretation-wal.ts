/** attempt 固有キーにより、中断済み呼び出しの再利用を防ぎつつ completed decision の同一 attempt 内再利用を保つ。 */

import type {
  AmbiguousInterpretation,
  FindingInterpretationRecord,
  FindingLedger,
  FindingMutationPrecondition,
  FindingObservation,
  InterpretationApplicationResult,
} from './types.js';
import type { LedgerRepository } from './store.js';
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
  interpretationKey: string;
  baseInterpretationKey: string;
  attemptOrdinal: number;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
  promptPreconditions: FindingMutationPrecondition[];
}

export interface BeginInterpretationsResult {
  interruptedPriorKeys: Set<string>;
  completedByKey: Map<string, AmbiguousInterpretation>;
  appliedByKey: Map<string, InterpretationApplicationResult | undefined>;
}

export async function beginInterpretations(
  store: LedgerRepository,
  inputs: readonly NewInterpretationInput[],
  observation: FindingObservation,
): Promise<BeginInterpretationsResult> {
  const mutation = await store.updateLedger((ledger) => {
    const result: BeginInterpretationsResult = {
      interruptedPriorKeys: new Set(),
      completedByKey: new Map(),
      appliedByKey: new Map(),
    };
    const interpretations = [...(ledger.interpretations ?? [])];
    for (const input of inputs) {
      const existing = interpretations.find((record) => record.interpretationKey === input.interpretationKey);
      if (existing === undefined) {
        const interruptedPriorKeys = new Set(
          interpretations
            .filter((record) => (
              record.stage === 'interpretation_started'
              && baseKeyOf(record) === input.baseInterpretationKey
            ))
            .map((record) => record.interpretationKey),
        );
        for (const priorKey of interruptedPriorKeys) {
          result.interruptedPriorKeys.add(priorKey);
        }
        for (let index = 0; index < interpretations.length; index += 1) {
          const record = interpretations[index]!;
          if (!interruptedPriorKeys.has(record.interpretationKey)) {
            continue;
          }
          interpretations[index] = {
            ...record,
            stage: 'interpretation_interrupted',
            interruptedAt: observation,
          };
        }
        interpretations.push({
          interpretationKey: input.interpretationKey,
          baseInterpretationKey: input.baseInterpretationKey,
          attemptOrdinal: input.attemptOrdinal,
          reviewerStableKey: input.reviewerStableKey,
          lineageKey: input.lineageKey,
          candidateEvidenceHash: input.candidateEvidenceHash,
          policyVersion: 2,
          stage: 'interpretation_started',
          startedAt: observation,
          promptPreconditions: input.promptPreconditions,
        });
        continue;
      }
      if (existing.stage === 'ledger_applied') {
        result.appliedByKey.set(input.interpretationKey, existing.applicationResult);
        continue;
      }
      if (existing.stage === 'interpretation_completed' && existing.validatedDecision !== undefined) {
        result.completedByKey.set(input.interpretationKey, existing.validatedDecision);
        continue;
      }
      throw new Error(`Interpretation attempt "${input.interpretationKey}" cannot be resumed from stage "${existing.stage}"`);
    }
    return { ledger: { ...ledger, interpretations }, result };
  });
  return mutation.result;
}

function baseKeyOf(record: FindingInterpretationRecord): string {
  return record.baseInterpretationKey ?? computeBaseInterpretationKey({
    reviewerStableKey: record.reviewerStableKey,
    lineageKey: record.lineageKey,
    candidateEvidenceHash: record.candidateEvidenceHash,
  });
}

function resolveInterpretationAttemptWithPolicy(input: {
  ledger: FindingLedger;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
  reuseAppliedProvisional: boolean;
}): { baseInterpretationKey: string; interpretationKey: string; attemptOrdinal: number } {
  const baseInterpretationKey = computeBaseInterpretationKey(input);
  const records = (input.ledger.interpretations ?? [])
    .filter((record) => baseKeyOf(record) === baseInterpretationKey)
    .sort((left, right) => (left.attemptOrdinal ?? 1) - (right.attemptOrdinal ?? 1));
  const latest = records.at(-1);
  const latestOrdinal = latest?.attemptOrdinal ?? (latest === undefined ? 0 : 1);
  const advances = latest?.stage === 'interpretation_started'
    || latest?.stage === 'interpretation_interrupted'
    || (!input.reuseAppliedProvisional
      && latest?.stage === 'ledger_applied'
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

export function resolveInterpretationAttempt(input: {
  ledger: FindingLedger;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
}): { baseInterpretationKey: string; interpretationKey: string; attemptOrdinal: number } {
  return resolveInterpretationAttemptWithPolicy({ ...input, reuseAppliedProvisional: false });
}

export function resolveRecordedInterpretationAttempt(input: {
  ledger: FindingLedger;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
}): { baseInterpretationKey: string; interpretationKey: string; attemptOrdinal: number } {
  return resolveInterpretationAttemptWithPolicy({ ...input, reuseAppliedProvisional: true });
}

/** 検証済み decision を interpretation_completed として保存する。 */
export async function completeInterpretations(
  store: LedgerRepository,
  decisions: ReadonlyMap<string, AmbiguousInterpretation>,
  observation: FindingObservation,
): Promise<void> {
  if (decisions.size === 0) {
    return;
  }
  await store.updateLedger((ledger) => ({
    ledger: {
      ...ledger,
      interpretations: (ledger.interpretations ?? []).map((record) => {
        const decision = decisions.get(record.interpretationKey);
        if (decision === undefined || record.stage !== 'interpretation_started') {
          return record;
        }
        return {
          ...record,
          stage: 'interpretation_completed' as const,
          completedAt: observation,
          validatedDecision: decision,
        };
      }),
    },
    result: undefined,
  }));
}

/**
 * finding mutation と同じ updateLedger mutator の中で呼ぶ純関数:
 * 対象レコードを ledger_applied に進める。
 */
export function markInterpretationsApplied(
  ledger: FindingLedger,
  results: ReadonlyMap<string, InterpretationApplicationResult>,
  observation: FindingObservation,
): FindingLedger {
  if (results.size === 0) {
    return ledger;
  }
  return {
    ...ledger,
    interpretations: (ledger.interpretations ?? []).map((record) => {
      const applicationResult = results.get(record.interpretationKey);
      if (applicationResult === undefined || record.stage === 'ledger_applied') {
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
