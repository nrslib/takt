import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { findingContentAddress } from '../../models/finding-contract-identity.js';
import type {
  ConflictAdjudicationAttempt,
  ConflictAdjudicationProposal,
  FindingManagerCallFailurePhase,
} from '../../models/finding-contract-types.js';
import {
  applyResolvedConflictAdjudication,
  type FindingConflictAdjudicationDisposition,
} from './adjudication-apply.js';
import { resolveConflictAdjudicationPlan } from './conflict-adjudication-verifier.js';
import { settleFindingManagerProviderCall } from './finding-manager-provider-call.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';
import type { FindingObservation } from './types.js';

export type AdjudicationApplyOutcome =
  | { applied: false; reason: string }
  | { applied: true; disposition: FindingConflictAdjudicationDisposition };

function requiredStartedAttempt(
  attempts: readonly ConflictAdjudicationAttempt[],
  attemptId: string,
): Extract<ConflictAdjudicationAttempt, { stage: 'started' }> {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt?.stage !== 'started') {
    throw new Error(`Conflict adjudication attempt "${attemptId}" is not started`);
  }
  return attempt;
}

export async function commitFindingConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  attemptId: string;
  proposal: ConflictAdjudicationProposal;
  responseBytes: string;
  providerUsage?: { inputTokens: number; outputTokens: number };
  observation: FindingObservation;
}): Promise<FindingLedgerMutation<AdjudicationApplyOutcome>> {
  return input.ledgerStore.updateLedger<AdjudicationApplyOutcome>((fresh) => {
    const attempt = requiredStartedAttempt(fresh.conflictAdjudicationAttempts, input.attemptId);
    const settledCall = settleFindingManagerProviderCall({
      calls: fresh.findingManagerProviderCalls,
      providerCallId: attempt.providerCallId,
      settledAt: input.observation,
      resultKind: 'accepted',
      response: { bytes: input.responseBytes },
      ...(input.providerUsage === undefined ? {} : { providerUsage: input.providerUsage }),
    });
    const proposalDigest = findingContentAddress('conflict-adjudication-proposal', input.proposal);
    const proposedAttempt: Extract<ConflictAdjudicationAttempt, { stage: 'proposed' }> = {
      ...attempt,
      stage: 'proposed',
      completedAt: structuredClone(input.observation),
      proposal: structuredClone(input.proposal),
      proposalDigest,
    };
    let ledger = {
      ...fresh,
      updatedAt: input.observation.timestamp,
      findingManagerProviderCalls: settledCall.calls,
      conflictAdjudicationAttempts: fresh.conflictAdjudicationAttempts.map((candidate) => (
        candidate.attemptId === attempt.attemptId ? proposedAttempt : candidate
      )),
    };
    const snapshot = ledger.conflictAdjudicationSnapshots.find(
      (candidate) => candidate.conflictSnapshotId === attempt.conflictSnapshotId,
    );
    const actualHead = captureFindingLifecycleHead(ledger, 'conflict', attempt.conflictId);
    if (
      snapshot === undefined
      || canonicalJson(actualHead) !== canonicalJson(attempt.expectedConflictHead)
    ) {
      ledger = {
        ...ledger,
        conflictAdjudicationAttempts: ledger.conflictAdjudicationAttempts.map((candidate) => (
          candidate.attemptId === attempt.attemptId
            ? {
                ...proposedAttempt,
                stage: 'completed' as const,
                result: {
                  kind: 'stale_precondition' as const,
                  proposal: structuredClone(input.proposal),
                  proposalDigest,
                },
              }
            : candidate
        )),
      };
      return { ledger, result: { applied: false, reason: 'stale_precondition' } };
    }
    const plan = resolveConflictAdjudicationPlan({ ledger, snapshot, proposal: input.proposal });
    const applied = applyResolvedConflictAdjudication({
      ledger,
      attemptId: attempt.attemptId,
      plan,
      observation: input.observation,
    });
    return {
      ledger: applied.ledger,
      result: applied.applied
        ? { applied: true, disposition: applied.disposition }
        : { applied: false, reason: 'verification_undetermined' },
    };
  });
}

export async function completeFailedConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  attemptId: string;
  code: Exclude<FindingManagerCallFailurePhase, 'provider_result_unknown'>;
  responseBytes?: string;
  observation: FindingObservation;
}): Promise<void> {
  await input.ledgerStore.updateLedger((fresh) => {
    const attempt = requiredStartedAttempt(fresh.conflictAdjudicationAttempts, input.attemptId);
    const settled = settleFindingManagerProviderCall({
      calls: fresh.findingManagerProviderCalls,
      providerCallId: attempt.providerCallId,
      settledAt: input.observation,
      resultKind: 'rejected',
      failurePhase: input.code,
      ...(input.responseBytes === undefined ? {} : { response: { bytes: input.responseBytes } }),
    });
    const responseDigest = settled.call.state === 'settled'
      ? settled.call.responseDigest ?? null
      : null;
    return {
      ledger: {
        ...fresh,
        updatedAt: input.observation.timestamp,
        findingManagerProviderCalls: settled.calls,
        conflictAdjudicationAttempts: fresh.conflictAdjudicationAttempts.map((candidate) => (
          candidate.attemptId === attempt.attemptId
            ? {
                ...attempt,
                stage: 'completed' as const,
                completedAt: structuredClone(input.observation),
                result: {
                  kind: 'diagnostic_undetermined' as const,
                  code: input.code,
                  responseDigest,
                  diagnosticDigest: findingContentAddress('conflict-adjudication-diagnostic', {
                    attemptId: attempt.attemptId,
                    code: input.code,
                    responseDigest,
                  }),
                },
              }
            : candidate
        )),
      },
      result: undefined,
    };
  });
}
