import { applyFindingConflictAdjudication, type FindingConflictAdjudicationDisposition } from './adjudication-apply.js';
import {
  buildAdjudicationEvidenceSnapshot,
  computeAdjudicationEvidenceHash,
} from './adjudication-evidence.js';
import type { FindingConflictAdjudicationOutput } from './types.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';
import { captureReviewScopeSnapshot } from './snapshot.js';

export type AdjudicationApplyOutcome =
  | {
    applied: false;
    reason: string;
    freshEvidenceHash?: string;
  }
  | {
    applied: true;
    disposition: FindingConflictAdjudicationDisposition;
  };

export async function commitFindingConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  conflictId: string;
  promptedEvidenceHash: string;
  output: FindingConflictAdjudicationOutput;
  cwd: string;
  workflowName: string;
  stepName: string;
  runId: string;
  timestamp: string;
}): Promise<FindingLedgerMutation<AdjudicationApplyOutcome>> {
  return input.ledgerStore.updateLedger<AdjudicationApplyOutcome>((fresh) => {
    const freshReviewScopeSnapshot = captureReviewScopeSnapshot(input.cwd);
    const freshConflict = fresh.conflicts.find((conflict) => conflict.id === input.conflictId);
    if (freshConflict === undefined || freshConflict.status !== 'active') {
      return {
        ledger: fresh,
        result: {
          applied: false as const,
          reason: `conflict "${input.conflictId}" is no longer active`,
        },
      };
    }
    const freshEvidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: fresh,
      conflictId: freshConflict.id,
      reviewScopeSnapshot: freshReviewScopeSnapshot,
    }));
    if (freshEvidenceHash !== input.promptedEvidenceHash) {
      return {
        ledger: fresh,
        result: {
          applied: false as const,
          reason: 'the conflict\'s evidence changed between the adjudication prompt and the apply step',
          freshEvidenceHash,
        },
      };
    }
    if ((freshConflict.adjudications ?? []).some((record) => record.evidenceHash === freshEvidenceHash)) {
      return {
        ledger: fresh,
        result: {
          applied: false as const,
          reason: `conflict "${input.conflictId}" was already adjudicated for the prompted evidence`,
          freshEvidenceHash,
        },
      };
    }
    const applied = applyFindingConflictAdjudication({
      ledger: fresh,
      output: input.output,
      evidenceHash: freshEvidenceHash,
      cwd: input.cwd,
      context: {
        workflowName: input.workflowName,
        stepName: input.stepName,
        runId: input.runId,
        timestamp: input.timestamp,
      },
    });
    return {
      ledger: applied.ledger,
      result: { applied: true as const, disposition: applied.disposition },
    };
  }, (fresh, prepared) => {
    if (!prepared.result.applied) {
      return { mutation: prepared, publish: true };
    }
    const conflict = fresh.conflicts.find((candidate) => candidate.id === input.conflictId);
    if (conflict === undefined || conflict.status !== 'active') {
      return {
        publish: false,
        mutation: {
          ledger: fresh,
          result: {
            applied: false as const,
            reason: `conflict "${input.conflictId}" is no longer active`,
          },
        },
      };
    }
    const reviewScopeSnapshot = captureReviewScopeSnapshot(input.cwd);
    const evidenceHash = computeAdjudicationEvidenceHash(buildAdjudicationEvidenceSnapshot({
      ledger: fresh,
      conflictId: conflict.id,
      reviewScopeSnapshot,
    }));
    if (evidenceHash === input.promptedEvidenceHash) {
      return { mutation: prepared, publish: true };
    }
    return {
      publish: false,
      mutation: {
        ledger: fresh,
        result: {
          applied: false as const,
          reason: 'the conflict\'s evidence changed while the adjudication decision was being applied',
          freshEvidenceHash: evidenceHash,
        },
      },
    };
  });
}
