import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { evaluateRawAdmission } from './manager-admission.js';
import type {
  RawAdjudicationFailure,
  RawAdjudicationRecoveryResult,
  RawAdjudicationReplayOrigin,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { revalidateManagerPlan } from './manager-commit-revalidation.js';
import {
  applyProvisionalSettlement,
  buildProvisionalSettlementLifecycleCommands,
  settleProvisionalsWithCleanEvidence,
} from './manager-provisional-settlement.js';
import { collectLandedRawIds } from './manager-utils.js';
import { reconcileFindingLedgerPlan } from './reconciler.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  RawFindingDisposition,
} from './types.js';
import { matchesProvisionalRecoveryOrigin } from './provisional-recovery-origin.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';

function filterReplayOutput(input: {
  output: FindingManagerOutput;
  eligibleRawIds: ReadonlySet<string>;
}): FindingManagerOutput {
  const retainEligibleEntries = <T extends { rawFindingIds: string[] }>(entries: readonly T[]): T[] => (
    entries.filter((entry) => (
      entry.rawFindingIds.length > 0
      && entry.rawFindingIds.every((rawFindingId) => input.eligibleRawIds.has(rawFindingId))
    ))
  );
  const matches = retainEligibleEntries(input.output.matches);
  const newFindings = retainEligibleEntries(input.output.newFindings);
  const resolvedFindings = retainEligibleEntries(input.output.resolvedFindings);
  const reopenedFindings = retainEligibleEntries(input.output.reopenedFindings);
  const conflicts = retainEligibleEntries(input.output.conflicts);
  const retainedRawFindingIds = new Set([
    ...matches.flatMap((entry) => entry.rawFindingIds),
    ...newFindings.flatMap((entry) => entry.rawFindingIds),
    ...resolvedFindings.flatMap((entry) => entry.rawFindingIds),
    ...reopenedFindings.flatMap((entry) => entry.rawFindingIds),
    ...conflicts.flatMap((entry) => entry.rawFindingIds),
  ]);
  return {
    ...input.output,
    anchorAdjudications: input.output.anchorAdjudications.filter((adjudication) => (
      retainedRawFindingIds.has(adjudication.rawFindingId)
    )),
    matches,
    newFindings,
    resolvedFindings,
    reopenedFindings,
    conflicts,
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

function collectFreshOrigins(input: {
  freshLedger: FindingLedger;
  origins: ReadonlyMap<string, RawAdjudicationReplayOrigin>;
  failures: ReadonlyMap<string, RawAdjudicationFailure>;
}): {
  origins: Map<string, RawAdjudicationReplayOrigin>;
  failures: Map<string, RawAdjudicationFailure>;
} {
  const origins = new Map<string, RawAdjudicationReplayOrigin>();
  const failures = new Map(input.failures);
  for (const [rawFindingId, origin] of input.origins) {
    const process = input.freshLedger.findings.find((finding) => finding.id === origin.provisionalFindingId);
    const currentHead = captureFindingLifecycleHead(
      input.freshLedger,
      'finding',
      origin.provisionalFindingId,
    );
    const isFresh = process !== undefined
      && matchesProvisionalRecoveryOrigin(process, origin.recoveryOrigin)
      && currentHead?.revision === origin.expectedHead.revision
      && currentHead.eventId === origin.expectedHead.eventId
      && currentHead.projectionDigest === origin.expectedHead.projectionDigest;
    if (isFresh) {
      origins.set(rawFindingId, origin);
      continue;
    }
    failures.set(rawFindingId, {
      kind: 'precondition_stale',
      outcome: 'stale',
      reason: `Replay origin "${origin.provisionalFindingId}" changed before commit`,
    });
  }
  return { origins, failures };
}

function collectEligibleOrigins(input: {
  freshOrigins: ReadonlyMap<string, RawAdjudicationReplayOrigin>;
  recovery: RawAdjudicationRecoveryResult;
  failures: ReadonlyMap<string, RawAdjudicationFailure>;
}): {
  origins: Map<string, RawAdjudicationReplayOrigin>;
  failures: Map<string, RawAdjudicationFailure>;
} {
  const itemByRawFindingId = new Map(
    input.recovery.intake.items.map((item) => [item.wire.rawFindingId, item]),
  );
  const origins = new Map<string, RawAdjudicationReplayOrigin>();
  const failures = new Map(input.failures);
  for (const [rawFindingId, origin] of input.freshOrigins) {
    const item = itemByRawFindingId.get(rawFindingId);
    if (item === undefined) {
      if (!failures.has(rawFindingId)) {
        failures.set(rawFindingId, {
          kind: 'unlanded',
          outcome: 'audit_only',
          reason: 'Replay origin has neither payload nor a typed preparation outcome',
        });
      }
      origins.set(rawFindingId, origin);
      continue;
    }
    if (item.canonical.reviewerStableKey
      !== origin.recoveryOrigin.expectedRecoveryReviewerStableKey) {
      failures.set(rawFindingId, {
        kind: 'reviewer_provenance_mismatch',
        outcome: 'stale',
        reason: 'Replay reviewer provenance no longer matches the reserved provisional origin',
      });
      continue;
    }
    origins.set(rawFindingId, origin);
  }
  return { origins, failures };
}

function dispositionForFailure(
  rawFindingId: string,
  failure: RawAdjudicationFailure,
): RawFindingDisposition {
  switch (failure.kind) {
    case 'source_missing':
    case 'reviewer_provenance_missing':
    case 'recovery_contract_mismatch':
    case 'admission_rejected':
    case 'input_budget_exceeded':
    case 'manager_output_rejected':
    case 'agent_failed':
    case 'provisional_landing':
    case 'unlanded':
      return { rawFindingId, outcome: failure.outcome, reason: failure.reason };
    case 'target_missing':
    case 'precondition_stale':
    case 'reviewer_provenance_mismatch':
      return { rawFindingId, outcome: failure.outcome, reason: failure.reason };
    case 'manager_unsupported':
      return { rawFindingId, outcome: failure.outcome, reason: failure.reason };
  }
}

export function applyRawAdjudicationRecovery(input: {
  freshLedger: FindingLedger;
  recovery: RawAdjudicationRecoveryResult;
  runInput: RunFindingManagerForStepInput;
  observation: FindingObservation;
  reviewScopeSnapshotId: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): {
  ledger: FindingLedger;
  managerDecisionLedger: FindingLedger;
  managerDecisionCommands: FindingLifecycleCommand[];
  settlementCommands: FindingLifecycleCommand[];
  rawFindingDispositions: RawFindingDisposition[];
} {
  if (input.recovery.origins.size === 0) {
    return {
      ledger: input.freshLedger,
      managerDecisionLedger: input.freshLedger,
      managerDecisionCommands: [],
      settlementCommands: [],
      rawFindingDispositions: [],
    };
  }
  const fresh = collectFreshOrigins({
    freshLedger: input.freshLedger,
    origins: input.recovery.origins,
    failures: input.recovery.failures,
  });
  const eligible = collectEligibleOrigins({
    freshOrigins: fresh.origins,
    recovery: input.recovery,
    failures: fresh.failures,
  });
  const origins = eligible.origins;
  const failures = eligible.failures;
  if (origins.size === 0) {
    return {
      ledger: input.freshLedger,
      managerDecisionLedger: input.freshLedger,
      managerDecisionCommands: [],
      settlementCommands: [],
      rawFindingDispositions: [...input.recovery.origins.keys()].map((rawFindingId) => {
        const failure = failures.get(rawFindingId);
        if (failure === undefined) {
          throw new Error(`Replay raw finding "${rawFindingId}" has no finite disposition`);
        }
        return dispositionForFailure(rawFindingId, failure);
      }),
    };
  }
  const eligibleRawIds = new Set(origins.keys());
  const eligibleIntake = {
    ...input.recovery.intake,
    items: input.recovery.intake.items.filter(
      (item) => eligibleRawIds.has(item.wire.rawFindingId),
    ),
  };
  const admission = evaluateRawAdmission({
    cwd: input.runInput.cwd,
    reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    runId: input.runInput.ledgerStore.runId,
    scopeIdentity: input.runInput.ledgerStore.ledgerIdentity,
    previousLedger: input.freshLedger,
    intake: eligibleIntake,
    reviewScopeSnapshot: input.reviewScopeSnapshot,
    workflowTask: input.runInput.workflowTask,
  });
  const admittedRawIds = new Set(admission.cleanWire.map((wire) => wire.rawFindingId));
  const adjudicableRawIds = new Set(
    [...origins.keys()].filter((rawFindingId) => (
      admittedRawIds.has(rawFindingId) && !failures.has(rawFindingId)
    )),
  );
  for (const rawFindingId of origins.keys()) {
    if (!admittedRawIds.has(rawFindingId) && !failures.has(rawFindingId)) {
      failures.set(rawFindingId, {
        kind: 'admission_rejected',
        outcome: 'audit_only',
        reason: 'replay source evidence did not pass admission at commit time',
      });
    }
  }
  const filteredOutput = filterReplayOutput({
    output: input.recovery.output,
    eligibleRawIds: adjudicableRawIds,
  });
  const freshWireById = new Map(
    admission.cleanAdmitted.map((item) => [item.wire.rawFindingId, item.wire]),
  );
  const freshCanonicalById = new Map(
    admission.cleanAdmitted.map((item) => [item.wire.rawFindingId, item.canonical]),
  );
  const revalidated = revalidateManagerPlan({
    managerOutput: filteredOutput,
    freshLedger: input.freshLedger,
    cleanWire: [...freshWireById.values()],
    cleanWireById: freshWireById,
    cleanCanonicalById: freshCanonicalById,
    capturedPreconditions: input.recovery.capturedPreconditions,
    capturedConflictHeads: new Map(),
    reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    runInput: { ...input.runInput, priorStepResponseText: undefined },
  });
  for (const spec of revalidated.provisionalSpecs) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      failures.set(rawFindingId, {
        kind: 'provisional_landing',
        outcome: 'audit_only',
        reason: spec.reason,
      });
    }
  }
  const settlement = settleProvisionalsWithCleanEvidence({
    output: revalidated.output,
    cleanRawIds: adjudicableRawIds,
    wireById: freshWireById,
    freshLedger: input.freshLedger,
    explicitResolvedByMapping: new Map(),
    explicitPromotedFindingIds: new Set(),
    healthyReviewerStableKeys: new Set(),
    replayOrigins: new Map(
      [...origins].filter(([rawFindingId]) => adjudicableRawIds.has(rawFindingId)),
    ),
  });
  for (const rawFindingId of origins.keys()) {
    if (!settlement.settledReplayRawIds.has(rawFindingId) && !failures.has(rawFindingId)) {
      failures.set(rawFindingId, {
        kind: 'unlanded',
        outcome: 'audit_only',
        reason: 'replay produced no substantive adjudication outcome',
      });
    }
  }
  const settledOutput = canonicalizeFindingManagerOutput(settlement.output);
  const replayItems = eligibleIntake.items.filter((item) => (
    failures.get(item.wire.rawFindingId)?.outcome !== 'stale'
  ));
  const replayWire = replayItems.map((item) => item.wire);
  const rawProvenance = new Map(replayItems.map((item) => [
    item.wire.rawFindingId,
    {
      reviewerStableKey: item.canonical.reviewerStableKey,
      lineageKey: item.canonical.lineageKey,
      claimIdentityHash: item.canonical.claimIdentityHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
      canonicalProvenance: item.canonical.provenance,
    },
  ]));
  const landedRawIds = collectLandedRawIds(settledOutput);
  const rawFindingDispositions = [...input.recovery.origins.keys()].flatMap((rawFindingId) => {
    if (landedRawIds.has(rawFindingId)) {
      return [];
    }
    const failure = failures.get(rawFindingId);
    if (failure !== undefined) {
      return [dispositionForFailure(rawFindingId, failure)];
    }
    if (settlement.settledReplayRawIds.has(rawFindingId)) {
      return [{
        rawFindingId,
        outcome: 'audit_only' as const,
        reason: 'The replay observation was applied through provisional settlement',
      }];
    }
    throw new Error(`Replay raw finding "${rawFindingId}" has no finite disposition`);
  });
  const replayRawFindingIds = new Set(replayWire.map((rawFinding) => rawFinding.rawFindingId));
  const reconciledPlan = reconcileFindingLedgerPlan({
    previousLedger: input.freshLedger,
    rawFindings: replayWire,
    managerOutput: settledOutput,
    provisionalFindings: [],
    rawProvenanceByRawFindingId: rawProvenance,
    rawFindingDispositions: rawFindingDispositions.filter(
      (disposition) => replayRawFindingIds.has(disposition.rawFindingId),
    ),
    verifiedEvidenceRecordsByRawFindingId: admission.verifiedEvidenceRecordsByRawFindingId,
    context: {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  });
  const appliedSettlement = applyProvisionalSettlement(
    reconciledPlan.ledger,
    settlement,
    input.runInput.timestamp,
  );
  return {
    ledger: appliedSettlement,
    managerDecisionLedger: reconciledPlan.ledger,
    managerDecisionCommands: reconciledPlan.lifecycleCommands,
    settlementCommands: buildProvisionalSettlementLifecycleCommands({
      after: appliedSettlement,
      settlement,
    }),
    rawFindingDispositions,
  };
}
