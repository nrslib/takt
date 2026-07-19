/**
 * ambiguous raw 解釈の write-ahead log。
 *
 * ambiguous raw への manager 解釈を冪等化する。処理順序:
 *
 * 1. `interpretation_started` を台帳へ保存（updateLedger）
 * 2. manager を呼ぶ（排他区間の外 — LLM 呼び出しを updateLedger の同期 mutator に
 *    入れてはならない）
 * 3. schema・capability 検証済み decision を `interpretation_completed` として保存
 * 4. 最新台帳を再読込し、前提条件を検証
 * 5. finding mutation と `ledger_applied` を同じ updateLedger 内で保存
 *
 * resume 規則:
 * - レコードなし → started を書いて manager 呼び出し
 * - `interpretation_started` のみ（前回 run の中断）→ manager を再呼び出さず
 *   `interpretation-interrupted` provisional
 * - `interpretation_completed` → 保存済み decision を再利用（再問い合わせしない）
 * - `ledger_applied` → no-op（記録済み結果を返す）
 */

import type {
  AmbiguousInterpretation,
  FindingInterpretationRecord,
  FindingLedger,
  FindingMutationPrecondition,
  FindingObservation,
  InterpretationApplicationResult,
} from './types.js';
import type { LedgerRepository } from './store.js';

export function findInterpretationRecord(
  ledger: FindingLedger,
  interpretationKey: string,
): FindingInterpretationRecord | undefined {
  return ledger.interpretations?.find((record) => record.interpretationKey === interpretationKey);
}

export interface NewInterpretationInput {
  interpretationKey: string;
  reviewerStableKey: string;
  lineageKey: string;
  candidateEvidenceHash: string;
  promptPreconditions: FindingMutationPrecondition[];
}

export interface BeginInterpretationsResult {
  /**
   * 既存レコードの状態別分類。呼び出し元はこの分類に従い、
   * - freshlyStarted: manager 呼び出しに進む
   * - interrupted: 再呼び出しせず interpretation-interrupted provisional
   * - completed: 保存済み decision を再利用
   * - applied: no-op
   */
  freshlyStartedKeys: Set<string>;
  interruptedKeys: Set<string>;
  completedByKey: Map<string, AmbiguousInterpretation>;
  appliedByKey: Map<string, InterpretationApplicationResult | undefined>;
}

/**
 * batch 対象の解釈レコードを分類し、未登録のものへ started を書き込む。
 * 全て1回の updateLedger（排他区間、同期 mutator）で行う。
 */
export async function beginInterpretations(
  store: LedgerRepository,
  inputs: readonly NewInterpretationInput[],
  observation: FindingObservation,
): Promise<BeginInterpretationsResult> {
  const mutation = await store.updateLedger((ledger) => {
    const result: BeginInterpretationsResult = {
      freshlyStartedKeys: new Set(),
      interruptedKeys: new Set(),
      completedByKey: new Map(),
      appliedByKey: new Map(),
    };
    const interpretations = [...(ledger.interpretations ?? [])];
    for (const input of inputs) {
      const existing = interpretations.find((record) => record.interpretationKey === input.interpretationKey);
      if (existing === undefined) {
        result.freshlyStartedKeys.add(input.interpretationKey);
        interpretations.push({
          interpretationKey: input.interpretationKey,
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
      // started のまま残っている = 前回 run が manager 呼び出し中に中断された。
      // 同じ run 内で started を書いたキーは freshlyStartedKeys に入るため、
      // ここへ来るのは resume（別 run）だけ。再呼び出しせず provisional へ。
      result.interruptedKeys.add(input.interpretationKey);
    }
    return { ledger: { ...ledger, interpretations }, result };
  });
  return mutation.result;
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
