import { applyFindingConflictAdjudication, type FindingConflictAdjudicationDisposition } from './adjudication-apply.js';
import {
  buildAdjudicationEvidenceSnapshot,
  computeAdjudicationEvidenceHash,
} from './adjudication-evidence.js';
import type { FindingConflictAdjudicationOutput } from './types.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';
import { captureReviewScopeSnapshot } from './snapshot.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';
import {
  FindingLedgerConflictSchema,
  FindingLedgerEntrySchema,
} from '../../models/finding-schemas.js';

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
  reservationMutationId: string;
  output: FindingConflictAdjudicationOutput;
  cwd: string;
  workflowName: string;
  stepName: string;
  runId: string;
  timestamp: string;
  originStep?: string;
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
      ledger: applyFindingLifecycleCommands({
        ledger: fresh,
        commands: [{
          operation: 'apply_conflict_adjudication',
          changes: {
            findings: freshConflict.findingIds.flatMap((findingId) => {
              const before = fresh.findings.find((candidate) => candidate.id === findingId);
              const finding = FindingLedgerEntrySchema.parse(
                applied.ledger.findings.find((candidate) => candidate.id === findingId),
              );
              if (before !== undefined && finding.revision === before.revision) {
                return [];
              }
              const change: Partial<typeof finding> = { ...finding };
              delete change.revision;
              return [change as Omit<typeof finding, 'revision'>];
            }),
            conflicts: [(() => {
              const conflict = FindingLedgerConflictSchema.parse(
                applied.ledger.conflicts.find(
                  (candidate) => candidate.id === freshConflict.id,
                ),
              );
              const change: Partial<typeof conflict> = { ...conflict };
              delete change.revision;
              return change as Omit<typeof conflict, 'revision'>;
            })()],
          },
          authority: {
            kind: 'conflict_adjudication',
            conflictId: freshConflict.id,
            findingIds: [...freshConflict.findingIds],
            evidenceHash: freshEvidenceHash,
            originStep: input.originStep ?? null,
          },
          evidenceSourcesByTarget: new Map([[
            `conflict\0${freshConflict.id}`,
            {
              sourceRawFindingIds: freshConflict.rawFindingIds,
              authorityEvidenceIds: [],
            },
          ]]),
          reservedMutationId: input.reservationMutationId,
        }],
        occurredAt: {
          runId: input.runId,
          stepName: input.stepName,
          timestamp: input.timestamp,
        },
      }),
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
