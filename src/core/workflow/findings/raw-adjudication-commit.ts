import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { evaluateRawAdmission } from './manager-admission.js';
import type {
  RawAdjudicationRecoveryResult,
  RawAdjudicationReplayOrigin,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import { revalidateManagerPlan } from './manager-commit-revalidation.js';
import {
  applyProvisionalSettlement,
  settleProvisionalsWithCleanEvidence,
} from './manager-provisional-settlement.js';
import { collectLandedRawIds } from './manager-utils.js';
import { reconcileFindingLedger } from './reconciler.js';
import type { FindingLedger, FindingManagerOutput, FindingObservation } from './types.js';

function filterRawIds(
  rawFindingIds: readonly string[],
  eligibleRawIds: ReadonlySet<string>,
): string[] {
  return rawFindingIds.filter((rawFindingId) => eligibleRawIds.has(rawFindingId));
}

function filterReplayOutput(input: {
  output: FindingManagerOutput;
  eligibleRawIds: ReadonlySet<string>;
}): FindingManagerOutput {
  const newFindings = input.output.newFindings.flatMap((finding) => {
    const rawFindingIds = filterRawIds(finding.rawFindingIds, input.eligibleRawIds);
    return rawFindingIds.length === 0 ? [] : [{ ...finding, rawFindingIds }];
  });
  const filterLanding = <T extends { rawFindingIds: string[] }>(entries: readonly T[]): T[] => (
    entries.flatMap((entry) => {
      const rawFindingIds = filterRawIds(entry.rawFindingIds, input.eligibleRawIds);
      return rawFindingIds.length === 0 ? [] : [{ ...entry, rawFindingIds }];
    })
  );
  return {
    ...input.output,
    matches: filterLanding(input.output.matches),
    newFindings,
    resolvedFindings: filterLanding(input.output.resolvedFindings),
    reopenedFindings: filterLanding(input.output.reopenedFindings),
    conflicts: filterLanding(input.output.conflicts),
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

function collectEligibleOrigins(input: {
  freshLedger: FindingLedger;
  origins: ReadonlyMap<string, RawAdjudicationReplayOrigin>;
}): Map<string, RawAdjudicationReplayOrigin> {
  return new Map([...input.origins].filter(([, origin]) => {
    const process = input.freshLedger.findings.find((finding) => finding.id === origin.provisionalFindingId);
    return process?.status === 'open'
      && process.provisional !== undefined
      && (process.revision ?? 1) === origin.expectedProvisionalRevision;
  }));
}

function recordReplayFailures(input: {
  ledger: FindingLedger;
  origins: ReadonlyMap<string, RawAdjudicationReplayOrigin>;
  failureReasons: ReadonlyMap<string, string>;
  observation: FindingObservation;
}): FindingLedger {
  const failuresByProcess = new Map([...input.origins].flatMap(([replayRawFindingId, origin]) => {
    const reason = input.failureReasons.get(replayRawFindingId);
    return reason === undefined
      ? []
      : [[origin.provisionalFindingId, { origin, replayRawFindingId, reason }] as const];
  }));
  return {
    ...input.ledger,
    findings: input.ledger.findings.map((finding) => {
      const failure = failuresByProcess.get(finding.id);
      if (failure === undefined
        || finding.status !== 'open'
        || finding.provisional === undefined
        || (finding.revision ?? 1) !== failure.origin.expectedProvisionalRevision) {
        return finding;
      }
      const attempts = finding.provisional.adjudicationAttempts ?? [];
      return {
        ...finding,
        revision: (finding.revision ?? 1) + 1,
        provisional: {
          ...finding.provisional,
          adjudicationAttempts: [...attempts, {
            attempt: failure.origin.attempt,
            replayRawFindingId: failure.replayRawFindingId,
            reason: failure.reason,
            at: input.observation,
          }],
        },
      };
    }),
  };
}

export function applyRawAdjudicationRecovery(input: {
  freshLedger: FindingLedger;
  recovery: RawAdjudicationRecoveryResult;
  runInput: RunFindingManagerForStepInput;
  observation: FindingObservation;
}): FindingLedger {
  if (input.recovery.origins.size === 0) {
    return input.freshLedger;
  }
  const admission = evaluateRawAdmission({
    cwd: input.runInput.cwd,
    previousLedger: input.freshLedger,
    intake: input.recovery.intake,
  });
  const admittedRawIds = new Set(admission.cleanWire.map((wire) => wire.rawFindingId));
  const origins = collectEligibleOrigins({
    freshLedger: input.freshLedger,
    origins: input.recovery.origins,
  });
  const adjudicableRawIds = new Set(
    [...origins.keys()].filter((rawFindingId) => (
      admittedRawIds.has(rawFindingId) && !input.recovery.failureReasons.has(rawFindingId)
    )),
  );
  const failures = new Map(input.recovery.failureReasons);
  for (const rawFindingId of input.recovery.origins.keys()) {
    if (!admittedRawIds.has(rawFindingId) && !failures.has(rawFindingId)) {
      failures.set(rawFindingId, 'replay source evidence did not pass admission at commit time');
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
    runInput: { ...input.runInput, priorStepResponseText: undefined },
  });
  for (const spec of revalidated.provisionalSpecs) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      failures.set(rawFindingId, spec.reason);
    }
  }
  const settlement = settleProvisionalsWithCleanEvidence({
    output: revalidated.output,
    cleanRawIds: new Set(),
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
      failures.set(rawFindingId, 'replay produced no substantive adjudication outcome');
    }
  }
  const settledOutput = canonicalizeFindingManagerOutput(settlement.output);
  const replayWire = input.recovery.intake.items.map((item) => item.wire);
  const rawProvenance = new Map(input.recovery.intake.items.map((item) => [
    item.wire.rawFindingId,
    {
      reviewerStableKey: item.canonical.reviewerStableKey,
      lineageKey: item.canonical.lineageKey,
    },
  ]));
  const reconciled = reconcileFindingLedger({
    previousLedger: input.freshLedger,
    rawFindings: replayWire,
    managerOutput: settledOutput,
    rawProvenanceByRawFindingId: rawProvenance,
    excludedFromUnmentionedFallbackRawFindingIds: new Set(input.recovery.origins.keys()),
    context: {
      workflowName: input.runInput.workflowName,
      stepName: input.runInput.parentStep.name,
      runId: input.runInput.runId,
      timestamp: input.runInput.timestamp,
    },
  });
  const appliedSettlement = applyProvisionalSettlement(
    reconciled,
    settlement,
    input.runInput.timestamp,
  );
  const landedRawIds = collectLandedRawIds(settledOutput);
  for (const rawFindingId of origins.keys()) {
    if (!landedRawIds.has(rawFindingId) && !settlement.settledReplayRawIds.has(rawFindingId)) {
      failures.set(rawFindingId, 'replay outcome was not committed');
    }
  }
  return recordReplayFailures({
    ledger: appliedSettlement,
    origins,
    failureReasons: failures,
    observation: input.observation,
  });
}
